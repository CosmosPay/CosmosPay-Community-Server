import { ApiProperty } from '@nestjs/swagger';

export class PublicKeyEntity {
  @ApiProperty({ enum: ['dev', 'prod'], example: 'dev' })
  env!: 'dev' | 'prod';

  @ApiProperty({
    example:
      'dv_4f1c9a7e0b2d6c8e3a5f7b9d1e3c5a7f9b1d3e5c7a9f1b3d5e7c9a1f3b5d7e9c',
    description:
      'The shared key every wallet without an account of its own presents. ' +
      'Not a secret: it ships inside an open-source wallet, and what it may ' +
      'reach is confined server-side to the routes marked for it.',
  })
  apiKey!: string;
}
