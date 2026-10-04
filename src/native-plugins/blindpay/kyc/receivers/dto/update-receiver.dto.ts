import { PartialType } from '@nestjs/swagger';
import { CreateReceiverDto } from '@/native-plugins/blindpay/kyc/receivers/dto/create-receiver.dto';

/**
 * Partial update of a receiver. All fields optional; forwarded as-is to
 * BlindPay's `PUT /customers/{id}`.
 */
export class UpdateReceiverDto extends PartialType(CreateReceiverDto) {}
