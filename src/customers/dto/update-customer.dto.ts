import { PartialType } from '@nestjs/swagger';
import { CreateCustomerDto } from '@/customers/dto/create-customer.dto';

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {}
