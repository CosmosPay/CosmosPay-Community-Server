import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, PluginInstallation } from '@generated/prisma/client';
import { ApiError, ApiErrorCode } from '@/common/errors/api-error';
import type { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { openJson, sealJson } from '@/common/sealed-box';
import { ConsumerResolverService } from '@/common/services/consumer-resolver.service';
import type { AppConfig } from '@/config/configuration';
import { PrismaService } from '@/prisma/prisma.service';
import { InstallPluginDto } from '@/plugins/dto/install-plugin.dto';
import { effectiveGrant, parsePluginConfig } from '@/plugins/plugin-manifest';
import { PluginRegistryService } from '@/plugins/plugin-registry.service';
import { PLUGIN_SECRET_PURPOSE_PREFIX } from '@/plugins/plugins.constants';
import type {
  PluginCapability,
  PluginConfigValue,
  PluginDefinition,
} from '@/plugins/sdk';

/** What an installation looks like to the tenant. Secrets are named, never shown. */
export interface PluginInstallationView {
  id: string;
  pluginVersion: string;
  grantedCapabilities: string[];
  /** Declared by the current version and not yet consented to. Non-empty = calls refused. */
  pendingCapabilities: string[];
  config: Record<string, PluginConfigValue>;
  secretsSet: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PluginView {
  slug: string;
  name: string;
  version: string;
  description: string;
  author: string;
  capabilities: string[];
  egress: string[];
  config: Record<
    string,
    { type: string; description: string; required: boolean; secret: boolean }
  >;
  queries: string[];
  commands: string[];
  events: string[];
  installation: PluginInstallationView | null;
}

/** What the runtime needs to run one installation's code. */
export interface ResolvedInstallation {
  id: string;
  granted: ReadonlySet<PluginCapability>;
  config: Readonly<Record<string, PluginConfigValue>>;
}

/**
 * A consumer's installations of plugins — the `plugin_installation` table, and
 * its only writer.
 *
 * Installing is consent. The tenant names the capabilities it grants, and they
 * must be exactly the ones the plugin declares: no partial grant, because a
 * plugin written against its whole manifest would fail in ways its author never
 * saw; no silent grant, because a tenant has to have read the list to repeat it.
 */
@Injectable()
export class PluginInstallationsService {
  private readonly logger = new Logger(PluginInstallationsService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly consumers: ConsumerResolverService,
    private readonly registry: PluginRegistryService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.secret = config.get('plugins', { infer: true }).secret;
  }

  async list(consumer: GatewayConsumer): Promise<{ data: PluginView[] }> {
    const installations = await this.prisma.pluginInstallation.findMany({
      where: { consumer: { apisixUsername: consumer.username } },
    });
    const bySlug = new Map(installations.map((i) => [i.pluginSlug, i]));
    return {
      data: this.registry
        .list()
        .map((plugin) => this.view(plugin, bySlug.get(plugin.slug) ?? null)),
    };
  }

  async describe(consumer: GatewayConsumer, slug: string): Promise<PluginView> {
    const plugin = this.requirePlugin(slug);
    return this.view(plugin, await this.find(consumer.username, slug));
  }

  async install(
    consumer: GatewayConsumer,
    slug: string,
    dto: InstallPluginDto,
  ): Promise<PluginView> {
    const plugin = this.requirePlugin(slug);

    const declared = [...plugin.capabilities].sort();
    const granted = [...new Set(dto.grantCapabilities)].sort();
    if (
      granted.length !== dto.grantCapabilities.length ||
      declared.join(',') !== granted.join(',')
    ) {
      throw ApiError.badRequest(
        ApiErrorCode.PluginConsentMismatch,
        `grantCapabilities must be exactly the capabilities ${slug} declares: ` +
          (declared.join(', ') || '(none)'),
      );
    }

    // A secret the tenant does not resend is kept: re-consenting after an
    // upgrade must not mean digging the third party's API key out again.
    const existing = await this.find(consumer.username, slug);
    const previousSecrets = existing ? this.openSecrets(plugin, existing) : {};
    const raw: Record<string, unknown> = { ...(dto.config ?? {}) };
    for (const [name, field] of Object.entries(plugin.config ?? {})) {
      if (field.secret && raw[name] === undefined && previousSecrets[name]) {
        raw[name] = previousSecrets[name];
      }
    }
    const parsed = parsePluginConfig(plugin, raw);
    if (!parsed.ok) {
      throw ApiError.badRequest(ApiErrorCode.ValidationFailed, parsed.errors);
    }

    const sealedSecrets =
      Object.keys(parsed.value.secret).length > 0
        ? sealJson(parsed.value.secret, this.secret, this.purpose(slug))
        : null;
    const local = await this.consumers.resolve(consumer);
    const data = {
      pluginVersion: plugin.version,
      grantedCapabilities: granted,
      config: parsed.value.plain as Prisma.InputJsonValue,
      sealedSecrets,
    };
    const installation = await this.prisma.pluginInstallation.upsert({
      where: {
        consumerId_pluginSlug: { consumerId: local.id, pluginSlug: slug },
      },
      create: { consumerId: local.id, pluginSlug: slug, ...data },
      update: data,
    });

    this.logger.log(
      `Consumer ${consumer.username} installed ${slug}@${plugin.version} ` +
        `granting [${granted.join(', ')}]`,
    );
    return this.view(plugin, installation);
  }

  /**
   * Removes the installation and, by cascade, every record the plugin kept.
   *
   * Deliberately does not require the plugin to be served: a deployment that
   * disables a plugin must not leave its tenants unable to delete what that
   * plugin stored about them.
   */
  async uninstall(
    consumer: GatewayConsumer,
    slug: string,
  ): Promise<{ slug: string; uninstalled: true }> {
    const { count } = await this.prisma.pluginInstallation.deleteMany({
      where: {
        pluginSlug: slug,
        consumer: { apisixUsername: consumer.username },
      },
    });
    if (count === 0) {
      throw ApiError.notFound(`Plugin ${slug} is not installed`);
    }
    this.logger.log(`Consumer ${consumer.username} uninstalled ${slug}`);
    return { slug, uninstalled: true };
  }

  /**
   * The installation a request may run, or `409 plugin_not_installed` — also
   * when the tenant consented to an older version that asked for less.
   */
  async resolve(
    consumerUsername: string,
    plugin: PluginDefinition,
  ): Promise<ResolvedInstallation> {
    const installation = await this.find(consumerUsername, plugin.slug);
    const resolved = installation
      ? this.toResolved(plugin, installation)
      : null;
    if (!resolved) {
      throw ApiError.conflict(
        ApiErrorCode.PluginNotInstalled,
        installation
          ? `Plugin ${plugin.slug} was updated and asks for capabilities this installation has not granted. ` +
              `Install it again with PUT /v1/plugins/${plugin.slug}/installation.`
          : `Plugin ${plugin.slug} is not installed. Install it with PUT /v1/plugins/${plugin.slug}/installation.`,
      );
    }
    return resolved;
  }

  /** The consumer's runnable installations of these plugins, for event delivery. */
  async resolveAll(
    consumerUsername: string,
    plugins: readonly PluginDefinition[],
  ): Promise<
    {
      plugin: PluginDefinition;
      installation: ResolvedInstallation;
      /** The consumer's stored credential id — see `PluginRuntimeService.dispatchEvent`. */
      credentialId: string | null;
    }[]
  > {
    if (plugins.length === 0) return [];
    const rows = await this.prisma.pluginInstallation.findMany({
      where: {
        consumer: { apisixUsername: consumerUsername },
        pluginSlug: { in: plugins.map((p) => p.slug) },
      },
      include: { consumer: { select: { credentialId: true } } },
    });
    const bySlug = new Map(plugins.map((p) => [p.slug, p]));
    return rows.flatMap((row) => {
      const plugin = bySlug.get(row.pluginSlug);
      const installation = plugin ? this.toResolved(plugin, row) : null;
      return plugin && installation
        ? [{ plugin, installation, credentialId: row.consumer.credentialId }]
        : [];
    });
  }

  private toResolved(
    plugin: PluginDefinition,
    row: PluginInstallation,
  ): ResolvedInstallation | null {
    const grant = effectiveGrant(plugin, row.grantedCapabilities);
    if (grant.missing.length > 0) return null;
    return {
      id: row.id,
      granted: new Set(grant.capabilities),
      config: Object.freeze({
        ...(row.config as Record<string, PluginConfigValue>),
        ...this.openSecrets(plugin, row),
      }),
    };
  }

  private find(
    consumerUsername: string,
    slug: string,
  ): Promise<PluginInstallation | null> {
    return this.prisma.pluginInstallation.findFirst({
      where: {
        pluginSlug: slug,
        consumer: { apisixUsername: consumerUsername },
      },
    });
  }

  private requirePlugin(slug: string): PluginDefinition {
    const plugin = this.registry.get(slug);
    if (!plugin) throw ApiError.notFound(`Plugin ${slug} not found`);
    return plugin;
  }

  private purpose(slug: string): string {
    return `${PLUGIN_SECRET_PURPOSE_PREFIX}${slug}`;
  }

  private openSecrets(
    plugin: PluginDefinition,
    row: PluginInstallation,
  ): Record<string, string> {
    if (!row.sealedSecrets || !this.secret) return {};
    const opened = openJson<Record<string, string>>(
      row.sealedSecrets,
      this.secret,
      this.purpose(plugin.slug),
    );
    if (!opened) {
      // PLUGINS_SECRET changed, or the row was edited. The plugin runs without
      // its secrets and the tenant re-enters them; a guess would be worse.
      this.logger.warn(
        `Installation ${row.id} of ${plugin.slug}: sealed secrets do not open`,
      );
      return {};
    }
    return opened;
  }

  private view(
    plugin: PluginDefinition,
    row: PluginInstallation | null,
  ): PluginView {
    return {
      slug: plugin.slug,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      author: plugin.author,
      capabilities: [...plugin.capabilities],
      egress: [...(plugin.egress ?? [])],
      config: Object.fromEntries(
        Object.entries(plugin.config ?? {}).map(([name, field]) => [
          name,
          {
            type: field.type,
            description: field.description,
            required: field.required ?? false,
            secret: field.secret ?? false,
          },
        ]),
      ),
      queries: Object.keys(plugin.queries ?? {}),
      commands: Object.keys(plugin.commands ?? {}),
      events: Object.keys(plugin.events ?? {}),
      installation: row
        ? {
            id: row.id,
            pluginVersion: row.pluginVersion,
            grantedCapabilities: row.grantedCapabilities,
            pendingCapabilities: effectiveGrant(plugin, row.grantedCapabilities)
              .missing,
            config: row.config as Record<string, PluginConfigValue>,
            secretsSet: Object.keys(this.openSecrets(plugin, row)),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }
        : null,
    };
  }
}
