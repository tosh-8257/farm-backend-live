import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BusinessOpsModule } from '../business-ops/business-ops.module';
import { ChainWalletModule } from '../chain-wallet/chain-wallet.module';
import { AlgorandAsaClient } from './algorand-asa.client';
import { TokenizationService } from './tokenization.service';
import { TokenDeliveryService } from './token-delivery.service';
import { TokenBuybackService } from './token-buyback.service';
import {
  AdminTokenBuybackController,
  AdminTokenizationController,
  TokenBuybackController,
  TokenizationController,
} from './tokenization.controller';

@Module({
  imports: [AuthModule, BusinessOpsModule, ChainWalletModule],
  controllers: [
    TokenizationController,
    AdminTokenizationController,
    TokenBuybackController,
    AdminTokenBuybackController,
  ],
  providers: [
    TokenizationService,
    AlgorandAsaClient,
    TokenDeliveryService,
    TokenBuybackService,
  ],
  exports: [TokenizationService, TokenDeliveryService],
})
export class TokenizationModule {}
