import { ApiProperty, ApiSchema } from '@nestjs/swagger';
import { PLUGIN_CAPABILITIES, PLUGIN_EVENT_TYPES } from '@/plugins/sdk';

@ApiSchema({
  description:
    'One setting a plugin declares, which an installation fills in through `config`.',
})
export class PluginConfigFieldEntity {
  @ApiProperty({
    enum: ['string', 'number', 'boolean'],
    example: 'string',
    description: "The setting's JSON type.",
  })
  type!: string;

  @ApiProperty({
    example: 'API key for your account at the provider.',
    description: 'What the setting is for, as the plugin describes it.',
  })
  description!: string;

  @ApiProperty({
    example: true,
    description: 'Whether an installation must set it.',
  })
  required!: boolean;

  @ApiProperty({
    example: true,
    description: 'Sealed at rest; never returned by any route.',
  })
  secret!: boolean;
}

@ApiSchema({
  description:
    "The calling API key's installation of a plugin: what was consented to, and its settings. Secret values are never returned.",
})
export class PluginInstallationEntity {
  @ApiProperty({
    example: 'clx9z8a1b0000abcd1234efgh',
    description: 'The installation id.',
  })
  id!: string;

  @ApiProperty({
    example: '1.0.0',
    description: 'The plugin version this consent was given to.',
  })
  pluginVersion!: string;

  @ApiProperty({
    enum: PLUGIN_CAPABILITIES,
    isArray: true,
    example: ['payment_intents:read'],
    description: 'The capabilities granted at the last install.',
  })
  grantedCapabilities!: string[];

  @ApiProperty({
    enum: PLUGIN_CAPABILITIES,
    isArray: true,
    example: [],
    description:
      'Declared by the current plugin version and not granted yet. While non-empty, ' +
      'every action answers 409 plugin_not_installed: install again to consent.',
  })
  pendingCapabilities!: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {},
    description: 'Non-secret settings.',
  })
  config!: Record<string, unknown>;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      'Names of the secret settings that hold a value. Values are never returned.',
  })
  secretsSet!: string[];

  @ApiProperty({
    format: 'date-time',
    description: 'When the plugin was first installed (ISO 8601 date-time).',
  })
  createdAt!: Date;

  @ApiProperty({
    format: 'date-time',
    description: 'When the installation was last changed (ISO 8601 date-time).',
  })
  updatedAt!: Date;
}

@ApiSchema({
  description:
    "A plugin this deployment serves: its manifest, its actions and events, and the calling API key's installation of it.",
})
export class PluginEntity {
  @ApiProperty({
    example: 'example',
    description:
      'The plugin id: URL-safe, unique and permanent, as `/v1/plugins/{slug}` takes it.',
  })
  slug!: string;

  @ApiProperty({
    example: 'Example: payment notes',
    description: "The plugin's display name.",
  })
  name!: string;

  @ApiProperty({
    example: '1.0.0',
    description: "The plugin's current version (semver).",
  })
  version!: string;

  @ApiProperty({
    example:
      'Reference plugin: keeps a timeline of notes per payment intent, and adds one when it is paid.',
    description: 'What the plugin does, as its manifest describes it.',
  })
  description!: string;

  @ApiProperty({
    example: 'Cosmos Pay support',
    description:
      'Who maintains the plugin: a person, a company or a repository URL.',
  })
  author!: string;

  @ApiProperty({
    enum: PLUGIN_CAPABILITIES,
    isArray: true,
    example: ['payment_intents:read'],
    description:
      'What the plugin may do with the core. Installing grants exactly these.',
  })
  capabilities!: string[];

  @ApiProperty({
    type: [String],
    example: [],
    description: 'The only hosts the plugin can reach over HTTPS.',
  })
  egress!: string[];

  @ApiProperty({
    type: 'object',
    additionalProperties: {
      $ref: '#/components/schemas/PluginConfigFieldEntity',
    },
    example: {
      label: {
        type: 'string',
        description: 'Optional prefix for every note, e.g. your team name.',
        required: false,
        secret: false,
      },
    },
    description: 'The settings the plugin declares, by setting name.',
  })
  config!: Record<string, PluginConfigFieldEntity>;

  @ApiProperty({
    type: [String],
    example: ['get-notes'],
    description:
      'Read-only actions, run with `POST /v1/plugins/{slug}/queries/{action}`.',
  })
  queries!: string[];

  @ApiProperty({
    type: [String],
    example: ['add-note'],
    description:
      'Actions that write, run with `POST /v1/plugins/{slug}/commands/{action}`.',
  })
  commands!: string[];

  @ApiProperty({
    enum: PLUGIN_EVENT_TYPES,
    isArray: true,
    example: ['PAYMENT_INTENT_SUCCEEDED'],
    description: 'The core events the plugin handles.',
  })
  events!: string[];

  @ApiProperty({
    type: PluginInstallationEntity,
    nullable: true,
    description:
      "The calling API key's installation of the plugin; null when it is not installed.",
  })
  installation!: PluginInstallationEntity | null;
}

@ApiSchema({
  description: 'The plugins this deployment serves. Not paged.',
})
export class PluginListEntity {
  @ApiProperty({
    type: [PluginEntity],
    description: "Each plugin, with the calling API key's installation of it.",
  })
  data!: PluginEntity[];
}

@ApiSchema({
  description:
    'The answer to an uninstall: the installation and every record the plugin kept for the API key are deleted.',
})
export class PluginUninstalledEntity {
  @ApiProperty({
    example: 'example',
    description: 'The plugin uninstalled.',
  })
  slug!: string;

  @ApiProperty({ example: true, description: 'Always true.' })
  uninstalled!: true;
}

@ApiSchema({
  description: 'What a plugin query or command returned.',
})
export class PluginActionResultEntity {
  @ApiProperty({
    example: 'example',
    description: 'The slug of the plugin that ran the action.',
  })
  plugin!: string;

  @ApiProperty({
    example: 'get-notes',
    description: 'The action that ran.',
  })
  action!: string;

  @ApiProperty({
    description: 'Whatever the plugin returned, as JSON.',
    example: {
      paymentIntentId: 'clx9z8a1b0000abcd1234efgh',
      notes: [
        {
          at: '2026-09-29T12:00:00.000Z',
          text: 'Customer called',
          source: 'tenant',
        },
      ],
    },
  })
  output!: unknown;
}
