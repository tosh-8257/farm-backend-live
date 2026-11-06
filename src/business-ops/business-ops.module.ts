import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WalletsModule } from '../wallets/wallets.module';
import { EscrowModule } from '../escrow/escrow.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QrPaymentsModule } from '../qr-payments/qr-payments.module';
import { CurrencyModule } from '../currency/currency.module';
import { BusinessWebCheckoutService } from './business-web-checkout.service';
import { BusinessWebCheckoutController } from './business-web-checkout.controller';
import { BusinessAccessService } from './business-access.service';
import { BusinessTeamService } from './business-team.service';
import { BusinessFinanceService } from './business-finance.service';
import { BusinessCommerceService } from './business-commerce.service';
import { BusinessEscrowService } from './business-escrow.service';
import { BusinessWebhooksService } from './business-webhooks.service';
import {
  BusinessOpsController,
  BusinessPayController,
} from './business-ops.controller';

@Module({
  imports: [
    AuthModule,
    WalletsModule,
    EscrowModule,
    NotificationsModule,
    QrPaymentsModule,
    CurrencyModule,
  ],
  controllers: [
    BusinessOpsController,
    BusinessPayController,
    BusinessWebCheckoutController,
  ],
  providers: [
    BusinessAccessService,
    BusinessTeamService,
    BusinessFinanceService,
    BusinessCommerceService,
    BusinessEscrowService,
    BusinessWebhooksService,
    BusinessWebCheckoutService,
  ],
  exports: [
    BusinessAccessService,
    BusinessFinanceService,
    BusinessCommerceService,
    BusinessEscrowService,
    BusinessWebhooksService,
    BusinessWebCheckoutService,
  ],
})
export class BusinessOpsModule {}
