import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BlindpayClient, UploadableFile } from '@/blindpay/blindpay.client';
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
    blindpay as unknown as BlindpayClient,
    config as unknown as ConfigService<AppConfig, true>,
    prisma as unknown as PrismaService,
    consumers as unknown as ConsumerResolverService,
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

      expect(() => service.uploadDocument(disguised, undefined)).toThrow(
        'File content is not a valid "image/png"',
      );
      expect(blindpay.uploadFile).not.toHaveBeenCalled();
    });

    it('refuses a genuine file declared as a different allowed type', () => {
      const { service } = makeService();

      expect(() =>
        service.uploadDocument(
          { ...file, mimetype: 'application/pdf' },
          undefined,
        ),
      ).toThrow('File content is not a valid "application/pdf"');
    });

    it('refuses a file shorter than its signature', () => {
      const { service } = makeService();

      expect(() =>
        service.uploadDocument(
          { ...file, buffer: PNG_SIGNATURE.subarray(0, 3) },
          undefined,
        ),
      ).toThrow('File content is not a valid');
    });

    it('refuses a type with no signature, including one Object.prototype answers to', () => {
      const { service } = makeService();

      expect(() =>
        service.uploadDocument({ ...file, mimetype: 'constructor' }, undefined),
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
