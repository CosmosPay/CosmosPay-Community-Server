import { ApiProperty } from '@nestjs/swagger';
import { PLUGIN_CAPABILITIES, PLUGIN_EVENT_TYPES } from '@/plugins/sdk';

export class PluginConfigFieldEntity {
  @ApiProperty({ enum: ['string', 'number', 'boolean'], example: 'string' })
  type!: string;

  @ApiProperty({ example: 'API key for your account at the provider.' })
  description!: string;

  @ApiProperty({ example: true })
  required!: boolean;

  @ApiProperty({
    example: true,
    description: 'Sealed at rest; never returned by any route.',
  })
  secret!: boolean;
}

export class PluginInstallationEntity {
  @ApiProperty({ example: 'clx9z8a1b0000abcd1234efgh' })
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

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class PluginEntity {
  @ApiProperty({ example: 'example' })
  slug!: string;

  @ApiProperty({ example: 'Example: payment notes' })
  name!: string;

  @ApiProperty({ example: '1.0.0' })
  version!: string;

  @ApiProperty({
    example:
      'Reference plugin: keeps a timeline of notes per payment intent, and adds one when it is paid.',
  })
  description!: string;

  @ApiProperty({ example: 'Cosmos Pay support' })
  author!: string;

  @ApiProperty({
    enum: PLUGIN_CAPABILITIES,
    isArray: true,
    example: ['payment_intents:read'],
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
  })
  config!: Record<string, PluginConfigFieldEntity>;

  @ApiProperty({ type: [String], example: ['get-notes'] })
  queries!: string[];

  @ApiProperty({ type: [String], example: ['add-note'] })
  commands!: string[];

  @ApiProperty({
    enum: PLUGIN_EVENT_TYPES,
    isArray: true,
    example: ['PAYMENT_INTENT_SUCCEEDED'],
  })
  events!: string[];

  @ApiProperty({ type: PluginInstallationEntity, nullable: true })
  installation!: PluginInstallationEntity | null;
}

export class PluginListEntity {
  @ApiProperty({ type: [PluginEntity] })
  data!: PluginEntity[];
}

export class PluginUninstalledEntity {
  @ApiProperty({ example: 'example' })
  slug!: string;

  @ApiProperty({ example: true })
  uninstalled!: true;
}

export class PluginActionResultEntity {
  @ApiProperty({ example: 'example' })
  plugin!: string;

  @ApiProperty({ example: 'get-notes' })
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
