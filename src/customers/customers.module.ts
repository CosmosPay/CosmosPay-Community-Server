import { Module } from '@nestjs/common';
import { CustomersController } from '@/customers/customers.controller';
import { CustomersService } from '@/customers/customers.service';

@Module({
  controllers: [CustomersController],
  providers: [CustomersService],
  // Payment intents record a settled payment's payer through this service
  // instead of writing the customer table themselves.
  exports: [CustomersService],
})
export class CustomersModule {}
