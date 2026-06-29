import { PartialType } from '@nestjs/swagger';
import { CreateReceiverDto } from './create-receiver.dto';

/**
 * Partial update of a receiver. All fields optional; forwarded as-is to
 * BlindPay's `PUT /customers/{id}`.
 */
export class UpdateReceiverDto extends PartialType(CreateReceiverDto) {}
