import { Module } from '@nestjs/common';
import { AliasChallengeSweeperService } from '@/aliases/alias-challenge-sweeper.service';
import { AliasesController } from '@/aliases/aliases.controller';
import { AliasesService } from '@/aliases/aliases.service';

@Module({
  controllers: [AliasesController],
  providers: [AliasesService, AliasChallengeSweeperService],
  // Exported so a payment flow can resolve a handle before building an envelope
  // without going back out through HTTP.
  exports: [AliasesService],
})
export class AliasesModule {}
