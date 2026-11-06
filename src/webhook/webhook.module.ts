import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import {
  WebhookController,
  WebhookNoVersionController,
  IvorypayWebhookAliasController,
  IvorypayWebhookNoVersionController,
} from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookProcessor } from './webhook.processor';
import { PaymentProcessor } from './payment.processor';
import { DepositModule } from '../deposit/deposit.module';
import { WithdrawModule } from '../withdraw/withdraw.module';
import { WebsocketModule } from '../websocket/websocket.module';
import { PaymentsModule } from '../payments/payments.module';
import { PaystackModule } from '../paystack/paystack.module';
import { IvorypayModule } from '../ivorypay/ivorypay.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaService } from '../database/prisma.service';
import { WebhookSignatureGuard } from '../common/guards/webhook-signature.guard';
import { QUEUES } from '../common/constants';
import { QrPaymentsModule } from '../qr-payments/qr-payments.module';
import { BusinessOpsModule } from '../business-ops/business-ops.module';
import { NowpaymentsModule } from '../nowpayments/nowpayments.module';

@Module({
  imports: [
    forwardRef(() => DepositModule),
    forwardRef(() => WithdrawModule),
    WebsocketModule,
    forwardRef(() => PaymentsModule),
    forwardRef(() => PaystackModule),
    forwardRef(() => IvorypayModule),
    NotificationsModule,
    QrPaymentsModule,
    forwardRef(() => BusinessOpsModule),
    NowpaymentsModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: QUEUES.WEBHOOKS,
    }),
  ],
  controllers: [
    WebhookController,
    WebhookNoVersionController,
    IvorypayWebhookAliasController,
    IvorypayWebhookNoVersionController,
  ],
  providers: [
    WebhookService,
    WebhookProcessor,
    PaymentProcessor,
    PrismaService,
    WebhookSignatureGuard,
  ],
  exports: [WebhookService],
})
export class WebhookModule {}
