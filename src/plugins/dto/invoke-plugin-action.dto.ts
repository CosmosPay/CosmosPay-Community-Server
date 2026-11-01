import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger';
import { IsObject, IsOptional } from 'class-validator';

@ApiSchema({
  description: "Request to run one of a plugin's queries or commands.",
})
export class InvokePluginActionDto {
  @ApiPropertyOptional({
    description:
      'The action input, as the plugin documents it. Plain JSON, at most 64 KiB.',
    type: 'object',
    additionalProperties: true,
    example: {
      paymentIntentId: 'clx9z8a1b0000abcd1234efgh',
      text: 'Customer called',
    },
  })
  @IsOptional()
  @IsObject()
  input?: Record<string, unknown>;
}
