import { INestApplication, VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { MAX_UPLOAD_FIELD_BYTES, MAX_UPLOAD_FIELDS } from '@/kyc/kyc.constants';
import { KycMetaController } from '@/kyc/upload/kyc-meta.controller';
import { KycMetaService } from '@/kyc/upload/kyc-meta.service';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

/** `count` distinct text fields, each holding a one-byte value. */
const extraFields = (count: number, prefix = 'extra') =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${prefix}${i}`, 'x']),
  );

/**
 * The upload route's multipart limits, through real multer on a real request.
 * The options object alone proves nothing about how busboy counts — its `parts`
 * limit fires on reaching the number, not exceeding it — so the edges are
 * exercised rather than read back. No guards are mounted: the service is a
 * stub, and what is under test is what multer lets through to it.
 */
describe('KycMetaController upload limits', () => {
  let app: INestApplication;
  const meta = {
    uploadDocument: jest
      .fn()
      .mockResolvedValue({ file_url: 'https://files.example/doc' }),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [KycMetaController],
      providers: [{ provide: KycMetaService, useValue: meta }],
    }).compile();
    app = moduleRef.createNestApplication();
    app.enableVersioning({ type: VersioningType.URI });
    await app.init();
  });

  afterAll(() => app.close());

  beforeEach(() => meta.uploadDocument.mockClear());

  /** A multipart form: the text `fields`, then one PNG document. */
  function upload(fields: Record<string, string>, contentType = 'image/png') {
    let req = request(app.getHttpServer()).post('/v1/kyc/upload');
    for (const [name, value] of Object.entries(fields)) {
      req = req.field(name, value);
    }
    return req.attach('file', PNG, { filename: 'passport.png', contentType });
  }

  it('accepts the largest form the limits allow', async () => {
    // `bucket`, every spare field slot and the file. If the parts arithmetic
    // were off by one, this is the form it would refuse.
    await upload({
      bucket: 'onboarding',
      ...extraFields(MAX_UPLOAD_FIELDS - 1),
    }).expect(201);

    expect(meta.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ mimetype: 'image/png' }),
      'onboarding',
    );
  });

  it('refuses one text field more, before the service sees anything', async () => {
    await upload(extraFields(MAX_UPLOAD_FIELDS + 1)).expect(400);

    expect(meta.uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses a text field longer than the per-field cap', async () => {
    // Multer's default here was 1 MB per field, held in memory.
    await upload({ bucket: 'x'.repeat(MAX_UPLOAD_FIELD_BYTES + 1) }).expect(
      400,
    );

    expect(meta.uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses a second file', async () => {
    await upload({ bucket: 'onboarding' })
      .attach('file', PNG, { filename: 'again.png', contentType: 'image/png' })
      .expect(400);

    expect(meta.uploadDocument).not.toHaveBeenCalled();
  });

  it('refuses a declared type that is not a document', async () => {
    await upload({ bucket: 'onboarding' }, 'text/html').expect(400);

    expect(meta.uploadDocument).not.toHaveBeenCalled();
  });
});
