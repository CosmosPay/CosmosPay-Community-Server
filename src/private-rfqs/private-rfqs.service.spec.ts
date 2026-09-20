import { ApiErrorCode } from '@/common/errors/api-error';
import { PrivateRfqsService } from '@/private-rfqs/private-rfqs.service';
import { privateRfqItemRef } from '@/private-rfqs/private-rfq-reference';
import { SubRosaRoundReadError } from '@/private-rfqs/sub-rosa-round-reader.service';

describe('PrivateRfqsService', () => {
  const consumer = {
    username: 'cosmos_buyer',
    credentialId: 'cred_1',
    environment: 'dev',
  } as any;
  const otherConsumer = { ...consumer, username: 'cosmos_other' };
  const contractId = `C${'A'.repeat(55)}`;
  const now = new Date('2026-09-20T12:00:00.000Z');

  function snapshot(overrides: Record<string, unknown> = {}) {
    return {
      contractId,
      roundId: '42',
      itemRefHex: privateRfqItemRef('rfq-1').toString('hex'),
      schemaRefHex: 'schema-ref',
      sealedProposalSchema: true,
      mode: 'ReceiptOnly',
      clearingRule: 'LowestBid',
      roundStatus: 'Open',
      commitDeadline: 1_800_000_000n,
      revealDeadline: 1_800_000_600n,
      revealComplete: false,
      quotes: [],
      ...overrides,
    } as any;
  }

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rfq_db_1',
      consumerId: 'consumer_1',
      reference: 'rfq-1',
      network: 'testnet',
      contractId,
      roundId: '42',
      status: 'OPEN',
      roundStatus: 'Open',
      commitDeadline: now,
      revealDeadline: now,
      assetCode: 'USDC',
      assetIssuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      assetDecimals: 7,
      selectedProvider: null,
      selectedAmount: null,
      selectedAt: null,
      revealedAt: null,
      paymentIntentId: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    } as any;
  }

  function build() {
    const prisma = {
      privateRfq: {
        create: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'stellar') return { network: 'testnet' };
        return undefined;
      }),
    };
    const consumers = {
      resolve: jest.fn().mockResolvedValue({ id: 'consumer_1' }),
    };
    const rounds = {
      read: jest.fn(),
    };
    const webhooks = { emit: jest.fn().mockResolvedValue(true) };
    const paymentIntents = {
      createTx: jest.fn(),
      createPay: jest.fn(),
      findOne: jest.fn(),
    };
    const service = new PrivateRfqsService(
      config as any,
      prisma as any,
      consumers as any,
      rounds as any,
      webhooks as any,
      paymentIntents as any,
    );
    return { service, prisma, consumers, rounds, webhooks, paymentIntents };
  }

  const createDto = {
    reference: 'rfq-1',
    network: 'testnet' as const,
    contractId,
    roundId: '42',
    assetCode: 'USDC',
    assetIssuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    assetDecimals: 7,
  };

  it('rejects a network outside the API key scope before reading Sub Rosa', async () => {
    const { service, rounds } = build();
    await expect(
      service.create(consumer, { ...createDto, network: 'public' }),
    ).rejects.toMatchObject({ code: ApiErrorCode.SubRosaNetworkMismatch });
    expect(rounds.read).not.toHaveBeenCalled();
  });

  it('rejects a Sub Rosa round that cannot be verified', async () => {
    const { service, rounds } = build();
    rounds.read.mockRejectedValue(new SubRosaRoundReadError('missing round'));
    await expect(service.create(consumer, createDto)).rejects.toMatchObject({
      code: ApiErrorCode.InvalidSubRosaRound,
    });
  });

  it('persists metadata without plaintext quote or proposal fields', async () => {
    const { service, prisma, rounds } = build();
    rounds.read.mockResolvedValue(snapshot());
    prisma.privateRfq.create.mockImplementation(({ data }: any) =>
      Promise.resolve(row(data)),
    );

    await service.create(consumer, createDto);

    const data = prisma.privateRfq.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('quotes');
    expect(data).not.toHaveProperty('proposal');
    expect(JSON.stringify(data)).not.toContain('approach');
  });

  it('scopes single-RFQ reads to the authenticated consumer', async () => {
    const { service, prisma } = build();
    prisma.privateRfq.findFirst.mockResolvedValue(null);

    await expect(
      service.findOne(otherConsumer, 'rfq_db_1'),
    ).rejects.toMatchObject({
      code: ApiErrorCode.NotFound,
    });
    expect(prisma.privateRfq.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'rfq_db_1',
        consumer: { apisixUsername: 'cosmos_other' },
      },
    });
  });

  it('synchronizes reveal state and emits the reveal webhook once', async () => {
    const { service, prisma, rounds, webhooks } = build();
    const current = row();
    const revealed = snapshot({
      roundStatus: 'Revealing',
      revealComplete: true,
      quotes: [
        {
          provider: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
          revealed: true,
          valid: true,
          amount: '25000000',
          proposal: { timelineDays: 5, approach: 'deliver' },
        },
      ],
    });
    prisma.privateRfq.findFirst.mockResolvedValue(current);
    rounds.read.mockResolvedValue(revealed);
    prisma.privateRfq.updateMany.mockResolvedValue({ count: 1 });
    prisma.privateRfq.findUniqueOrThrow.mockResolvedValue(
      row({ status: 'REVEALED', revealedAt: now }),
    );

    const result = await service.sync(consumer, current.id);

    expect(result.status).toBe('REVEALED');
    expect(result.quotes?.[0].proposal).toEqual({
      timelineDays: 5,
      approach: 'deliver',
    });
    expect(webhooks.emit).toHaveBeenCalledWith(
      consumer.username,
      'PRIVATE_RFQ_REVEALED',
      expect.objectContaining({ id: current.id }),
    );
  });

  it('does not allow selection before reveal completes', async () => {
    const { service, prisma, rounds } = build();
    prisma.privateRfq.findFirst.mockResolvedValue(row());
    rounds.read.mockResolvedValue(snapshot());
    prisma.privateRfq.updateMany.mockResolvedValue({ count: 1 });
    prisma.privateRfq.findUniqueOrThrow.mockResolvedValue(row());

    await expect(
      service.select(
        consumer,
        'rfq_db_1',
        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      ),
    ).rejects.toMatchObject({ code: ApiErrorCode.PrivateRfqStateInvalid });
  });

  it('selects a valid revealed provider', async () => {
    const { service, prisma, rounds, webhooks } = build();
    const provider = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    prisma.privateRfq.findFirst.mockResolvedValue(row({ status: 'REVEALED' }));
    rounds.read.mockResolvedValue(
      snapshot({
        revealComplete: true,
        roundStatus: 'Revealing',
        quotes: [
          {
            provider,
            revealed: true,
            valid: true,
            amount: '25000000',
            proposal: {},
          },
        ],
      }),
    );
    prisma.privateRfq.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.privateRfq.findUniqueOrThrow
      .mockResolvedValueOnce(row({ status: 'REVEALED' }))
      .mockResolvedValueOnce(
        row({
          status: 'SELECTED',
          selectedProvider: provider,
          selectedAmount: '25000000',
        }),
      );

    const selected = await service.select(consumer, 'rfq_db_1', provider);

    expect(selected.selectedProvider).toBe(provider);
    expect(selected.selectedAmount).toBe('25000000');
    expect(webhooks.emit).toHaveBeenCalledWith(
      consumer.username,
      'PRIVATE_RFQ_SELECTED',
      expect.objectContaining({ selectedProvider: provider }),
    );
  });

  it('hands the selected on-chain quote to the existing TX intent service', async () => {
    const { service, prisma, rounds, paymentIntents } = build();
    const provider = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const source = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const selected = row({
      status: 'SELECTED',
      selectedProvider: provider,
      selectedAmount: '25000000',
    });
    prisma.privateRfq.findFirst.mockResolvedValue(selected);
    rounds.read.mockResolvedValue(
      snapshot({
        revealComplete: true,
        roundStatus: 'Revealing',
        quotes: [
          {
            provider,
            revealed: true,
            valid: true,
            amount: '25000000',
            proposal: {},
          },
        ],
      }),
    );
    prisma.privateRfq.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.privateRfq.findUniqueOrThrow.mockResolvedValueOnce(selected);
    prisma.privateRfq.update.mockResolvedValueOnce(
      row({ ...selected, paymentIntentId: 'pi_1' }),
    );
    paymentIntents.createTx.mockResolvedValue({ id: 'pi_1', amount: '2.5' });

    const result = await service.createPaymentIntent(consumer, selected.id, {
      kind: 'TX',
      source,
    });

    expect(paymentIntents.createTx).toHaveBeenCalledWith(
      consumer,
      expect.objectContaining({
        source,
        destination: provider,
        amount: '2.5',
        assetCode: 'USDC',
        assetIssuer: selected.assetIssuer,
      }),
    );
    expect(result.paymentIntent.id).toBe('pi_1');
  });
});
