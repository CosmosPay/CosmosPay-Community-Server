import { ApiSchema, PartialType } from '@nestjs/swagger';
import { CreateReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/create-receiver.dto';

/**
 * Partial update of a receiver. All fields optional; forwarded as-is to
 * BlindPay's `PUT /customers/{id}`.
 */
@ApiSchema({
  description:
    'Changes to a receiver: any field of the create body, all optional. `tos_id` is ignored, and once the receiver exists at BlindPay a non-admin key may change only `external_id` and `image_url`.',
})
export class UpdateReceiverDto extends PartialType(CreateReceiverDto) {}
