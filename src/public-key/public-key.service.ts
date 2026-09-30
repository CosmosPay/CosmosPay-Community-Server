import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '@/config/configuration';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';

@Injectable()
export class PublicKeyService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  /**
   * The shared key for one environment, or a 503 when this deployment publishes
   * none. Never an empty string: that would read as a valid answer and surface
   * as a 401 later, far from the cause.
   */
  get(env: 'dev' | 'prod'): string {
    const key = this.config.get('publicKeys', { infer: true })[env];
    if (!key) {
      throw ApiError.unavailable(
        ApiErrorCode.Misconfigured,
        `No public key is published for the ${env} environment: set PUBLIC_API_KEY_${env.toUpperCase()}.`,
      );
    }
    return key;
  }
}
