import { ApiSchema, PartialType } from '@nestjs/swagger';
import { CreateProductDto } from '@/products/dto/create-product.dto';

// All fields optional — patch any subset of a product.
@ApiSchema({
  description:
    'Changes to a product: any subset of the create fields; only the fields sent change.',
})
export class UpdateProductDto extends PartialType(CreateProductDto) {}
