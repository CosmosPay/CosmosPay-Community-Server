import { HttpStatus, type RawBodyRequest } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { computeSvixSignature } from '@/blindpay/blindpay-signature';
import type { BlindpaySyncService } from '@/blindpay/blindpay-sync.service';
import { BlindpayWebhooksController } from '@/blindpay/webhooks/blindpay-webhooks.controller';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';

const SECRET = `whsec_${Buffer.from('blindpay-webhook-spec-key').toString('base64')}`;
const BODY = JSON.stringify({ type: 'receiver.updated', data: { id: 're_1' } });

function makeController(webhookSecret: string) {
  const config = { get: jest.fn().mockReturnValue({ webhookSecret }) };
  const sync = { handleWebhook: jest.fn().mockResolvedValue(undefined) };
  const controller = new BlindpayWebhooksController(
    config as unknown as ConfigService<AppConfig, true>,
    sync as unknown as BlindpaySyncService,
  );
  return { controller, sync };
}

/** Svix headers that verify against {@link SECRET} for `body`. */
function signed(id: string, body = BODY): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${computeSvixSignature(SECRET, id, timestamp, body)}`,
  };
}

function delivery(
  headers: Record<string, string | string[]>,
  body = BODY,
): RawBodyRequest<Request> {
  return {
    headers,
    rawBody: Buffer.from(body),
  } as unknown as RawBodyRequest<Request>;
}

async function refusal(pending: Promise<unknown>): Promise<ApiError> {
  try {
    await pending;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected the delivery to be refused');
}

describe('BlindpayWebhooksController', () => {
  it('answers 503 misconfigured when no webhook secret is set', async () => {
    const { controller, sync } = makeController('');

    const err = await refusal(controller.handle(delivery(signed('msg_1'))));

    // It was 400 `validation_failed`, which blamed the delivery for what is this
    // deployment's configuration.
    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
    expect(sync.handleWebhook).not.toHaveBeenCalled();
  });

  it('refuses a delivery whose signature does not verify (400)', async () => {
    const { controller, sync } = makeController(SECRET);
    const forged = { ...signed('msg_1'), 'svix-signature': 'v1,Zm9yZ2Vk' };

    const err = await refusal(controller.handle(delivery(forged)));

    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(sync.handleWebhook).not.toHaveBeenCalled();
  });

  it('hands a verified delivery to the sync service under its svix id', async () => {
    const { controller, sync } = makeController(SECRET);

    await expect(controller.handle(delivery(signed('msg_1')))).resolves.toEqual(
      { received: true },
    );

    expect(sync.handleWebhook).toHaveBeenCalledWith(
      'receiver.updated',
      { id: 're_1' },
      'msg_1',
    );
  });
});
