import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { NotificationsModule } from '../notifications/notifications.module';
import { TurnstileService } from '../common/services/turnstile.service';
import { TurnstileGuard } from '../common/guards/turnstile.guard';
import { requireJwtAccessSecret } from './jwt-secret';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
  inject: [ConfigService],
  useFactory: (cfg: ConfigService) => ({
    secret: requireJwtAccessSecret(cfg),
    signOptions: {
      expiresIn: '15m' as const,
    },
  }),
}),
    NotificationsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, TurnstileService, TurnstileGuard],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}