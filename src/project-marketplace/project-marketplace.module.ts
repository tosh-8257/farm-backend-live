import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { BusinessOpsModule } from '../business-ops/business-ops.module';
import { TokenizationModule } from '../tokenization/tokenization.module';
import { MarketplaceService } from './marketplace.service';
import { BusinessProjectsService } from './business-projects.service';
import { ProjectReviewService } from './project-review.service';
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
  ],
  exports: [MarketplaceService, BusinessProjectsService],
})
export class ProjectMarketplaceModule {}
