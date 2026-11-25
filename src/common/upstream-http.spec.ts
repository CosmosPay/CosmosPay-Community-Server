import { HttpStatus, Logger } from '@nestjs/common';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import {
  requestUpstreamJson,
  UpstreamNotFound,
  UpstreamStatusError,
  type UpstreamRequest,
} from '@/common/upstream-http';

const EMAIL = 'payer@example.com';

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
  });
}

describe('requestUpstreamJson', () => {
  let fetchSpy: jest.SpyInstance;
  let logger: Logger;
  let warn: jest.SpyInstance;

  const req = (extra: Partial<UpstreamRequest> = {}): UpstreamRequest => ({
    provider: 'Example Provider',
    service: 'the example service',
    keyEnv: 'EXAMPLE_KEY',
    method: 'POST',
    url: 'https://api.example.test/v1/thing',
    body: { email: EMAIL },
    timeoutMs: 1000,
    ...extra,
  });

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
    logger = new Logger('spec');
    warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('answers the parsed body of a 2xx', async () => {
    fetchSpy.mockResolvedValue(answer(200, { ok: true }));
    await expect(requestUpstreamJson(req(), logger)).resolves.toEqual({
      ok: true,
    });
  });

  it('relays a 400 reason by default, and logs it', async () => {
    fetchSpy.mockResolvedValue(answer(400, { message: 'amount too low' }));
    const error = await requestUpstreamJson(req(), logger).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).getResponse()).toMatchObject({
      code: ApiErrorCode.ProviderError,
    });
    expect(warn.mock.calls[0][0]).toContain('amount too low');
  });

  it('maps a 404 to UpstreamNotFound by default', async () => {
    fetchSpy.mockResolvedValue(answer(404, {}));
    await expect(requestUpstreamJson(req(), logger)).rejects.toBeInstanceOf(
      UpstreamNotFound,
    );
  });

  describe('with personal data', () => {
    const body = {
      errorCode: 'INVALID_OTP',
      message: `The code sent to ${EMAIL} is wrong`,
      reason: `user ${EMAIL}`,
    };

    it.each([400, 401, 403, 404, 410, 422, 429, 500])(
      'throws %i as an UpstreamStatusError for the caller to map',
      async (status) => {
        fetchSpy.mockResolvedValue(answer(status, body));
        const error = await requestUpstreamJson(
          req({ personalData: true }),
          logger,
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UpstreamStatusError);
        const failure = error as UpstreamStatusError;
        expect(failure.status).toBe(status);
        expect(failure.code).toBe('INVALID_OTP');
        expect(failure.keys).toEqual(['errorCode', 'message', 'reason']);
        expect(failure.message).not.toContain(EMAIL);
        expect(JSON.stringify(failure)).not.toContain(EMAIL);
      },
    );

    it('logs the key names and the error code, never the text', async () => {
      fetchSpy.mockResolvedValue(answer(400, body));
      await requestUpstreamJson(req({ personalData: true }), logger).catch(
        () => undefined,
      );
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain('INVALID_OTP');
      expect(line).toContain('errorCode, message, reason');
      expect(line).not.toContain(EMAIL);
      expect(line).not.toContain('wrong');
    });

    it('logs no error code that is free text', async () => {
      fetchSpy.mockResolvedValue(
        answer(400, { errorCode: `bad ${EMAIL}`, message: 'x' }),
      );
      const error = await requestUpstreamJson(
        req({ personalData: true }),
        logger,
      ).catch((e: unknown) => e);
      expect((error as UpstreamStatusError).code).toBeNull();
      expect(String(warn.mock.calls[0][0])).not.toContain(EMAIL);
    });

    it('can be asked whether the text mentions a word, without exposing it', async () => {
      fetchSpy.mockResolvedValue(
        answer(400, {
          errorCode: 'INVALID_PARAMETERS',
          reason: 'Username is required',
        }),
      );
      const error = (await requestUpstreamJson(
        req({ personalData: true }),
        logger,
      ).catch((e: unknown) => e)) as UpstreamStatusError;
      expect(error.mentions('username')).toBe(true);
      expect(error.mentions('alias')).toBe(false);
      expect(Object.values(error)).not.toContain('Username is required');
    });

    it('reads a body that is not JSON as having no keys', async () => {
      fetchSpy.mockResolvedValue(answer(502, `<html>${EMAIL}</html>`));
      const error = (await requestUpstreamJson(
        req({ personalData: true }),
        logger,
      ).catch((e: unknown) => e)) as UpstreamStatusError;
      expect(error.code).toBeNull();
      expect(error.keys).toEqual([]);
      expect(String(warn.mock.calls[0][0])).not.toContain(EMAIL);
    });

    it('keeps the timeout mapping', async () => {
      fetchSpy.mockRejectedValue(
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      );
      jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      const error = await requestUpstreamJson(
        req({ personalData: true }),
        logger,
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    });
  });
});
