import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApiErrorCode } from '@/common/errors/api-error';
import { PublicKeyService } from '@/public-key/public-key.service';

function makeService(keys: { dev: string; prod: string }) {
  const config = {
    get: jest.fn().mockReturnValue(keys),
  } as unknown as ConfigService<AppConfig, true>;
  return new PublicKeyService(config);
}

describe('PublicKeyService', () => {
  it('serves the configured key for each environment', () => {
    const service = makeService({ dev: 'dv_x', prod: 'prod_y' });
    expect(service.get('dev')).toBe('dv_x');
    expect(service.get('prod')).toBe('prod_y');
  });

  /* An empty string would read as a key and fail later as a 401, far from the cause. */
  it('is a 503 for an environment with no key, never an empty answer', () => {
    const service = makeService({ dev: 'dv_x', prod: '' });
    expect(() => service.get('prod')).toThrow(
      expect.objectContaining({ code: ApiErrorCode.Misconfigured }),
    );
  });
});
