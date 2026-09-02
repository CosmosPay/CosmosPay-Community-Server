import { Module } from '@nestjs/common';
import { CustomersController } from '@/customers/customers.controller';
import { CustomersService } from '@/customers/customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
})
export class CustomersModule {}
