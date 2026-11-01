import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BusinessOpsModule } from '../business-ops/business-ops.module';
import { TokenizationModule } from '../tokenization/tokenization.module';
import { MarketplaceService } from './marketplace.service';
import { BusinessProjectsService } from './business-projects.service';
import { ProjectReviewService } from './project-review.service';
import { ProjectFundsService } from './project-funds.service';
import { ProjectFundsChainService } from './project-funds-chain.service';
import { ChainWalletModule } from '../chain-wallet/chain-wallet.module';
import {
  AdminProjectsController,
  BusinessProjectsController,
  MarketplaceController,
} from './project-marketplace.controller';

@Module({
  imports: [
    AuthModule,
    NotificationsModule,
    BusinessOpsModule,
    TokenizationModule,
    ChainWalletModule,
  ],
  controllers: [
    MarketplaceController,
    BusinessProjectsController,
    AdminProjectsController,
  ],
  providers: [
    MarketplaceService,
    BusinessProjectsService,
    ProjectReviewService,
    ProjectFundsService,
    ProjectFundsChainService,
  ],
  exports: [MarketplaceService, BusinessProjectsService],
})
export class ProjectMarketplaceModule {}
