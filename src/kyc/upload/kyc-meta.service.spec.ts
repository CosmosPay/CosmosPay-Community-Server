import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import { BlindpayClient, UploadableFile } from '@/blindpay/blindpay.client';
import { BlindpayKycApi } from '@/blindpay/blindpay-kyc.api';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { AppConfig } from '@/config/configuration';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import { PrismaService } from '@/prisma/prisma.service';
import { KycMetaService } from '@/kyc/upload/kyc-meta.service';

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

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const file: UploadableFile = {
  buffer: Buffer.concat([PNG_SIGNATURE, Buffer.from('document')]),
  originalname: 'passport.png',
  mimetype: 'image/png',
};

function makeService() {
  // Client and instance in one; the environment follows the key, as the real
  // client's does, so a dev caller is seen reaching the dev instance.
  const blindpay = {
    uploadFile: jest.fn(),
    post: jest.fn(),
    get: jest.fn(),
    instanceId: 'in_test',
    environmentFor: jest.fn((c: GatewayConsumer) =>
      c.environment === 'prod' ? 'prod' : 'dev',
    ),
    instance: jest.fn(),
  };
  blindpay.instance.mockReturnValue(blindpay);
  const config = {
    get: jest.fn().mockReturnValue({
      redirectUrlWhitelist: { cosmos_u1: ['app.example.com'] },
    }),
  };
  // `initiateTos` refuses a receiver the caller does not own, so a case that
  // names one has to mirror it: the resolver returns the local consumer row and
  // the receiver lookup finds it under that consumer.
  const prisma = {
    blindpayReceiver: {
      findFirst: jest.fn().mockResolvedValue({ id: 'br_1' }),
    },
  };
  const consumers = { resolve: jest.fn().mockResolvedValue({ id: 'c_1' }) };
  const service = new KycMetaService(
    // The real provider surface over a mocked transport, so the paths asserted
    // below are the exact requests BlindPay receives.
    new BlindpayKycApi(blindpay as unknown as BlindpayClient),
    config as unknown as ConfigService<AppConfig, true>,
    prisma as unknown as PrismaService,
    consumers as unknown as ConsumerResolverService,
  );
  return { service, blindpay, prisma };
}

describe('KycMetaService', () => {
  describe('uploadDocument', () => {
    it('rejects a missing file as 400 validation_failed', () => {
      const { service } = makeService();

      let err: ApiError | undefined;
      try {
        void service.uploadDocument(consumer, undefined, undefined);
      } catch (e) {
        err = e as ApiError;
      }

      expect(err).toBeInstanceOf(ApiError);
      expect(err!.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      expect(err!.code).toBe(ApiErrorCode.ValidationFailed);
      expect(err!.message).toContain('multipart field "file"');
    });

    it('rejects an unknown bucket and lists every accepted bucket', () => {
      const { service } = makeService();

      expect(() => service.uploadDocument(consumer, file, 'no_existe')).toThrow(
        'bucket must be one of: avatar, onboarding, limit_increase',
      );
    });

    it("defaults to the onboarding bucket, on the caller's instance", async () => {
      const { service, blindpay } = makeService();
      blindpay.uploadFile.mockResolvedValue({
        file_url: 'https://files.example/passport.png',
      });

      await expect(
        service.uploadDocument(consumer, file, undefined),
      ).resolves.toEqual({
        file_url: 'https://files.example/passport.png',
      });
      expect(blindpay.uploadFile).toHaveBeenCalledWith(file, 'onboarding');
      // A dev key's document never lands in the production instance's storage.
      expect(blindpay.instance).toHaveBeenCalledWith('dev');
    });

    it('passes the limit_increase bucket through', async () => {
      const { service, blindpay } = makeService();
      blindpay.uploadFile.mockResolvedValue({
        file_url: 'https://files.example/limit.png',
      });

      await service.uploadDocument(consumer, file, 'limit_increase');

      expect(blindpay.uploadFile).toHaveBeenCalledWith(file, 'limit_increase');
    });

    it.each([
      ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])],
      ['image/png', PNG_SIGNATURE],
      ['image/webp', Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1')],
      ['image/heic', Buffer.from('\x00\x00\x00\x18ftypheic', 'latin1')],
      // `mif1` is written for both HEIF types, so it has to pass for either.
      ['image/heif', Buffer.from('\x00\x00\x00\x18ftypmif1', 'latin1')],
      ['image/heic', Buffer.from('\x00\x00\x00\x18ftypmif1', 'latin1')],
      ['application/pdf', Buffer.from('%PDF-1.7\n')],
    ])('accepts a %s whose bytes say so', async (mimetype, buffer) => {
      const { service, blindpay } = makeService();
      blindpay.uploadFile.mockResolvedValue({ file_url: 'https://files/x' });

      await expect(
        service.uploadDocument(
          consumer,
          { buffer, originalname: 'doc', mimetype },
          undefined,
        ),
      ).resolves.toEqual({ file_url: 'https://files/x' });
    });

    it('refuses bytes that are not the type they were declared as', () => {
      const { service, blindpay } = makeService();
      // An HTML page wearing a passport's filename and content type: the
      // declaration is the client's word, and this is where it gets checked.
      const disguised: UploadableFile = {
        buffer: Buffer.from('<html><script>alert(1)</script></html>'),
        originalname: 'passport.png',
        mimetype: 'image/png',
      };

      expect(() =>
        service.uploadDocument(consumer, disguised, undefined),
      ).toThrow('File content is not a valid "image/png"');
      expect(blindpay.uploadFile).not.toHaveBeenCalled();
    });

    it('refuses a genuine file declared as a different allowed type', () => {
      const { service } = makeService();

      expect(() =>
        service.uploadDocument(
          consumer,
          { ...file, mimetype: 'application/pdf' },
          undefined,
        ),
      ).toThrow('File content is not a valid "application/pdf"');
    });

    it('refuses a file shorter than its signature', () => {
      const { service } = makeService();

      expect(() =>
        service.uploadDocument(
          consumer,
          { ...file, buffer: PNG_SIGNATURE.subarray(0, 3) },
          undefined,
        ),
      ).toThrow('File content is not a valid');
    });

    it('refuses a type with no signature, including one Object.prototype answers to', () => {
      const { service } = makeService();

      expect(() =>
        service.uploadDocument(
          consumer,
          { ...file, mimetype: 'constructor' },
          undefined,
        ),
      ).toThrow('File content is not a valid');
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

  it("only accepts a receiver mirrored on the caller's own instance", async () => {
    const { service, prisma, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });

    await service.initiateTos(consumer, {
      receiver_id: 're_1',
      redirect_url: 'https://app.example.com/kyc/return',
    });

    // A dev key naming a production receiver gets the same 404 as a stranger.
    expect(prisma.blindpayReceiver.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blindpayId: 're_1', consumerId: 'c_1', environment: 'dev' },
      }),
    );
  });

  it('generates a ToS idempotency key and uses a null receiver by default', async () => {
    const { service, blindpay } = makeService();
    blindpay.post.mockResolvedValue({ url: 'https://tos.example/accept' });

    await service.initiateTos(consumer, {
      redirect_url: 'https://app.example.com/kyc/return',
    });

    expect(blindpay.post).toHaveBeenCalledWith('/e/instances/in_test/tos', {
      idempotency_key: expect.any(String),
      receiver_id: null,
      redirect_url: 'https://app.example.com/kyc/return',
    });
  });

  it('proxies the rail catalog without network in the test', async () => {
    const { service, blindpay } = makeService();
    blindpay.get.mockResolvedValue({ rails: ['ach'] });

    await expect(service.listRails(consumer)).resolves.toEqual({
      rails: ['ach'],
    });
    expect(blindpay.get).toHaveBeenCalledWith('/available/rails');
  });

  it('proxies bank-detail schemas with the requested rail', async () => {
    const { service, blindpay } = makeService();
    blindpay.get.mockResolvedValue({ fields: ['routing_number'] });

    await expect(service.bankDetails(consumer, 'ach')).resolves.toEqual({
      fields: ['routing_number'],
    });
    expect(blindpay.get).toHaveBeenCalledWith('/available/bank-details', {
      query: { rail: 'ach' },
    });
  });
});
