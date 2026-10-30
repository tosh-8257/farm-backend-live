import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { DatabaseModule } from './database/database.module';
import { PrismaModule } from './database/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { CacheModule } from './common/cache/cache.module';
import { CacheInterceptor } from './common/interceptors/cache.interceptor';
import { EncryptionModule } from './common/encryption/encryption.module';
import { AuditModule } from './common/audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';
import { DepositModule } from './deposit/deposit.module';
import { WithdrawModule } from './withdraw/withdraw.module';
import { PaymentsModule } from './payments/payments.module';
import { PaystackModule } from './paystack/paystack.module';
import { IvorypayModule } from './ivorypay/ivorypay.module';
import { WebhookModule } from './webhook/webhook.module';
import { InvestmentsModule } from './investments/investments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SecurityModule } from './security/security.module';
import { KycModule } from './kyc/kyc.module';
import { HealthModule } from './health/health.module';
import { ProjectsModule } from './projects/projects.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { AdminModule } from './admin/admin.module';
import { MerchantsModule } from './merchants/merchants.module';
import { SettingsModule } from './settings/settings.module';
import { StkPushModule } from './stk/stk.module';
import { TransactionsModule } from './transactions/transactions.module';
import { BlockchainModule } from './blockchain/blockchain.module';
import { QrModule } from './qr/qr.module';
import { QrPaymentsModule } from './qr-payments/qr-payments.module';
import { WebsocketModule } from './websocket/websocket.module';
import { EscrowModule } from './escrow/escrow.module';
import { TransferRequestsModule } from './transfer-requests/transfer-requests.module';
import { PaymentRequestsModule } from './payment-requests/payment-requests.module';
import { SupportModule } from './support/support.module';
import { UploadsModule } from './uploads/uploads.module';
import { DiditModule } from './didit/didit.module';
import { ExpiryTasksService } from './common/tasks/expiry-tasks.service';
import { IdempotencyMiddleware } from './common/middleware/idempotency.middleware';
@Module({
  imports: [
    EncryptionModule,
    AuditModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV === 'production'
          ? ['.env.production']
          : ['.env.production', '.env'],
      ignoreEnvFile: false,
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        throttlers: [
          {
            // Default raised from 20 to 100 req/min per IP: the old 60 ms window meant
            // no effective limit, and 20/min would throttle normal app usage.
            limit: Number(cfg.get<string>('RATE_LIMIT')) || 100,
            // RATE_LIMIT_TTL is expressed in seconds; @nestjs/throttler v6 expects ms.
            ttl: (Number(cfg.get<string>('RATE_LIMIT_TTL')) || 60) * 1000,
          },
        ],
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (cfg: ConfigService) => {
        const redisUrl = cfg.get<string>('REDIS_URL')?.trim();
        if (!redisUrl) {
          throw new Error(
            'REDIS_URL is required for Bull queue processing. Configure an external managed Redis URL.',
          );
        }

        return {
          redis: redisUrl,
          defaultJobOptions: {
            removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
            removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
          },
        };
      },
    }),
    BullModule.registerQueue({ name: 'expiry-tasks' }),
    DatabaseModule,
    PrismaModule,
    RedisModule,
    CacheModule,
    AuthModule,
    UsersModule,
    WalletsModule,
    DepositModule,
    WithdrawModule,
    PaymentsModule,
    PaystackModule,
    IvorypayModule,
    WebhookModule,
    NotificationsModule,
    SecurityModule,
    KycModule,
    HealthModule,
    InvestmentsModule,
    ProjectsModule,
    AnalyticsModule,
    AdminModule,
    MerchantsModule,
    SettingsModule,
    StkPushModule,
    TransactionsModule,
    BlockchainModule,
    QrModule,
    QrPaymentsModule,
    WebsocketModule,
    EscrowModule,
    TransferRequestsModule,
    PaymentRequestsModule,
    SupportModule,
    UploadsModule,
    DiditModule,
  ],
  providers: [
    ExpiryTasksService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CacheInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(IdempotencyMiddleware).forRoutes('*path');
  }
}
