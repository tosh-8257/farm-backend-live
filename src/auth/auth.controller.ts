
import {
  Controller,
  Post,
  Delete,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  UnauthorizedException,
  BadRequestException,
  Param,
  Get,
  Query,
  ExecutionContext,
} from '@nestjs/common';

import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
} from '@nestjs/swagger';

import type { Request } from 'express';

import { Throttle } from '@nestjs/throttler';

import { AuthService } from './auth.service';
import {
  DeviceTokenDto,
  ResendEmailVerificationDto,
  ResendOtpDto,
  ResolveLoginEmailDto,
} from './dto/auth-misc.dto';

import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { FirebaseLoginDto } from './dto/firebase-login.dto';
import { VerifyPhoneDto } from './dto/verify-phone.dto';
import { SupabaseAuthDto } from './dto/supabase-auth.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { SetPinDto } from './dto/set-pin.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import { ResetPinDto } from './dto/reset-pin.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import { AdminPasswordResetCompleteDto } from './dto/admin-password-reset-complete.dto';

import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';

import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Permissions } from '../common/decorators/permissions.decorator';

@ApiTags('Auth')
@Controller({
  path: 'auth',
  version: '1',
})
export class AuthController {
  constructor(
    private readonly authService: AuthService,
  ) {}

  @Post('admin/create')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  createAdmin(@CurrentUser() user: any, @Body() dto: CreateAdminDto) {
    return this.authService.createAdmin(user.id, dto);
  }

  /**
   * ================= REGISTER =================
   */
  @Public()
  @Get('username-availability')
  @Throttle({
    default: {
      limit: 20,
      ttl: 60_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({ summary: 'Check whether a username is available' })
  async usernameAvailability(@Query('username') username?: string) {
    if (!username?.trim()) {
      throw new BadRequestException('Username is required');
    }

    return this.authService.checkUsernameAvailability(username);
  }

  @Public()
  @Get('registration-availability')
  @Throttle({
    default: {
      // Keyed by IP only so enumeration cannot rotate identifiers for fresh buckets.
      limit: 10,
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Check whether a registration username, email, or phone is available',
  })
  async registrationAvailability(
    @Query('username') username?: string,
    @Query('email') email?: string,
    @Query('phone') phone?: string,
  ) {
    return this.authService.checkRegistrationAvailability({
      username,
      email,
      phone,
    });
  }

  @Public()
  @Post('register')
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({
    summary: 'Register new user',
  })
  register(
    @Body() body: RegisterDto | SupabaseAuthDto,
    @Req() req: Request,
  ) {
    if (this.isSupabaseAuthBody(body)) {
      return this.authService.supabaseLogin(
        body.supabase_token,
        req.ip || '',
        req.headers['user-agent'] || '',
      );
    }

    return this.authService.register(body as RegisterDto, req.ip || '');
  }

  /**
   * ================= VERIFY OTP =================
   */
  @Public()
  @Post('verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Verify OTP',
  })
  verifyOtp(
    @Body() dto: VerifyOtpDto,
  ) {
    return this.authService.verifyOtp(
      dto.phone,
      dto.otp_code,
      dto.purpose,
    );
  }

  /**
   * ================= RESEND OTP =================
   */
  @Public()
  @Post('resend-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 3,
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Resend OTP',
  })
  async resendOtp(
    @Body() body: ResendOtpDto,
  ) {
    
    const user =
      await (this.authService as any).prisma.users.findUnique({
        where: {
          phone: body.phone,
        },
      });

    if (!user) {
      return { message: 'If the phone number exists, an OTP was sent.' };
    }

    await this.authService.sendOtp(
      user.id,
      body.phone,
      'phone_verification',
    );
    return { message: 'If the phone number exists, an OTP was sent.' };
  }

  /**
   * ================= FORGOT PASSWORD =================
   */
  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 300_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({ summary: 'Request a password reset link by email' })
  forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: Request,
  ) {
    return this.authService.sendPasswordResetOtp(dto.email, req.ip || '');
  }

  @Public()
  @Post('password-reset/prepare')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 300_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({ summary: 'Send a password reset link by email' })
  sendPasswordResetLink(@Body() dto: ForgotPasswordDto) {
    return this.authService.sendPasswordResetLink(dto.email);
  }

  @Public()
  @Post('request-password-reset')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 300_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({ summary: 'Send a password reset link by email' })
  requestPasswordReset(@Body() dto: ForgotPasswordDto) {
    return this.authService.sendPasswordResetLink(dto.email);
  }

  @Public()
  @Post('password-reset/complete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @ApiOperation({ summary: 'Synchronize a completed Firebase password reset' })
  completePasswordReset(@Body() dto: AdminPasswordResetCompleteDto) {
    return this.authService.completePasswordReset(dto);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 300_000,
    },
  })
  @ApiOperation({ summary: 'Reset password using OTP' })
  resetPassword(
    @Body() dto: ResetPasswordDto,
  ) {
    return this.authService.resetPassword(dto);
  }

  /**
   * ================= RESEND EMAIL VERIFICATION =================
   */
  @Public()
  @Post('resend-email-verification')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 3,
      ttl: 60000,
    },
  })
  @ApiOperation({ summary: 'Resend email verification link' })
  resendEmailVerification(
    @Body() body: ResendEmailVerificationDto,
  ) {
    return this.authService.resendEmailVerification(body.email);
  }

  /**
   * ================= VERIFY EMAIL =================
   */
  @Public()
  @Get('verify-email/:token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email address' })
  verifyEmail(
    @Param('token') token: string | undefined,
    @Query('token') queryToken: string | undefined,
  ) {
    return this.authService.verifyEmail(token || queryToken || '');
  }

  /**
   * ================= LOGIN =================
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({
    summary: 'Login',
  })
  login(
    @Body() body: LoginDto | SupabaseAuthDto,
    @Req() req: Request,
  ) {
    if (this.isSupabaseAuthBody(body)) {
      return this.authService.supabaseLogin(
        body.supabase_token,
        req.ip || '',
        req.headers['user-agent'] || '',
      );
    }

    return this.authService.login(
      body as LoginDto,
      req.ip || '',
      req.headers['user-agent'] || '',
    );
  }

  @Public()
  @Post('firebase-login')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({ summary: 'Complete login with a verified Firebase ID token' })
  firebaseLogin(
    @Body() dto: FirebaseLoginDto,
    @Req() req: Request,
  ) {
    return this.authService.firebaseLogin(
      {
        ...dto,
        identifier: dto.identifier || '',
      },
      req.ip || '',
      req.headers['user-agent'] || '',
    );
  }

  @Public()
  @Post('resolve-login-email')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      // Keyed by IP only so enumeration cannot rotate identifiers for fresh buckets.
      limit: 5,
      ttl: 60_000,
    },
  })
  @ApiOperation({ summary: 'Resolve a FARM phone or username to its login email' })
  resolveLoginEmail(
    @Body() body: ResolveLoginEmailDto,
  ) {
    return this.authService.resolveLoginEmail(body.identifier);
  }

  /**
   * ================= VERIFY PHONE (Firebase) =================
   * Public endpoint: verifies Firebase ID token and issues FARM JWT
   */
  @Public()
  @Post('verify-phone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify phone using Firebase ID token' })
  async verifyPhone(
    @Body() dto: VerifyPhoneDto,
    @Req() req: Request,
  ) {
    return this.authService.verifyPhone(
      dto.firebaseIdToken,
      dto.pendingLoginId,
      req.ip || '',
      req.headers['user-agent'] || '',
    );
  }

  @Public()
  @Post('supabase')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 5,
      ttl: 60_000,
      generateKey: authThrottleKey,
    },
  })
  @ApiOperation({
    summary: 'Login or register with a Supabase access token',
  })
  supabaseAuth(
    @Body() dto: SupabaseAuthDto,
    @Req() req: Request,
  ) {
    return this.authService.supabaseLogin(
      dto.supabase_token,
      req.ip || '',
      req.headers['user-agent'] || '',
    );
  }

  private isSupabaseAuthBody(body: unknown): body is SupabaseAuthDto {
    return typeof body === 'object' && body !== null && typeof (body as SupabaseAuthDto).supabase_token === 'string' && (body as SupabaseAuthDto).supabase_token.trim().length > 0;
  }

  @Public()
  @Get('admin/portal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Honeypot admin portal access' })
  async honeypot(
    @Req() req: Request,
  ) {
    return this.authService.triggerHoneypot(
      '/api/v1/auth/admin/portal',
      req.ip || '',
      req.headers['user-agent'] || '',
    );
  }

  @Public()
  @Get('admin/console')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Honeypot admin console access' })
  async honeypotConsole(
    @Req() req: Request,
  ) {
    return this.authService.triggerHoneypot(
      '/api/v1/auth/admin/console',
      req.ip || '',
      req.headers['user-agent'] || '',
    );
  }

  /**
   * ================= REFRESH TOKEN =================
   */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 6,
      ttl: 60000,
    },
  })
  @ApiOperation({
    summary: 'Refresh token',
  })
  refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ) {
    const decoded = decodeJwtPayload(
      dto.refresh_token,
    );

    if (!decoded?.sub) {
      throw new UnauthorizedException(
        'Invalid refresh token',
      );
    }

    return this.authService.refresh(
      decoded.sub,
      dto.refresh_token,
      req.ip || '',
    );
  }

  /**
   * ================= LOGOUT =================
   */
  @UseGuards(JwtGuard, RolesGuard)
  @Post('device-token')
  @Permissions('sessions:write')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Register a device token for push notifications' })
  async registerDeviceToken(
    @CurrentUser() user: any,
    @Body() body: DeviceTokenDto,
  ) {
    return this.authService.registerDeviceToken(user.id, body.token, body.platform);
  }

  @UseGuards(JwtGuard, RolesGuard)
  @Post('logout')
  @Permissions('sessions:write')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 10,
      ttl: 60000,
    },
  })
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Logout',
  })
  logout(
    @CurrentUser() user: any,
  ) {
    return this.authService.logout(
      user.id,
      user.jti,
    );
  }

  @UseGuards(JwtGuard, RolesGuard)
  @Post('change-password')
  @Permissions('auth:write')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Change password and revoke all other sessions' })
  changePassword(
    @CurrentUser() user: any,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(user.id, dto);
  }

  @UseGuards(JwtGuard, RolesGuard)
  @Delete('delete-account')
  @Permissions('auth:write')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Delete the current account and revoke all sessions' })
  deleteAccount(
    @CurrentUser() user: any,
    @Body() dto: DeleteAccountDto,
  ) {
    return this.authService.deleteAccount(user.id, dto);
  }

  @UseGuards(JwtGuard, RolesGuard)
  @Permissions('sessions:read')
  @Get('sessions')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'List active sessions for the current user' })
  getSessions(
    @CurrentUser() user: any,
  ) {
    return this.authService.getSessions(user.id);
  }

  @UseGuards(JwtGuard, RolesGuard)
  @Permissions('sessions:write')
  @Post('sessions/:id/revoke')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Revoke a session by ID for the current user' })
  revokeSession(
    @CurrentUser() user: any,
    @Param('id') sessionId: string,
  ) {
    return this.authService.revokeSession(
      user.id,
      sessionId,
    );
  }

  @UseGuards(JwtGuard, RolesGuard)
  @Permissions('sessions:write')
  @Post('sessions/revoke-others')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Revoke all other sessions for the current user' })
  revokeOtherSessions(
    @CurrentUser() user: any,
  ) {
    return this.authService.revokeOtherSessions(
      user.id,
      user.jti,
    );
  }

  @UseGuards(JwtGuard, RolesGuard)
  @Permissions('sessions:write')
  @Post('sessions/revoke-all')
  @ApiBearerAuth('JWT')
  @ApiOperation({ summary: 'Revoke all active sessions for the current user' })
  revokeAllSessions(
    @CurrentUser() user: any,
  ) {
    return this.authService.logout(
      user.id,
      undefined,
      true,
    );
  }

  /**
   * ================= SET PIN =================
   */
  @UseGuards(JwtGuard)
  @Post('set-pin')
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Set PIN',
  })
  @Permissions('auth:write')
  setPin(
    @CurrentUser() user: any,
    @Body() dto: SetPinDto,
  ) {
    return this.authService.setPin(
      user.id,
      dto,
    );
  }

  /**
   * ================= CHANGE PIN =================
   */
  @UseGuards(JwtGuard)
  @Post('change-pin')
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Change PIN',
  })
  @Permissions('auth:write')
  changePin(
    @CurrentUser() user: any,
    @Body() dto: ChangePinDto,
  ) {
    return this.authService.changePin(
      user.id,
      dto,
    );
  }

  /**
   * ================= FORGOT PIN =================
   */
  @UseGuards(JwtGuard)
  @Post('forgot-pin')
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: {
      limit: 3,
      ttl: 300000,
    },
  })
  @ApiBearerAuth('JWT')
  @ApiOperation({
    summary: 'Reset forgotten PIN',
  })
  @Permissions('auth:write')
  forgotPin(
    @CurrentUser() user: any,
    @Body() dto: ResetPinDto,
  ) {
    return this.authService.resetForgottenPin(
      user.id,
      dto,
    );
  }
}

/**
 * ================= JWT DECODE =================
 */
function decodeJwtPayload(
  token: string,
): any {
  try {
    return JSON.parse(
      Buffer.from(
        token.split('.')[1],
        'base64url',
      ).toString('utf8'),
    );
  } catch {
    return null;
  }
}

function authThrottleKey(context: ExecutionContext): string {
  const request = context.switchToHttp().getRequest<Request>();
  const ip = request.ip || 'unknown-ip';
  const body: Record<string, any> = request.body || {};
  const identifier = (
    body.identifier || body.email || body.phone || body.supabase_token || ''
  ).toString().trim().toLowerCase();

  return identifier.length > 0
    ? `${ip}:${identifier}`
    : `${ip}:anonymous`;
}
