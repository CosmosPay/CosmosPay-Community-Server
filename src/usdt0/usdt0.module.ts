import { Module } from '@nestjs/common';
import { LayerZeroScanClient } from '@/usdt0/layerzero-scan.client';
import { Usdt0OftClient } from '@/usdt0/usdt0-oft.client';
import { Usdt0TransferTracker } from '@/usdt0/usdt0-transfer-tracker.service';
import { Usdt0Controller } from '@/usdt0/usdt0.controller';
import { Usdt0Service } from '@/usdt0/usdt0.service';

@Module({
  controllers: [Usdt0Controller],
  providers: [
    Usdt0Service,
    Usdt0OftClient,
    Usdt0TransferTracker,
    LayerZeroScanClient,
  ],
})
export class Usdt0Module {}
