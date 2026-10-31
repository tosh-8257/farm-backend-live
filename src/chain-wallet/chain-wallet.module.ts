import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AlgorandWalletClient } from './algorand-wallet.client';
import { RateService } from './rate.service';
import { ChainWalletService } from './chain-wallet.service';
import { ChainSyncService } from './chain-sync.service';
import { FeeTopupService } from './fee-topup.service';
import { BusinessChainService } from './business-chain.service';
import {
  AdminChainController,
  ChainWalletController,
} from './chain-wallet.controller';

@Module({
  // RolesGuard on the controllers needs JwtService (exported by AuthModule).
  imports: [AuthModule],
  controllers: [ChainWalletController, AdminChainController],
  providers: [
    ChainWalletService,
    ChainSyncService,
    FeeTopupService,
    BusinessChainService,
    AlgorandWalletClient,
    RateService,
  ],
  exports: [
    ChainWalletService,
    ChainSyncService,
    FeeTopupService,
    BusinessChainService,
    AlgorandWalletClient,
  ],
})
export class ChainWalletModule {}
