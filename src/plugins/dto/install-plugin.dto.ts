import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export class InstallPluginDto {
  @ApiProperty({
    description:
      'Consent: exactly the capabilities the plugin declares (see GET /v1/plugins/{slug}). ' +
      'A partial or extra list is refused, so installing means having read it.',
    example: ['payment_intents:read'],
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  grantCapabilities!: string[];

  @ApiPropertyOptional({
    description:
      'Settings, as the plugin declares them. Secret fields are sealed at rest and never ' +
      'returned; leave one out on a re-install to keep the value already stored.',
    type: 'object',
    additionalProperties: true,
    example: { label: 'ops' },
  })
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;
}
