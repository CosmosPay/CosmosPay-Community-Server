import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandboxPluginSource } from '@/plugins/plugin-folder';
import {
  PluginError,
  type PluginContext,
  type PluginHandlers,
  type PluginJson,
  type PluginJsonObject,
  type PluginPaymentIntent,
} from '@/plugins/sdk';

/**
 * The shipped `plugins/sub-rosa/index.ts`, run in the real isolate the runtime
 * uses, against an in-memory storage whose `compareAndSet` is atomic the way
 * the table's is. Whether the folder is signed is `plugins-folder.spec.ts`'s
 * concern; this is what the code does.
 */
const SOURCE = join(__dirname, '..', '..', 'plugins', 'sub-rosa', 'index.ts');
const plugin: PluginHandlers = sandboxPluginSource(
  readFileSync(SOURCE, 'utf8'),
  SOURCE,
);

const TESTNET_CORE_V2 =
  'CCOVGOQQZJKZ2R55GRWBLTJTGBAMSHXZVN3ICPG3WRVMLMM6RHISC5OV';
const MAINNET_CORE_V2 =
  'CDQOFNCJE5Z4ZZL76DU5652FOUKJVEIZWHFGCZVWH63UYBGPSZIPC325';
const SCHEMA_REF =
  'b84a413c18205d4e45e80eff8ef29d322fbac1fd2f634b3fca9d9740c6176f6a';
const RFQ_ID = '86b82f3d-64d8-4b50-9b28-0d43f2f4500f';
const PROVIDER = `G${'A'.repeat(55)}`;
const OTHER = `G${'B'.repeat(55)}`;
const TX = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

/** The companion's `canonicalRfqItemRef`, as its repository writes it. */
function companionItemRef(input: {
  rfqId: string;
  title: string;
  description?: string;
  commitDeadline: number;
  revealDeadline: number;
}): string {
  const sortJson = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortJson);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([, entry]) => entry !== undefined)
          .sort(([l], [r]) => l.localeCompare(r))
          .map(([k, v]) => [k, sortJson(v)]),
      );
    }
    return value;
  };
  return createHash('sha256')
    .update(
      JSON.stringify(
        sortJson({
          schema: 'cosmos-pay:sub-rosa-rfq:v1',
          ...input,
          description: input.description ?? null,
        }),
      ),
    )
    .digest('hex');
}

/** JSON equality as `jsonb` has it: key order does not count. */
function sameJson(a: unknown, b: unknown): boolean {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function tenant(intents: PluginPaymentIntent[] = []) {
  const records = new Map<string, PluginJson>();
  const copy = (v: PluginJson) => JSON.parse(JSON.stringify(v)) as PluginJson;
  const ctx = {
    plugin: { slug: 'sub-rosa', version: '0.2.0' },
    installation: { id: 'inst_1', config: {} },
    storage: {
      get: (c: string, k: string) =>
        Promise.resolve(
          records.has(`${c}/${k}`) ? copy(records.get(`${c}/${k}`)!) : null,
        ),
      put: (c: string, k: string, v: PluginJson) => {
        records.set(`${c}/${k}`, copy(v));
        return Promise.resolve();
      },
      compareAndSet: (
        c: string,
        k: string,
        expected: PluginJson | null,
        v: PluginJson,
      ) => {
        const key = `${c}/${k}`;
        const ok =
          expected === null
            ? !records.has(key)
            : records.has(key) && sameJson(records.get(key), expected);
        if (ok) records.set(key, copy(v));
        return Promise.resolve(ok);
      },
      delete: (c: string, k: string) =>
        Promise.resolve(records.delete(`${c}/${k}`)),
      list: (c: string, options?: { take?: number; after?: string }) => {
        const keys = [...records.keys()]
          .filter((key) => key.startsWith(`${c}/`))
          .map((key) => key.slice(c.length + 1))
          .sort()
          .filter((key) => !options?.after || key > options.after);
        const take = options?.take ?? 100;
        const page = keys.slice(0, take);
        return Promise.resolve({
          items: page.map((key) => ({
            key,
            value: copy(records.get(`${c}/${key}`)!),
            updatedAt: new Date(0).toISOString(),
          })),
          nextCursor: keys.length > take ? page[page.length - 1] : null,
        });
      },
    },
    core: {
      paymentIntents: {
        get: (id: string) =>
          Promise.resolve(intents.find((i) => i.id === id) ?? null),
        list: jest.fn(),
      },
    },
    http: { request: jest.fn() },
    log: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as unknown as PluginContext;
  return { ctx, records };
}

const now = () => Math.floor(Date.now() / 1000);

function rfqInput(overrides: PluginJsonObject = {}): PluginJsonObject {
  const base = {
    rfqId: RFQ_ID,
    title: 'Independent Soroban security review',
    description: 'Testnet private RFQ',
    commitDeadline: now() + 3600,
    revealDeadline: now() + 7200,
    ...overrides,
  } as {
    rfqId: string;
    title: string;
    description?: string;
    commitDeadline: number;
    revealDeadline: number;
  };
  return { ...base, itemRef: companionItemRef(base), ...overrides };
}

function roundInput(itemRef: string, overrides: PluginJsonObject = {}) {
  return {
    rfqId: RFQ_ID,
    network: 'testnet',
    contractId: TESTNET_CORE_V2,
    roundId: '42',
    protocolVersion: 'core-v2',
    mode: 'ReceiptOnly',
    schemaRef: SCHEMA_REF,
    itemRef,
    revealRound: 123456,
    creatorAddress: OTHER,
    createTxHash: TX(1),
    ...overrides,
  };
}

function resultInput(overrides: PluginJsonObject = {}): PluginJsonObject {
  return {
    rfqId: RFQ_ID,
    selectedProviderAddress: PROVIDER,
    receiptHash: TX(9),
    receiptVersion: 2,
    clientVerified: true,
    openRevealTxHash: TX(2),
    revealTxHash: TX(3),
    clearTxHash: TX(4),
    ...overrides,
  };
}

const command = (ctx: PluginContext, name: string, input: PluginJsonObject) =>
  Promise.resolve().then(() => plugin.commands![name](ctx, input));
const query = (ctx: PluginContext, name: string, input: PluginJsonObject) =>
  Promise.resolve().then(() => plugin.queries![name](ctx, input));

/**
 * An RFQ whose commit phase already closed, with a round attached — the state
 * a result is recorded in. Written straight into storage: creating one through
 * the plugin needs a commit deadline in the future.
 */
async function closedRound(
  ctx: PluginContext,
  records: Map<string, PluginJson>,
  protocolVersion = 'core-v2',
) {
  const created = (await command(ctx, 'create-rfq', rfqInput())) as any;
  await command(
    ctx,
    'attach-sub-rosa-round',
    roundInput(created.itemRef, {
      protocolVersion,
      contractId:
        protocolVersion === 'core-v2'
          ? TESTNET_CORE_V2
          : 'CB7VIYY4RQLZG2Y6HLDWB3UKSVOAIDYFZ5TGW5AUBCIPJHTCZV4ZWQFF',
    }),
  );
  const key = `rfqs/${RFQ_ID}`;
  const stored = records.get(key) as any;
  records.set(key, { ...stored, commitDeadline: now() - 60 });
}

function intent(
  overrides: Partial<PluginPaymentIntent> = {},
): PluginPaymentIntent {
  return {
    id: 'pi_1',
    kind: 'PAY',
    status: 'PENDING',
    source: null,
    destination: PROVIDER,
    amount: '2500',
    asset: 'USDC',
    assetIssuer: null,
    memo: '42',
    chain: 'stellar',
    network: 'testnet',
    txHash: null,
    reference: null,
    expiresAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('the sub-rosa plugin', () => {
  describe('create-rfq', () => {
    it.each([
      ['plain text', 'Independent Soroban security review', undefined],
      [
        'accents and emoji',
        'Revisión de seguridad 🔐 — Salta',
        'Descripción\ncon salto',
      ],
      ['CJK text', '安全审计', '说明'],
      // About 2.4 KB of UTF-8: many SHA-256 blocks, 2- and 4-byte sequences.
      [
        'a long multi-byte description',
        'Long',
        `${'ñ'.repeat(600)}${'😀'.repeat(200)}`,
      ],
    ])(
      'accepts the itemRef the companion computes, for %s',
      async (_l, title, description) => {
        const { ctx } = tenant();
        const definition = {
          rfqId: RFQ_ID,
          title,
          ...(description ? { description } : {}),
          commitDeadline: now() + 3600,
          revealDeadline: now() + 7200,
        };
        const itemRef = companionItemRef(definition);
        const created = (await command(ctx, 'create-rfq', {
          ...definition,
          itemRef,
        })) as any;
        expect(created).toMatchObject({
          id: RFQ_ID,
          status: 'draft',
          itemRef,
          description: description ?? null,
        });
      },
    );

    it('refuses an itemRef that is not the hash of this RFQ, naming the right one', async () => {
      const { ctx } = tenant();
      const input = rfqInput();
      const right = input.itemRef as string;
      await expect(
        command(ctx, 'create-rfq', { ...input, itemRef: TX(7) }),
      ).rejects.toThrow(new RegExp(`canonical JSON.*${right}`));
      // Same hash, other content: a different title is a different RFQ.
      await expect(
        command(ctx, 'create-rfq', { ...input, title: 'Another RFQ' }),
      ).rejects.toThrow(/canonical JSON/);
    });

    it('creates an RFQ once, even when two calls race', async () => {
      const { ctx } = tenant();
      const results = await Promise.allSettled([
        command(ctx, 'create-rfq', rfqInput()),
        command(ctx, 'create-rfq', rfqInput()),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(refused.reason).toBeInstanceOf(PluginError);
      expect(String(refused.reason.message)).toMatch(/already exists/);
    });

    it.each([
      [
        'a commit deadline in the past',
        { commitDeadline: 1_000, revealDeadline: 2_000 },
        /in the future/,
      ],
      [
        'a deadline in milliseconds',
        { revealDeadline: Date.now() + 7_200_000 },
        /Unix time in seconds/,
      ],
      [
        'a reveal before the commit',
        { revealDeadline: now() + 60 },
        /before revealDeadline/,
      ],
    ])('refuses %s', async (_l, overrides, message) => {
      const { ctx } = tenant();
      await expect(
        command(ctx, 'create-rfq', rfqInput(overrides)),
      ).rejects.toThrow(message);
    });

    it.each([
      ['a right-to-left override', `Pay ${String.fromCharCode(0x202e)}evil`],
      ['a zero-width space', `Pay${String.fromCharCode(0x200b)}`],
      ['a line break', 'Pay\nnow'],
      ['an escape sequence', `Pay${String.fromCharCode(0x1b)}[2J`],
    ])('refuses a title with %s', async (_l, title) => {
      const { ctx } = tenant();
      await expect(
        command(ctx, 'create-rfq', rfqInput({ title })),
      ).rejects.toThrow(/control, bidirectional or invisible/);
    });

    it('refuses fields it does not know, so plaintext is never stored by accident', async () => {
      const { ctx, records } = tenant();
      await expect(
        command(ctx, 'create-rfq', {
          ...rfqInput(),
          proposal: 'secret price 2500',
        }),
      ).rejects.toThrow('Unexpected field: proposal');
      expect(records.size).toBe(0);
    });
  });

  describe('attach-sub-rosa-round', () => {
    it('binds the RFQ to the reviewed deployment of its network and protocol', async () => {
      const { ctx } = tenant();
      const created = (await command(ctx, 'create-rfq', rfqInput())) as any;
      const mapped = (await command(
        ctx,
        'attach-sub-rosa-round',
        roundInput(created.itemRef),
      )) as any;
      expect(mapped.status).toBe('round-attached');
      expect(mapped.subRosa).toMatchObject({
        contractId: TESTNET_CORE_V2,
        roundId: '42',
      });
    });

    it('accepts mainnet core-v2 on its own contract', async () => {
      const { ctx } = tenant();
      const created = (await command(ctx, 'create-rfq', rfqInput())) as any;
      await expect(
        command(
          ctx,
          'attach-sub-rosa-round',
          roundInput(created.itemRef, {
            network: 'mainnet',
            contractId: MAINNET_CORE_V2,
          }),
        ),
      ).resolves.toMatchObject({ subRosa: { network: 'mainnet' } });
    });

    it.each([
      [
        'a look-alike contract',
        { contractId: `C${'D'.repeat(55)}` },
        /reviewed Sub Rosa core-v2 deployment on testnet/,
      ],
      [
        'the testnet contract on mainnet',
        { network: 'mainnet' },
        /deployment on mainnet/,
      ],
      [
        'reveal-policy v3 on mainnet, which has no reviewed deployment',
        { network: 'mainnet', protocolVersion: 'reveal-policy-v3' },
        /no reviewed deployment on mainnet/,
      ],
      ['another schema', { schemaRef: TX(5) }, /sealed-proposal v1 schema/],
      ['another item', { itemRef: TX(6) }, /must match the RFQ canonical hash/],
    ])('refuses %s', async (_l, overrides, message) => {
      const { ctx } = tenant();
      const created = (await command(ctx, 'create-rfq', rfqInput())) as any;
      await expect(
        command(
          ctx,
          'attach-sub-rosa-round',
          roundInput(created.itemRef, overrides),
        ),
      ).rejects.toThrow(message);
    });
  });

  describe('record-result', () => {
    it('records the evidence after the commit phase', async () => {
      const { ctx, records } = tenant();
      await closedRound(ctx, records);
      const selected = (await command(
        ctx,
        'record-result',
        resultInput(),
      )) as any;
      expect(selected.status).toBe('provider-selected');
      expect(selected.selection).toMatchObject({
        selectedProviderAddress: PROVIDER,
        receiptVersion: 2,
        clientVerified: true,
      });
    });

    it('refuses a result while proposals are still sealed', async () => {
      const { ctx } = tenant();
      const created = (await command(ctx, 'create-rfq', rfqInput())) as any;
      await command(ctx, 'attach-sub-rosa-round', roundInput(created.itemRef));
      await expect(
        command(ctx, 'record-result', resultInput()),
      ).rejects.toThrow(/only after the commit deadline/);
    });

    it('keeps the first of two results recorded at once', async () => {
      const { ctx, records } = tenant();
      await closedRound(ctx, records);
      const results = await Promise.allSettled([
        command(ctx, 'record-result', resultInput()),
        command(
          ctx,
          'record-result',
          resultInput({ selectedProviderAddress: OTHER }),
        ),
      ]);
      const won = results.filter(
        (r) => r.status === 'fulfilled',
      ) as PromiseFulfilledResult<any>[];
      expect(won).toHaveLength(1);
      const stored = (await query(ctx, 'get-rfq', { rfqId: RFQ_ID })) as any;
      expect(stored.rfq.selection.selectedProviderAddress).toBe(
        won[0].value.selection.selectedProviderAddress,
      );
    });

    it.each([
      [
        'the receipt version of another protocol',
        { receiptVersion: 3 },
        /must be 2 for a core-v2 round/,
      ],
      [
        'one transaction reported twice',
        { revealTxHash: TX(2) },
        /different transactions/,
      ],
      [
        'the round creation reported as its clear',
        { clearTxHash: TX(1) },
        /different transactions/,
      ],
      [
        'a result the companion did not verify',
        { clientVerified: false },
        /clientVerified must be true/,
      ],
      [
        'a receipt URL with credentials',
        { receiptUri: 'https://user:pw@receipts.example/x' },
        /no user@ part/,
      ],
      [
        'a receipt URL over http',
        { receiptUri: 'http://receipts.example/x' },
        /absolute https URL/,
      ],
      [
        'a receipt URL with a look-alike host',
        {
          receiptUri: `https://r${String.fromCharCode(0x435)}ceipts.example/x`,
        },
        /printable ASCII/,
      ],
    ])('refuses %s', async (_l, overrides, message) => {
      const { ctx, records } = tenant();
      await closedRound(ctx, records);
      await expect(
        command(ctx, 'record-result', resultInput(overrides)),
      ).rejects.toThrow(message);
    });

    it('takes receipt version 3 from a reveal-policy v3 round', async () => {
      const { ctx, records } = tenant();
      await closedRound(ctx, records, 'reveal-policy-v3');
      await expect(
        command(ctx, 'record-result', resultInput({ receiptVersion: 3 })),
      ).resolves.toMatchObject({ selection: { receiptVersion: 3 } });
    });

    it('accepts a plain https receipt URL', async () => {
      const { ctx, records } = tenant();
      await closedRound(ctx, records);
      await expect(
        command(
          ctx,
          'record-result',
          resultInput({
            receiptUri: 'https://receipts.example.com/rounds/42?v=2',
          }),
        ),
      ).resolves.toMatchObject({
        selection: { receiptUri: 'https://receipts.example.com/rounds/42?v=2' },
      });
    });
  });

  describe('attach-payment-intent', () => {
    async function selected(intents: PluginPaymentIntent[]) {
      const { ctx, records } = tenant(intents);
      await closedRound(ctx, records);
      await command(ctx, 'record-result', resultInput());
      return ctx;
    }

    it('links the intent that pays the selected provider, and answers a replay the same', async () => {
      const ctx = await selected([intent()]);
      const linked = (await command(ctx, 'attach-payment-intent', {
        rfqId: RFQ_ID,
        paymentIntentId: 'pi_1',
      })) as any;
      expect(linked.paymentIntentId).toBe('pi_1');
      await expect(
        command(ctx, 'attach-payment-intent', {
          rfqId: RFQ_ID,
          paymentIntentId: 'pi_1',
        }),
      ).resolves.toMatchObject({ paymentIntentId: 'pi_1' });
      const read = (await query(ctx, 'get-rfq', { rfqId: RFQ_ID })) as any;
      expect(read.paymentIntent.id).toBe('pi_1');
    });

    it.each([
      [
        'an intent that pays someone else',
        intent({ destination: OTHER }),
        /must pay the selected provider/,
      ],
      [
        'a failed intent',
        intent({ status: 'FAILED' }),
        /FAILED payment intent cannot be linked/,
      ],
      [
        'an expired intent',
        intent({ status: 'EXPIRED' }),
        /EXPIRED payment intent/,
      ],
      [
        'an intent on mainnet for a testnet round',
        intent({ network: 'public' }),
        /network must be testnet/,
      ],
      [
        'an intent on Solana',
        intent({ chain: 'solana' }),
        /must settle on Stellar/,
      ],
    ])('refuses %s', async (_l, candidate, message) => {
      const ctx = await selected([candidate]);
      await expect(
        command(ctx, 'attach-payment-intent', {
          rfqId: RFQ_ID,
          paymentIntentId: 'pi_1',
        }),
      ).rejects.toThrow(message);
    });

    it('refuses an intent this tenant cannot see, and a second one once linked', async () => {
      const ctx = await selected([intent(), intent({ id: 'pi_2' })]);
      await expect(
        command(ctx, 'attach-payment-intent', {
          rfqId: RFQ_ID,
          paymentIntentId: 'pi_x',
        }),
      ).rejects.toThrow(/not found for this tenant/);
      await command(ctx, 'attach-payment-intent', {
        rfqId: RFQ_ID,
        paymentIntentId: 'pi_1',
      });
      await expect(
        command(ctx, 'attach-payment-intent', {
          rfqId: RFQ_ID,
          paymentIntentId: 'pi_2',
        }),
      ).rejects.toThrow(/already links another/);
    });
  });

  describe('queries', () => {
    it('reads only the calling installation', async () => {
      const a = tenant();
      const b = tenant();
      await command(a.ctx, 'create-rfq', rfqInput());
      await expect(query(b.ctx, 'get-rfq', { rfqId: RFQ_ID })).rejects.toThrow(
        /not found/,
      );
    });

    it('pages the RFQs by id', async () => {
      const { ctx } = tenant();
      for (const id of [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ]) {
        await command(ctx, 'create-rfq', rfqInput({ rfqId: id }));
      }
      const first = (await query(ctx, 'list-rfqs', { take: 2 })) as any;
      expect(first.data).toHaveLength(2);
      const rest = (await query(ctx, 'list-rfqs', {
        take: 2,
        after: first.nextCursor,
      })) as any;
      expect(rest.data).toHaveLength(1);
      expect(rest.nextCursor).toBeNull();
    });

    it('cannot write', async () => {
      // The runtime refuses writes from a query; the plugin does not try any.
      expect(Object.keys(plugin.queries!).sort()).toEqual([
        'get-rfq',
        'list-rfqs',
      ]);
    });
  });
});
