import { Module } from '@nestjs/common';
import { DefindexController } from '@/defindex/defindex.controller';
import { DefindexService } from '@/defindex/defindex.service';

@Module({ controllers: [DefindexController], providers: [DefindexService] })
export class DefindexModule {}
