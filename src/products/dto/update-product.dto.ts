import { PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';

// All fields optional — patch any subset of a product.
export class UpdateProductDto extends PartialType(CreateProductDto) {}
