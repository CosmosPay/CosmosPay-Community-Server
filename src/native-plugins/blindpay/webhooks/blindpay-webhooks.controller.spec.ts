import { HttpStatus, type RawBodyRequest } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { computeSvixSignature } from '@/blindpay/blindpay-signature';
import type { BlindpaySyncService } from '@/blindpay/blindpay-sync.service';
import { BlindpayWebhooksController } from '@/blindpay/webhooks/blindpay-webhooks.controller';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { AppConfig } from '@/config/configuration';

const SECRET = `whsec_${Buffer.from('blindpay-webhook-spec-key').toString('base64')}`;
const DEV_SECRET = `whsec_${Buffer.from('blindpay-webhook-dev-spec-key').toString('base64')}`;
const BODY = JSON.stringify({ type: 'receiver.updated', data: { id: 're_1' } });

function makeController(secrets: { prod?: string; dev?: string }) {
  const instances = {
    prod: { apiKey: '', instanceId: '', webhookSecret: secrets.prod ?? '' },
    dev: { apiKey: '', instanceId: '', webhookSecret: secrets.dev ?? '' },
  };
  const config = { get: jest.fn().mockReturnValue({ instances }) };
  const sync = { handleWebhook: jest.fn().mockResolvedValue(undefined) };
  const controller = new BlindpayWebhooksController(
    config as unknown as ConfigService<AppConfig, true>,
    sync as unknown as BlindpaySyncService,
  );
  return { controller, sync };
}

/** Svix headers that verify against `secret` for `body`. */
function signed(
  id: string,
  secret = SECRET,
  body = BODY,
): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${computeSvixSignature(secret, id, timestamp, body)}`,
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
  it('answers 503 misconfigured when no instance has a webhook secret', async () => {
    const { controller, sync } = makeController({});

    const err = await refusal(controller.handle(delivery(signed('msg_1'))));

    // It was 400 `validation_failed`, which blamed the delivery for what is this
    // deployment's configuration.
    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(err.code).toBe(ApiErrorCode.Misconfigured);
    expect(sync.handleWebhook).not.toHaveBeenCalled();
  });

  it('refuses a delivery whose signature does not verify (400)', async () => {
    const { controller, sync } = makeController({ prod: SECRET });
    const forged = { ...signed('msg_1'), 'svix-signature': 'v1,Zm9yZ2Vk' };

    const err = await refusal(controller.handle(delivery(forged)));

    expect(err).toBeInstanceOf(ApiError);
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(err.code).toBe(ApiErrorCode.ValidationFailed);
    expect(sync.handleWebhook).not.toHaveBeenCalled();
  });

  it('hands a verified delivery to the sync service under its svix id', async () => {
    const { controller, sync } = makeController({ prod: SECRET });

    await expect(controller.handle(delivery(signed('msg_1')))).resolves.toEqual(
      { received: true },
    );

    expect(sync.handleWebhook).toHaveBeenCalledWith(
      'prod',
      'receiver.updated',
      { id: 're_1' },
      'msg_1',
    );
  });

  it('attributes a delivery to the instance whose secret verified it', async () => {
    const { controller, sync } = makeController({
      prod: SECRET,
      dev: DEV_SECRET,
    });

    await controller.handle(delivery(signed('msg_dev', DEV_SECRET)));

    // The payload says nothing about its instance; only the secret does.
    expect(sync.handleWebhook).toHaveBeenCalledWith(
      'dev',
      'receiver.updated',
      { id: 're_1' },
      'msg_dev',
    );
  });

  it('refuses a development delivery when only production is configured', async () => {
    const { controller, sync } = makeController({ prod: SECRET });

    const err = await refusal(
      controller.handle(delivery(signed('msg_dev', DEV_SECRET))),
    );

    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(sync.handleWebhook).not.toHaveBeenCalled();
  });
});
