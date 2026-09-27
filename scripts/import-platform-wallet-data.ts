/**
 * One-shot import: the wallet backups and SEP-30 registrations the developer
 * platform held before the wallet sign-in and account recovery moved here.
 *
 * Usage (from repo root, with DATABASE_URL set, after `prisma migrate deploy`):
 *   npx ts-node -r tsconfig-paths/register --transpile-only \
 *     scripts/import-platform-wallet-data.ts wallet-data-export.json [--dry-run]
 *
 * The file is what the platform's `scripts/export-wallet-data.mjs` writes.
 *
 * ## Why it matters
 *
 * A `wallet_backup` row is a person's encrypted seed — the only way their next
 * device gets the wallet back with just a password. Moving the sign-in without
 * moving these would have turned every existing backup into an account the new
 * server says has none, and the next sign-in would offer to create a fresh
 * wallet on top of a funded one.
 *
 * ## What it will not do
 *
 *  - Overwrite. An email that already has an account here keeps it; the row is
 *    reported and skipped. Whatever got written here since the move is newer
 *    than the export.
 *  - Import a box this service would not accept (`isBackupBox`), so an import
 *    cannot smuggle in something the live routes refuse.
 *  - Import another role's registrations. Each recovery deployment runs this
 *    with its own `RECOVERY_ROLE`, and takes only its own role's rows — the two
 *    servers keep separate databases, and that is the point of having two. The
 *    signers stay valid as long as each role keeps the RECOVERY_SIGNER_MASTER it
 *    had on the platform (the derivation is byte-for-byte the same).
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaClient, WalletAuthMethod } from '@generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { isAccountId } from '@/stellar/account-signers';
import {
  fallbackName,
  isBackupBox,
  normalizeEmail,
} from '@/wallet-auth/wallet-auth-core';

interface ExportFile {
  exportedAt?: string;
  walletBackups?: {
    email?: unknown;
    name?: unknown;
    stellarAddress?: unknown;
    box?: unknown;
  }[];
  recoveryAccounts?: {
    role?: unknown;
    address?: unknown;
    network?: unknown;
    methods?: { identityRole?: unknown; type?: unknown; value?: unknown }[];
  }[];
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

async function main() {
  const [file, flag] = process.argv.slice(2);
  if (!file)
    throw new Error(
      'Pass the export file: import-platform-wallet-data.ts <file.json> [--dry-run]',
    );
  const dryRun = flag === '--dry-run';
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const data = JSON.parse(readFileSync(file, 'utf8')) as ExportFile;
  const pool = new Pool({ connectionString });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  let imported = 0;
  let skipped = 0;
  for (const row of data.walletBackups ?? []) {
    const email = normalizeEmail(str(row.email));
    const address = str(row.stellarAddress);
    const box = str(row.box);
    if (!email || !isAccountId(address) || !isBackupBox(box)) {
      skipped += 1;
      console.log(`skip backup ${email || '(no email)'}: malformed`);
      continue;
    }
    const existing = await prisma.walletAccount.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      console.log(`skip backup ${email}: an account already exists here`);
      continue;
    }
    imported += 1;
    if (dryRun) continue;
    await prisma.walletAccount.create({
      data: {
        email,
        name: fallbackName(email, str(row.name) || null),
        // The platform did not record how the email was proven; every door it
        // had ended in a verified email, and the next sign-in overwrites this.
        method: WalletAuthMethod.EMAIL,
        stellarAddress: address,
        backup: { create: { stellarAddress: address, box } },
      },
    });
  }
  console.log(
    `backups: ${imported} imported, ${skipped} skipped${dryRun ? ' (dry run)' : ''}`,
  );

  const role = process.env.RECOVERY_ROLE;
  if (role !== 'a' && role !== 'b') {
    console.log(
      'recovery: RECOVERY_ROLE is not set here, so no registrations were imported.',
    );
  } else {
    let accounts = 0;
    for (const row of data.recoveryAccounts ?? []) {
      if (str(row.role) !== role) continue;
      const address = str(row.address);
      const methods = (row.methods ?? [])
        .filter((m) => str(m.type) === 'email' && str(m.value))
        .map((m) => ({
          identityRole: str(m.identityRole) || 'owner',
          type: 'email',
          value: normalizeEmail(str(m.value)),
        }));
      if (!isAccountId(address) || !methods.length) {
        console.log(
          `skip recovery ${address || '(no address)'}: malformed or no email method`,
        );
        continue;
      }
      accounts += 1;
      if (dryRun) continue;
      await prisma.recoveryAccount.upsert({
        where: { role_address: { role, address } },
        create: {
          role,
          address,
          network: str(row.network) || 'public',
          methods: { create: methods },
        },
        // Present already means registered here since the move: newer, kept.
        update: {},
      });
    }
    console.log(
      `recovery (role ${role}): ${accounts} account(s)${dryRun ? ' (dry run)' : ''}`,
    );
  }

  await prisma.$disconnect();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
