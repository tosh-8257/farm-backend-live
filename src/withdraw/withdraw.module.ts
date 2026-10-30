import { forwardRef, Module } from '@nestjs/common';
import { WithdrawController } from './withdraw.controller';
import { WithdrawService } from './withdraw.service';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { PaystackModule } from '../paystack/paystack.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SecurityModule } from '../security/security.module';
import { CurrencyModule } from '../currency/currency.module';
import { KycGuard } from '../common/guards/kyc.guard';
import { WebsocketModule } from '../websocket/websocket.module';
import { NowpaymentsModule } from '../nowpayments/nowpayments.module';

@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    forwardRef(() => PaystackModule),
    NotificationsModule,
    SecurityModule,
    CurrencyModule,
    WebsocketModule,
    NowpaymentsModule,
  ],
  controllers: [WithdrawController],
  providers: [WithdrawService, KycGuard],
  exports: [WithdrawService],
})
export class WithdrawModule {}