import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponse } from '@/common/decorators/api-error-response.decorator';
import { CurrentConsumer } from '@/common/decorators/current-consumer.decorator';
import { RateLimit } from '@/common/decorators/rate-limit.decorator';
import { RequirePermissions } from '@/common/decorators/require-permissions.decorator';
import { ApiErrorCode } from '@/common/errors/api-error';
import { GatewayConsumer } from '@/common/interfaces/gateway-consumer.interface';
import { InstallPluginDto } from '@/plugins/dto/install-plugin.dto';
import { InvokePluginActionDto } from '@/plugins/dto/invoke-plugin-action.dto';
import {
  PluginActionResultEntity,
  PluginConfigFieldEntity,
  PluginEntity,
  PluginListEntity,
  PluginUninstalledEntity,
} from '@/plugins/entities/plugin.entity';
import { PluginInstallationsService } from '@/plugins/plugin-installations.service';
import { PluginRuntimeService } from '@/plugins/plugin-runtime.service';
import { PLUGIN_ACTION_RATE_LIMIT } from '@/plugins/plugins.constants';

const SLUG_PARAM = {
  name: 'slug',
  description: 'The plugin, e.g. `example`.',
  example: 'example',
};
const ACTION_PARAM = {
  name: 'action',
  description: 'An action the plugin lists under `queries` / `commands`.',
  example: 'get-notes',
};

/**
 * Plugins: compiled-in extensions that reach the core only through the
 * capabilities a tenant grants them (see `src/plugins/sdk.ts`).
 *
 * No route here admits the shared public key: a plugin acts on one tenant's
 * data, and the public key is every anonymous caller at once.
 */
// URI versioning => /v1/plugins
@ApiTags('plugins')
@ApiExtraModels(PluginConfigFieldEntity)
@Controller({ path: 'plugins', version: '1' })
export class PluginsController {
  constructor(
    private readonly installations: PluginInstallationsService,
    private readonly runtime: PluginRuntimeService,
  ) {}

  @Get()
  @RequirePermissions('plugins:read')
  @ApiOperation({
    summary:
      'List the plugins this deployment serves, with this key’s installations',
  })
  @ApiOkResponse({ type: PluginListEntity })
  list(@CurrentConsumer() consumer: GatewayConsumer) {
    return this.installations.list(consumer);
  }

  @Get(':slug')
  @RequirePermissions('plugins:read')
  @ApiOperation({
    summary: 'Describe a plugin: capabilities, egress, settings, actions',
  })
  @ApiParam(SLUG_PARAM)
  @ApiOkResponse({ type: PluginEntity })
  describe(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('slug') slug: string,
  ) {
    return this.installations.describe(consumer, slug);
  }

  @Put(':slug/installation')
  @RequirePermissions('plugins:write')
  @ApiOperation({
    summary:
      'Install a plugin (or re-consent / reconfigure it), granting its capabilities',
  })
  @ApiParam(SLUG_PARAM)
  @ApiOkResponse({ type: PluginEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.PluginConsentMismatch],
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        message: ['config.apiKey is required'],
        path: '/v1/plugins/example/installation',
      },
    },
  })
  install(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('slug') slug: string,
    @Body() dto: InstallPluginDto,
  ) {
    return this.installations.install(consumer, slug, dto);
  }

  @Delete(':slug/installation')
  @RequirePermissions('plugins:write')
  @ApiOperation({
    summary: 'Uninstall a plugin and delete every record it kept for this key',
  })
  @ApiParam(SLUG_PARAM)
  @ApiOkResponse({ type: PluginUninstalledEntity })
  uninstall(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('slug') slug: string,
  ) {
    return this.installations.uninstall(consumer, slug);
  }

  @Post(':slug/queries/:action')
  @HttpCode(200)
  @RequirePermissions('plugins:read')
  @RateLimit(PLUGIN_ACTION_RATE_LIMIT)
  @ApiOperation({ summary: 'Run a read-only plugin action' })
  @ApiParam(SLUG_PARAM)
  @ApiParam(ACTION_PARAM)
  @ApiOkResponse({ type: PluginActionResultEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.PluginRejected],
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        message: 'input must be at most 65536 bytes as JSON',
        path: '/v1/plugins/example/queries/get-notes',
      },
    },
  })
  @ApiErrorResponse({ status: 409, codes: [ApiErrorCode.PluginNotInstalled] })
  @ApiErrorResponse({
    status: 502,
    codes: [ApiErrorCode.PluginFailed],
    examples: {
      [ApiErrorCode.PluginFailed]: {
        message: 'Plugin example failed while handling get-notes.',
        path: '/v1/plugins/example/queries/get-notes',
      },
    },
  })
  @ApiErrorResponse({
    status: 504,
    codes: [ApiErrorCode.PluginFailed],
    examples: {
      [ApiErrorCode.PluginFailed]: {
        summary: 'The plugin ran out of time',
        message: 'Plugin example did not respond in time.',
        path: '/v1/plugins/example/queries/get-notes',
      },
    },
  })
  query(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('slug') slug: string,
    @Param('action') action: string,
    @Body() dto: InvokePluginActionDto,
  ) {
    return this.runtime.invoke(consumer, slug, 'query', action, dto.input);
  }

  @Post(':slug/commands/:action')
  @HttpCode(200)
  @RequirePermissions('plugins:write')
  @RateLimit(PLUGIN_ACTION_RATE_LIMIT)
  @ApiOperation({ summary: 'Run a plugin action that writes' })
  @ApiParam(SLUG_PARAM)
  @ApiParam({ ...ACTION_PARAM, example: 'add-note' })
  @ApiOkResponse({ type: PluginActionResultEntity })
  @ApiErrorResponse({
    status: 400,
    codes: [ApiErrorCode.ValidationFailed, ApiErrorCode.PluginRejected],
    examples: {
      [ApiErrorCode.ValidationFailed]: {
        message: 'input must be at most 65536 bytes as JSON',
        path: '/v1/plugins/example/queries/get-notes',
      },
    },
  })
  @ApiErrorResponse({
    status: 409,
    codes: [ApiErrorCode.PluginNotInstalled, ApiErrorCode.PluginQuotaExceeded],
  })
  @ApiErrorResponse({ status: 502, codes: [ApiErrorCode.PluginFailed] })
  @ApiErrorResponse({
    status: 504,
    codes: [ApiErrorCode.PluginFailed],
    examples: {
      [ApiErrorCode.PluginFailed]: {
        summary: 'The plugin ran out of time',
        message: 'Plugin example did not respond in time.',
      },
    },
  })
  command(
    @CurrentConsumer() consumer: GatewayConsumer,
    @Param('slug') slug: string,
    @Param('action') action: string,
    @Body() dto: InvokePluginActionDto,
  ) {
    return this.runtime.invoke(consumer, slug, 'command', action, dto.input);
  }
}
