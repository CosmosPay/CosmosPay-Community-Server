import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlindpayClient, UploadableFile } from '../../blindpay/blindpay.client';
import { GatewayConsumer } from '../../common/interfaces/gateway-consumer.interface';
import { AppConfig } from '../../config/configuration';
import { KycMetaService } from './kyc-meta.service';

const consumer: GatewayConsumer = {
  username: 'cosmos_u1',
  credentialId: 'cred_1',
  environment: 'dev',
  role: 'user',
  permissions: ['kyc:read', 'kyc:write'],
  organizationId: null,
  plan: null,
  planSwapFeeBps: null,
};

const file: UploadableFile = {
  buffer: Buffer.from('document'),
  originalname: 'passport.png',
  mimetype: 'image/png',
};

function makeService() {
  const blindpay = {
    uploadFile: jest.fn(),
    post: jest.fn(),
    get: jest.fn(),
    instanceId: 'in_test',
  };
  const config = {
    get: jest.fn().mockReturnValue({
      redirectUrlWhitelist: { cosmos_u1: ['app.example.com'] },
    }),
  };
  const service = new KycMetaService(
    blindpay as unknown as BlindpayClient,
    config as unknown as ConfigService<AppConfig, true>,
  );
  return { service, blindpay };
}

describe('KycMetaService', () => {
  describe('uploadDocument', () => {
    it('rejects a missing file', () => {
      const { service } = makeService();

      expect(() => service.uploadDocument(undefined, undefined)).toThrow(
        BadRequestException,
      );
      expect(() => service.uploadDocument(undefined, undefined)).toThrow(
        'multipart field "file"',
      );
    });

    it('rejects an unknown bucket and lists every accepted bucket', () => {
      const { service } = makeService();

      expect(() => service.uploadDocument(file, 'no_existe')).toThrow(
        'bucket must be one of: avatar, onboarding, limit_increase',
      );
    });

    it('defaults to the onboarding bucket', async () => {
      const { service, blindpay } = makeService();
      blindpay.uploadFile.mockResolvedValue({
        file_url: 'https://files.example/passport.png',
      });

      await expect(service.uploadDocument(file, undefined)).resolves.toEqual({
        file_url: 'https://files.example/passport.png',
      });
      expect(blindpay.uploadFile).toHaveBeenCalledWith(file, 'onboarding');
    });

    it('passes the limit_increase bucket through', async () => {
      const { service, blindpay } = makeService();
      blindpay.uploadFile.mockResolvedValue({
        file_url: 'https://files.example/limit.png',
      });

      await service.uploadDocument(file, 'limit_increase');

      expect(blindpay.uploadFile).toHaveBeenCalledWith(file, 'limit_increase');
    });
  });

  it('starts ToS with the supplied idempotency key and receiver', async () => {
    const { service, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });

    await expect(
      service.initiateTos(consumer, {
        idempotency_key: 'tos_request_1',
        receiver_id: 're_1',
        redirect_url: 'https://app.example.com/kyc/return',
      }),
    ).resolves.toEqual({ url: 'https://tos.example/accept' });
    expect(blindpay.post).toHaveBeenCalledWith('/e/instances/in_test/tos', {
      idempotency_key: 'tos_request_1',
      receiver_id: 're_1',
      redirect_url: 'https://app.example.com/kyc/return',
    });
  });

  it('generates a ToS idempotency key and uses a null receiver by default', async () => {
    const { service, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });

    await service.initiateTos(consumer, {
      redirect_url: 'https://app.example.com/kyc/return',
    });

    expect(blindpay.post).toHaveBeenCalledWith('/e/instances/in_test/tos', {
      // Jest asymmetric matchers are intentionally typed as any.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      idempotency_key: expect.any(String),
      receiver_id: null,
      redirect_url: 'https://app.example.com/kyc/return',
    });
  });

  it('proxies the rail catalog without network in the test', async () => {
    const { service, blindpay } = makeService();
    blindpay.get.mockResolvedValue({ rails: ['ach'] });

    await expect(service.listRails()).resolves.toEqual({ rails: ['ach'] });
    expect(blindpay.get).toHaveBeenCalledWith('/available/rails');
  });

  it('proxies bank-detail schemas with the requested rail', async () => {
    const { service, blindpay } = makeService();
    blindpay.get.mockResolvedValue({ fields: ['routing_number'] });

    await expect(service.bankDetails('ach')).resolves.toEqual({
      fields: ['routing_number'],
    });
    expect(blindpay.get).toHaveBeenCalledWith('/available/bank-details', {
      query: { rail: 'ach' },
    });
  });
});
