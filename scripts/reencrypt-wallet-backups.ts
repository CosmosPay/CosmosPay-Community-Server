/**
 * Seal every stored wallet backup under the CURRENT at-rest key.
 *
 * Run it once after turning the seal on (rows written before it are plaintext on
 * disk), and after every rotation (rows still under a previous key): then the
 * previous key can be dropped from WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS.
 *
 * Usage (repo root, with the same env the service runs with):
 *   npm run backups:reencrypt              # does it
 *   npm run backups:reencrypt -- --dry-run # only counts
 *
 * Idempotent: a row already under the current key is left alone. The device-side
 * seal is never touched — this service still cannot open what the person sealed.
 */
import { config } from 'dotenv';
import { PrismaClient } from '@generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  isSealedAtRest,
  keyringFrom,
  openAtRest,
  sealAtRest,
} from '@/wallet-auth/backup-cipher';

config({ path: process.env.ENV_FILE?.trim() || '.env', quiet: true });

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  const keyring = keyringFrom(
    process.env.WALLET_BACKUP_ENCRYPTION_KEY ?? '',
    process.env.WALLET_BACKUP_ENCRYPTION_PREVIOUS_KEYS ?? '',
  );
  const current = keyring.current;
  if (!current) throw new Error('WALLET_BACKUP_ENCRYPTION_KEY is required');

  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const counts = { resealed: 0, current: 0, failed: 0 };
  try {
    const rows = await prisma.walletBackup.findMany({
      select: { id: true, chain: true, address: true, box: true },
    });
    for (const row of rows) {
      if (row.box.startsWith(`enc1:${current.id}:`)) {
        counts.current += 1;
        continue;
      }
      try {
        const plain = openAtRest(row.box, row.chain, row.address, keyring);
        if (!dryRun) {
          await prisma.walletBackup.update({
            where: { id: row.id },
            data: { box: sealAtRest(plain, row.chain, row.address, current) },
          });
        }
        counts.resealed += 1;
      } catch (error) {
        counts.failed += 1;
        console.error(
          `row ${row.id} (${row.chain}:${row.address}, ${isSealedAtRest(row.box) ? 'sealed' : 'plaintext'}) could not be opened: ${String(error)}`,
        );
      }
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
  console.log(
    `${dryRun ? '[dry run] would reseal' : 'resealed'} ${counts.resealed}, already current ${counts.current}, failed ${counts.failed} (key ${current.id}).`,
  );
  if (counts.failed) process.exitCode = 1;
}

void main();
