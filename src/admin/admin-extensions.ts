import { Injectable } from '@nestjs/common';

/**
 * What a native plugin adds to the platform-admin overview. The admin module
 * owns `GET /v1/admin/summary` and `GET /v1/admin/consumers`, but not the rows a
 * plugin keeps — the core does not know a plugin's tables exist — so each
 * enabled plugin registers one of these and the admin service folds it in.
 */
export interface AdminExtension {
  /** The key its section is published under in the summary, e.g. `fiat`. */
  readonly key: string;
  /** Its cross-consumer section of `GET /v1/admin/summary`. */
  summary(): Promise<Record<string, unknown>>;
  /**
   * Its per-consumer resource counts, merged into each consumer's `_count` on
   * `GET /v1/admin/consumers`. A consumer with no rows may be left out.
   */
  countsByConsumer(
    consumerIds: string[],
  ): Promise<Map<string, Record<string, number>>>;
}

/**
 * The extensions registered by the plugins this deployment enabled. Plugins
 * register from `onModuleInit`; the admin service reads only when serving a
 * request, by which point every module has initialized.
 */
@Injectable()
export class AdminExtensions {
  private readonly extensions = new Map<string, AdminExtension>();

  register(extension: AdminExtension): void {
    if (this.extensions.has(extension.key)) {
      throw new Error(
        `Admin extension "${extension.key}" is registered twice: two plugins ` +
          'cannot publish the same section of the admin summary.',
      );
    }
    this.extensions.set(extension.key, extension);
  }

  list(): AdminExtension[] {
    return [...this.extensions.values()];
  }
}
