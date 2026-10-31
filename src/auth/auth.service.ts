import {
  Injectable,
  Optional,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { hashOtp, verifyOtp } from '../common/utils/otp-hash.util';
import * as bcrypt from 'bcrypt';
import * as admin from 'firebase-admin';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { DeviceBindingService } from './device-binding/device-binding.service';
import type { DeviceProofDto } from './device-binding/dto/device-proof.dto';
import { NotificationsService } from '../notifications/notifications.service';
import { FirebaseService } from '../notifications/firebase.service';
import { TurnstileService } from '../common/services/turnstile.service';
import { RedisService } from '../common/redis/redis.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SetPinDto } from './dto/set-pin.dto';
import { ChangePinDto } from './dto/change-pin.dto';
import { ResetPinDto } from './dto/reset-pin.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import { CreateAdminDto } from './dto/create-admin.dto';
import {
  generateWalletAddress,
  generateOtp,
  generateReferralCode,
} from '../common/utils/reference.util';
import {
  MAX_PIN_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  OTP_EXPIRY_MINUTES,
  OTP_MAX_ATTEMPTS,
} from '../common/constants';

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  /** Refresh-session lifetime in days (REFRESH_TOKEN_TTL_DAYS, default 30). */
  private refreshTtlDays(): number {
    const days = Number(this.cfg.get('REFRESH_TOKEN_TTL_DAYS', '30'));
    return Number.isFinite(days) && days > 0 && days <= 365 ? days : 30;
  }

  /**
   * Graceful migration from the old 10-year sessions: cap any session that
   * outlives the TTL to "now + TTL". Only ever shortens; nobody is logged out.
   */
  async onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const days = this.refreshTtlDays();
      const capped = new Date(Date.now() + days * 86_400_000);
      const margin = new Date(capped.getTime() + 86_400_000);
      const result = await this.prisma.user_sessions.updateMany({
        where: { expires_at: { gt: margin } },
        data: { expires_at: capped },
      });
      if (result.count > 0) {
        this.logger.log(
          `Capped ${result.count} long-lived refresh session(s) to ${days} days`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not cap long-lived refresh sessions: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private cfg: ConfigService,
    private notifications: NotificationsService,
    private turnstile: TurnstileService,
    private firebase: FirebaseService,
    private readonly redis: RedisService,
    @Optional() private readonly deviceBinding?: DeviceBindingService,
  ) {}

  /** Device-binding gate; a no-op when DEVICE_BINDING_ENABLED is not true. */
  private async gateDevice(userId: string, device: unknown, ip: string) {
    if (!this.deviceBinding) return null;
    const result = await this.deviceBinding.evaluateLogin(
      userId,
      device as DeviceProofDto | undefined,
      ip,
    );
    return result.trustedDeviceId;
  }

  private otpSecret(): string {
    return (
      this.cfg.get<string>('OTP_HASH_SECRET') ||
      this.cfg.get<string>('JWT_ACCESS_SECRET') ||
      ''
    );
  }

  // ── Register ────────────────────────────────────────────────────────────────
  async register(dto: RegisterDto, ip: string, turnstileToken?: string) {
    // Validate Turnstile token (bot protection)
    if (turnstileToken) {
      await this.turnstile.verifyToken(turnstileToken, ip);
    }

    const username = dto.username.trim().toLowerCase();
    const phone = this.normalizeRegistrationPhone(dto.phone);
    const phoneVariants = [phone, phone.slice(1)];
    const email = dto.email?.trim().toLowerCase();
    const existing = await this.prisma.users.findFirst({
      where: {
        OR: [
          { phone: { in: phoneVariants } },
          { username: { equals: username, mode: 'insensitive' as const } },
          ...(email
            ? [{ email: { equals: email, mode: 'insensitive' as const } }]
            : []),
        ],
      },
    });
    if (existing) {
      if (
        existing.phone &&
        this.normalizeRegistrationPhone(existing.phone) === phone
      ) {
        throw new ConflictException('Phone already registered');
      }
      if (existing.username?.toLowerCase() === username) {
        throw new ConflictException('Username already registered');
      }
      if (email && existing.email?.trim().toLowerCase() === email) {
        throw new ConflictException('Email already registered');
      }
      throw new ConflictException('Email already registered');
    }

    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
    const password_hash = await bcrypt.hash(dto.password, rounds);

    let referred_by: string | undefined;
    if (dto.referral_code) {
      const referrer = await this.prisma.users.findFirst({
        where: { referral_code: dto.referral_code },
      });
      if (referrer) referred_by = referrer.id;
    }

    // QR_HMAC_SECRET must be set in environment (fail fast if missing)
    const qrSecret = this.cfg.get<string>('QR_HMAC_SECRET');
    if (!qrSecret) {
      throw new Error(
        'QR_HMAC_SECRET not configured - wallet generation impossible',
      );
    }

    let user: { id: string; phone: string };
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const u = await tx.users.create({
          data: {
            first_name: dto.first_name,
            last_name: dto.last_name,
            username,
            phone,
            email,
            password_hash,
            country: dto.country,
            referred_by,
            referral_code: generateReferralCode(),
          },
        });
        await tx.wallets.create({
          data: {
            user_id: u.id,
            wallet_name: `${u.first_name}'s Wallet`,
            wallet_type: 'user',
            wallet_address: generateWalletAddress(u.id, qrSecret),
            currency: 'FARM',
          },
        });
        await tx.activity_logs.create({
          data: { user_id: u.id, activity: 'REGISTER', ip_address: ip },
        });
        return u;
      });
    } catch (error) {
      const conflict = this.registrationUniqueConflict(error);
      if (conflict) throw conflict;
      throw error;
    }

    // Firebase linking and OTP delivery run in the background so a slow
    // provider can't hang or fail registration. Password-reset links the
    // Firebase account lazily if this background link didn't finish.
    if (email) {
      const userId = user.id;
      void this.ensureFirebaseAccount(email, dto.password)
        .then((uid) =>
          uid
            ? this.prisma.users.update({
                where: { id: userId },
                data: { firebase_uid: uid },
              })
            : undefined,
        )
        .catch((e) =>
          this.logger.warn(
            `Background Firebase linking failed for ${userId}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }
    await this.sendOtp(user.id, user.phone, 'phone_verification', true);
    return {
      message: 'Registration successful. OTP sent to your phone number.',
    };
  }

  async createAdmin(actorUserId: string, dto: CreateAdminDto) {
    const actor = await this.prisma.users.findUnique({
      where: { id: actorUserId },
      select: { id: true, role: true },
    });

    if (!actor || String(actor.role || '').toLowerCase() !== 'super_admin') {
      throw new ForbiddenException(
        'Only superadmins can create admin accounts',
      );
    }

    const existing = await this.prisma.users.findFirst({
      where: {
        OR: [
          { phone: dto.phone },
          { username: dto.username.toLowerCase() },
          { email: dto.email.trim().toLowerCase() },
        ],
      },
    });

    if (existing) {
      if (existing.phone === dto.phone)
        throw new ConflictException('Phone already registered');
      if (existing.username === dto.username.toLowerCase())
        throw new ConflictException('Username taken');
      throw new ConflictException('Email already registered');
    }

    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
    const password_hash = await bcrypt.hash(dto.password, rounds);
    const qrSecret = this.cfg.get<string>('QR_HMAC_SECRET');
    if (!qrSecret) {
      throw new Error(
        'QR_HMAC_SECRET not configured - wallet generation impossible',
      );
    }

    const admin = await this.prisma.$transaction(async (tx) => {
      const created = await tx.users.create({
        data: {
          first_name: dto.first_name,
          last_name: dto.last_name,
          username: dto.username.toLowerCase(),
          phone: dto.phone,
          email: dto.email.trim().toLowerCase(),
          password_hash,
          country: dto.country,
          role: 'admin',
          is_active: true,
          is_suspended: false,
          is_deleted: false,
          referral_code: generateReferralCode(),
        },
      });

      await tx.wallets.create({
        data: {
          user_id: created.id,
          wallet_name: `${created.first_name}'s Wallet`,
          wallet_type: 'user',
          wallet_address: generateWalletAddress(created.id, qrSecret),
          currency: 'FARM',
        },
      });

      await tx.activity_logs.create({
        data: {
          user_id: created.id,
          activity: 'ADMIN_ACCOUNT_CREATED',
          ip_address: '127.0.0.1',
        },
      });

      return created;
    });

    await this.sendOtp(admin.id, admin.phone, 'phone_verification', true);
    return { message: 'Admin account created successfully' };
  }

  // ── Verify OTP ───────────────────────────────────────────────────────────────
  async verifyOtp(
    phone: string,
    otpCode: string,
    purpose = 'phone_verification',
  ) {
    const user = await this.prisma.users.findUnique({ where: { phone } });
    if (!user) throw new NotFoundException('User not found');

    const otp = await this.prisma.otp_verifications.findFirst({
      where: { user_id: user.id, purpose, verified: false },
      orderBy: { created_at: 'desc' },
    });

    if (!otp)
      throw new BadRequestException('No active OTP found. Request a new one.');

    const expiryDate = new Date(otp.expires_at as any);

    if (isNaN(expiryDate.getTime())) {
      throw new BadRequestException('Invalid OTP expiry date');
    }

    if (new Date() > expiryDate) {
      throw new BadRequestException('OTP has expired');
    }

    const attempts = otp.attempts ?? 0;

    if (attempts >= OTP_MAX_ATTEMPTS)
      throw new ForbiddenException('Too many attempts. Request a new OTP.');

    if (!verifyOtp(otp.otp_code, String(otpCode ?? ''), this.otpSecret())) {
      await this.prisma.otp_verifications.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      const remaining = OTP_MAX_ATTEMPTS - attempts - 1;
      throw new BadRequestException(
        `Invalid OTP. ${remaining} attempt(s) remaining.`,
      );
    }

    await this.prisma.otp_verifications.update({
      where: { id: otp.id },
      data: { verified: true },
    });
    if (purpose === 'phone_verification') {
      await this.prisma.users.update({
        where: { id: user.id },
        data: { phone_verified: true },
      });
    }
    return { message: 'OTP verified successfully', user_id: user.id };
  }

  // ── Login ────────────────────────────────────────────────────────────────────
  async login(
    dto: LoginDto,
    ip: string,
    userAgent: string,
    turnstileToken?: string,
  ) {
    // Validate Turnstile token (bot protection)
    if (turnstileToken) {
      await this.turnstile.verifyToken(turnstileToken, ip);
    }

    // The controller body is a union type, so class-validator does not run;
    // reject malformed bodies with 400 instead of crashing with a 500.
    if (
      typeof dto?.identifier !== 'string' ||
      !dto.identifier.trim() ||
      typeof dto?.password !== 'string' ||
      !dto.password
    ) {
      throw new BadRequestException('identifier and password are required');
    }
    const normalizedIdentifier = dto.identifier.trim();
    const normalizedPhone = this.normalizePhoneNumber(normalizedIdentifier);

    const user = (await this.prisma.users.findFirst({
      where: {
        OR: [
          { phone: normalizedPhone },
          {
            email: {
              equals: normalizedIdentifier,
              mode: 'insensitive' as any,
            },
          },
          {
            username: {
              equals: normalizedIdentifier,
              mode: 'insensitive' as any,
            },
          },
        ],
        is_deleted: false,
      },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    })) as any;

    if (!user) throw new UnauthorizedException('Invalid credentials');
    if (user.is_suspended)
      throw new ForbiddenException('Account suspended. Contact support.');
    if (!user.is_active) throw new ForbiddenException('Account is inactive.');

    const failedAttempts = user.failed_login_attempts ?? 0;

    if (failedAttempts >= MAX_LOGIN_ATTEMPTS) {
      await this.prisma.security_events.create({
        data: {
          user_id: user.id,
          event_type: 'ACCOUNT_LOCKED',
          description: 'Too many failed login attempts',
          severity: 'high',
          ip_address: ip,
        },
      });
      throw new ForbiddenException('Account locked. Contact support.');
    }

    const valid = await bcrypt.compare(dto.password, user.password_hash);
    if (!valid) {
      await this.prisma.users.update({
        where: { id: user.id },
        data: { failed_login_attempts: { increment: 1 } },
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.prisma.users.update({
      where: { id: user.id },
      data: {
        failed_login_attempts: 0,
        last_login_at: new Date(),
        last_seen_at: new Date(),
      },
    });

    const trustedDeviceId = await this.gateDevice(
      user.id,
      (dto as { device?: unknown }).device,
      ip,
    );

    const userRole = (user.role ?? 'user').toString().toLowerCase();

    const requirePhoneVerification =
      this.cfg.get<string>('REQUIRE_PHONE_VERIFICATION') !== 'false';

    // Regular users require Firebase phone verification by default. Admin and
    // superadmin accounts are trusted after password authentication.
    if (
      !requirePhoneVerification ||
      userRole === 'admin' ||
      userRole === 'super_admin'
    ) {
      const walletId = user.wallets[0]?.id;
      const tokens = await this.issueTokens(user.id, userRole, walletId);
      const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
      await this.prisma.user_sessions.create({
        data: {
          trusted_device_id: trustedDeviceId,
          user_id: user.id,
          refresh_token: await bcrypt.hash(tokens.refresh_token, rounds),
          jwt_id: tokens.jti,
          ip_address: ip,
          user_agent: userAgent,
          expires_at: this.refreshSessionExpiry(),
        },
      });

      await this.prisma.activity_logs.create({
        data: { user_id: user.id, activity: 'LOGIN_SUCCESS', ip_address: ip },
      });

      return {
        success: true,
        data: {
          requiresPhoneVerification: false,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: 'Bearer',
          expires_in: 900,
          user: {
            id: user.id,
            first_name: user.first_name,
            last_name: user.last_name,
            username: user.username,
            phone: user.phone,
            email: user.email,
            role: user.role,
            kyc_status: user.kyc_status,
            kyc_level: user.kyc_level,
            phone_verified: user.phone_verified,
            has_pin: !!user.pin_hash,
            profile_image: user.profile_image,
          },
        },
        message: 'Login successful',
      };
    }

    const pending = await this.prisma.pending_login_verifications.create({
      data: {
        trusted_device_id: trustedDeviceId,
        user_id: user.id,
        phone: this.normalizePhoneNumber(user.phone),
        role: user.role ?? 'user',
        expires_at: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    await this.prisma.activity_logs.create({
      data: { user_id: user.id, activity: 'LOGIN_STEP_1', ip_address: ip },
    });

    return {
      success: true,
      data: {
        requiresPhoneVerification: true,
        pendingLoginId: pending.id,
        phone: this.normalizePhoneNumber(user.phone),
      },
      message: 'Password verified. Phone verification required.',
    };
  }

  async supabaseLogin(
    supabaseToken: string,
    ip: string,
    userAgent: string,
    turnstileToken?: string,
  ) {
    if (turnstileToken) {
      await this.turnstile.verifyToken(turnstileToken, ip);
    }
    return {
      message: 'Supabase auth is not configured in this environment',
      data: {},
    };
  }

  async firebaseLogin(
    dto: {
      identifier: string;
      firebase_token?: string;
      firebaseIdToken?: string;
      country_code?: string;
      cf_turnstile_response?: string;
      turnstile_token?: string;
      device?: unknown;
    },
    ip: string,
    userAgent: string,
  ) {
    if (dto.turnstile_token) {
      await this.turnstile.verifyToken(dto.turnstile_token, ip);
    }
    const firebaseToken = dto.firebase_token || dto.firebaseIdToken;
    if (!firebaseToken)
      throw new UnauthorizedException('Firebase authentication required');

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await this.firebase.verifyIdToken(firebaseToken);
    } catch {
      throw new UnauthorizedException('Invalid Firebase authentication token');
    }

    const email = decoded.email?.trim().toLowerCase();
    if (!email) throw new UnauthorizedException('A Firebase email is required');

    const user = (await this.prisma.users.findFirst({
      where: {
        OR: [{ firebase_uid: decoded.uid }, { email }],
        is_deleted: false,
      },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    })) as any;
    if (!user) throw new UnauthorizedException('FARM account not found');
    if (user.is_suspended)
      throw new ForbiddenException('Account suspended. Contact support.');
    if (!user.is_active) throw new ForbiddenException('Account is inactive.');
    if (user.firebase_uid !== decoded.uid) {
      await this.prisma.users.update({
        where: { id: user.id },
        data: { firebase_uid: decoded.uid, email_verified: true },
      });
    }

    await this.prisma.users.update({
      where: { id: user.id },
      data: {
        failed_login_attempts: 0,
        last_login_at: new Date(),
        last_seen_at: new Date(),
      },
    });

    const trustedDeviceId = await this.gateDevice(
      user.id,
      (dto as { device?: unknown }).device,
      ip,
    );

    const userRole = (user.role ?? 'user').toString().toLowerCase();
    if (userRole === 'admin' || userRole === 'super_admin') {
      const tokens = await this.issueTokens(
        user.id,
        userRole,
        user.wallets[0]?.id,
      );
      const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
      await this.prisma.user_sessions.create({
        data: {
          trusted_device_id: trustedDeviceId,
          user_id: user.id,
          refresh_token: await bcrypt.hash(tokens.refresh_token, rounds),
          jwt_id: tokens.jti,
          ip_address: ip,
          user_agent: userAgent,
          expires_at: this.refreshSessionExpiry(),
        },
      });
      return this.firebaseLoginResponse(user, tokens, false);
    }

    const pending = await this.prisma.pending_login_verifications.create({
      data: {
        trusted_device_id: trustedDeviceId,
        user_id: user.id,
        phone: this.normalizePhoneNumber(user.phone),
        role: user.role ?? 'user',
        expires_at: new Date(Date.now() + 5 * 60 * 1000),
      },
    });
    return {
      success: true,
      data: {
        requiresPhoneVerification: true,
        pendingLoginId: pending.id,
        phone: this.normalizePhoneNumber(user.phone),
      },
      message: 'Password verified. Phone verification required.',
    };
  }

  async resolveLoginEmail(identifier: string) {
    const normalized = identifier.trim();
    const normalizedPhone = this.normalizePhoneNumber(normalized);
    const user = await this.prisma.users.findFirst({
      where: {
        OR: [
          { phone: normalizedPhone },
          { username: { equals: normalized, mode: 'insensitive' as any } },
        ],
        is_deleted: false,
      },
      select: { email: true, firebase_uid: true },
    });
    if (!user?.email || !user.firebase_uid) {
      throw new UnauthorizedException(
        'Firebase login is not available for this account',
      );
    }
    return { data: { email: user.email } };
  }

  private firebaseLoginResponse(
    user: any,
    tokens: { access_token: string; refresh_token: string },
    requiresPhoneVerification: boolean,
  ) {
    return {
      success: true,
      data: {
        requiresPhoneVerification,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: 'Bearer',
        expires_in: 900,
        user: {
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          username: user.username,
          phone: user.phone,
          email: user.email,
          role: user.role,
          kyc_status: user.kyc_status,
          kyc_level: user.kyc_level,
          phone_verified: user.phone_verified,
          has_pin: !!user.pin_hash,
          profile_image: user.profile_image,
        },
      },
      message: 'Login successful',
    };
  }

  private async ensureFirebaseAccount(
    email: string,
    password?: string,
  ): Promise<string> {
    const normalizedEmail = email.trim().toLowerCase();
    const existingFarmUser = await this.prisma.users.findUnique({
      where: { email: normalizedEmail },
      select: { firebase_uid: true },
    });
    if (existingFarmUser?.firebase_uid) return existingFarmUser.firebase_uid;

    let firebaseUser: admin.auth.UserRecord;
    try {
      firebaseUser = await this.firebase.auth.getUserByEmail(normalizedEmail);
    } catch (error: any) {
      if (error?.code !== 'auth/user-not-found') throw error;
      firebaseUser = await this.firebase.auth.createUser({
        email: normalizedEmail,
        emailVerified: false,
        password: password || randomBytes(32).toString('base64url'),
      });
    }
    return firebaseUser.uid;
  }

  async verifyPhone(
    firebaseIdToken: string,
    pendingLoginId: string,
    ip: string,
    userAgent: string,
  ) {
    const pending = (await this.prisma.pending_login_verifications.findUnique({
      where: { id: pendingLoginId },
      include: {
        users: {
          include: { wallets: { where: { is_active: true }, take: 1 } },
        },
      },
    })) as any;

    if (
      !pending ||
      pending.status !== 'pending' ||
      pending.expires_at <= new Date()
    ) {
      throw new UnauthorizedException('Login verification session expired');
    }

    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await this.firebase.verifyIdToken(firebaseIdToken);
    } catch {
      throw new UnauthorizedException('Invalid Firebase verification token');
    }

    const firebasePhone = this.normalizePhoneNumber(decoded.phone_number);
    if (!firebasePhone || firebasePhone !== pending.phone) {
      await this.prisma.pending_login_verifications.update({
        where: { id: pending.id },
        data: { attempt_count: { increment: 1 } },
      });
      throw new ForbiddenException(
        'Phone verification does not match this account.',
      );
    }

    const claimed = await this.prisma.pending_login_verifications.updateMany({
      where: {
        id: pending.id,
        status: 'pending',
        expires_at: { gt: new Date() },
      },
      data: { status: 'verified', verified_at: new Date() },
    });
    if (claimed.count !== 1) {
      throw new UnauthorizedException(
        'Login verification session has already been used',
      );
    }

    const user = pending.users;
    if (!user || user.is_deleted || user.is_suspended || !user.is_active) {
      throw new ForbiddenException('Account is unavailable');
    }

    const walletId = user.wallets[0]?.id;
    const tokens = await this.issueTokens(
      user.id,
      pending.role.toString().toLowerCase(),
      walletId,
    );
    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
    await this.prisma.user_sessions.create({
      data: {
        trusted_device_id: pending.trusted_device_id ?? null,
        user_id: user.id,
        refresh_token: await bcrypt.hash(tokens.refresh_token, rounds),
        jwt_id: tokens.jti,
        ip_address: ip,
        user_agent: userAgent,
        expires_at: this.refreshSessionExpiry(),
      },
    });

    await this.prisma.users.update({
      where: { id: user.id },
      data: { phone_verified: true },
    });

    return {
      success: true,
      data: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: 'Bearer',
        expires_in: 900,
        user: {
          id: user.id,
          first_name: user.first_name,
          last_name: user.last_name,
          username: user.username,
          phone: user.phone,
          email: user.email,
          role: user.role,
          kyc_status: user.kyc_status,
          kyc_level: user.kyc_level,
          phone_verified: true,
          has_pin: !!user.pin_hash,
          profile_image: user.profile_image,
        },
      },
      message: 'Login successful',
    };
  }

  async sendPasswordResetOtp(
    email: string,
    ip: string,
    turnstileToken?: string,
  ) {
    // Validate Turnstile token (bot protection)
    if (turnstileToken) {
      await this.turnstile.verifyToken(turnstileToken, ip);
    }
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.users.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, firebase_uid: true, email: true, is_deleted: true },
    });
    if (user && !user.is_deleted && user.email) {
      const firebaseUid =
        user.firebase_uid || (await this.ensureFirebaseAccount(user.email));
      if (!user.firebase_uid) {
        await this.prisma.users.update({
          where: { id: user.id },
          data: { firebase_uid: firebaseUid },
        });
      }
    }
    return {
      message:
        'If an account exists for this email, a password reset link has been sent.',
    };
  }

  async checkUsernameAvailability(username: string) {
    const normalized = username.trim();
    if (!normalized) {
      throw new BadRequestException('Username is required');
    }

    const existing = await this.prisma.users.findFirst({
      where: {
        username: {
          equals: normalized.toLowerCase(),
          mode: 'insensitive' as const,
        },
      },
      select: { id: true },
    });

    return { data: { available: !existing } };
  }

  async checkRegistrationAvailability(params: {
    username?: string;
    email?: string;
    phone?: string;
  }) {
    const username = params.username?.trim().toLowerCase();
    const email = params.email?.trim().toLowerCase();
    const phone = params.phone
      ? this.normalizeRegistrationPhone(params.phone)
      : undefined;
    if (!username && !email && !phone) {
      throw new BadRequestException(
        'Username, email, or phone number is required',
      );
    }

    const [usernameResult, emailResult, phoneResult] = await Promise.all([
      username
        ? this.prisma.users.findFirst({
            where: {
              username: { equals: username, mode: 'insensitive' as const },
            },
            select: { id: true },
          })
        : Promise.resolve(null),
      email
        ? this.prisma.users.findFirst({
            where: { email: { equals: email, mode: 'insensitive' } },
            select: { id: true },
          })
        : Promise.resolve(null),
      phone
        ? this.prisma.users.findFirst({
            where: { phone: { in: [phone, phone.slice(1)] } },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      data: {
        usernameAvailable: !usernameResult,
        emailAvailable: !emailResult,
        phoneAvailable: !phoneResult,
      },
    };
  }

  private registrationUniqueConflict(error: unknown): ConflictException | null {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'P2002'
    ) {
      return null;
    }

    const target =
      'meta' in error &&
      typeof error.meta === 'object' &&
      error.meta !== null &&
      'target' in error.meta
        ? error.meta.target
        : undefined;
    const fields = Array.isArray(target)
      ? target.join(' ')
      : String(target ?? '');
    if (fields.includes('phone')) {
      return new ConflictException('Phone already registered');
    }
    if (fields.includes('username')) {
      return new ConflictException('Username already registered');
    }
    if (fields.includes('email')) {
      return new ConflictException('Email already registered');
    }
    return null;
  }

  private normalizeRegistrationPhone(phone: string): string {
    const trimmed = phone.trim();
    return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
  }

  async sendPasswordResetLink(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const redisClient = this.redis?.getClient?.();
    if (!redisClient) {
      throw new Error('Password reset rate limiting is unavailable');
    }

    const key = `password-reset:${createHash('sha256').update(normalizedEmail).digest('hex')}`;
    const alreadySent = await redisClient.set(key, '1', 'EX', 180, 'NX');
    if (alreadySent !== 'OK') {
      return { message: 'If an account exists, we have sent a reset link' };
    }

    try {
      const user = await this.prisma.users.findFirst({
        where: { email: normalizedEmail, is_deleted: false },
        select: {
          id: true,
          email: true,
          firebase_uid: true,
          is_active: true,
          role: true,
        },
      });

      if (user?.email) {
        const firebaseUid =
          user.firebase_uid || (await this.ensureFirebaseAccount(user.email));
        if (!user.firebase_uid) {
          await this.prisma.users.update({
            where: { id: user.id },
            data: { firebase_uid: firebaseUid },
          });
        }

        const continueUrl =
          this.cfg.get<string>('FIREBASE_PASSWORD_RESET_CONTINUE_URL') ||
          'https://farmapp-e2145.firebaseapp.com/admin-reset-password';
        const resetLink = await this.firebase.auth.generatePasswordResetLink(
          user.email,
          {
            url: continueUrl,
            handleCodeInApp: true,
            android: { packageName: 'farmapp.africa', installApp: true },
            iOS: { bundleId: 'com.mycompany.farm' },
          },
        );

        const safeHtml = this.notifications ? `...` : `...`;

        const buttonUrl = resetLink.includes('__/auth/action')
          ? resetLink
          : continueUrl;

        await this.notifications.sendEmailOrThrow(
          user.email,
          'Reset your FARM password',
          `<html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;">` +
            `<div style="max-width:540px;margin:auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 1px 12px rgba(0,0,0,.06);">` +
            `<div style="font-size:14px;font-weight:700;color:#ff9800;letter-spacing:1px;text-transform:uppercase;">FARM</div>` +
            `<h2 style="margin:18px 0 12px;color:#0d1b2a;">Reset your password</h2>` +
            `<p style="font-size:15px;line-height:1.6;color:#334155;">We received a request to reset your password for your FARM account.</p>` +
            `<p style="font-size:15px;line-height:1.6;color:#334155;">Tap the button below to set a new password and return to the app.</p>` +
            `<div style="text-align:center;margin:26px 0;">` +
            `<a href="${buttonUrl}" style="display:inline-block;background:#ff9800;color:#fff;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:700;">SET A NEW PASSWORD</a>` +
            `</div>` +
            `<p style="font-size:12px;color:#64748b;">If you did not request this, you can ignore this email.</p>` +
            `</div></body></html>`,
          `We received a request to reset your password for your FARM account. Open this link to set a new password: ${buttonUrl}`,
        );
      }

      return { message: 'If an account exists, we have sent a reset link' };
    } catch (error) {
      await redisClient.del(key);
      throw error;
    }
  }

  async completePasswordReset(dto: {
    firebase_id_token: string;
    password: string;
    confirm_password: string;
  }) {
    if (dto.password !== dto.confirm_password) {
      throw new BadRequestException('Passwords do not match');
    }

    if (!dto.firebase_id_token) {
      throw new BadRequestException('Firebase identity token is required');
    }

    const decoded = await this.firebase.verifyIdToken(dto.firebase_id_token);
    const user = await this.prisma.users.findUnique({
      where: { email: decoded.email ?? '' },
      select: { id: true, email: true, is_active: true, is_deleted: false },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
    const passwordHash = await bcrypt.hash(dto.password, rounds);

    await this.prisma.$transaction(async (tx) => {
      await tx.users.update({
        where: { id: user.id },
        data: {
          password_hash: passwordHash,
          failed_login_attempts: 0,
        },
      });
      await tx.user_sessions.updateMany({
        where: { user_id: user.id, is_revoked: false },
        data: { is_revoked: true },
      });
    });

    return { message: 'Password reset successfully' };
  }

  async resetPassword(dto: ResetPasswordDto) {
    if (!dto.password || !dto.confirm_password) {
      throw new BadRequestException('Password and confirmation are required');
    }
    if (dto.password !== dto.confirm_password) {
      throw new BadRequestException('Passwords do not match');
    }

    if (dto.email) {
      const user = await this.prisma.users.findUnique({
        where: { email: dto.email.toLowerCase() },
      });
      if (!user) {
        throw new NotFoundException('User not found');
      }
      const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
      const passwordHash = await bcrypt.hash(dto.password, rounds);
      await this.prisma.users.update({
        where: { id: user.id },
        data: { password_hash: passwordHash, failed_login_attempts: 0 },
      });
      return { message: 'Password reset successfully' };
    }

    return {
      message: 'Password reset flow is not configured in this environment',
    };
  }

  // ── Email verification ──────────────────────────────────────────────────────
  static readonly EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
  static readonly EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;
  static readonly EMAIL_VERIFICATION_MAX_PER_DAY = 5;

  private hashVerificationToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private emailVerificationBaseUrl(): string | null {
    const explicit = this.cfg.get<string>('EMAIL_VERIFICATION_URL');
    if (explicit) return explicit;
    const app = this.cfg.get<string>('APP_URL');
    return app ? `${app.replace(/\/+$/, '')}/verify-email` : null;
  }

  private assertEmailVerificationConfigured(): string {
    const base = this.emailVerificationBaseUrl();
    if (!this.notifications.isTransactionalEmailConfigured() || !base) {
      throw new ServiceUnavailableException(
        'Email verification is unavailable: no email provider is configured (RESEND_API_KEY, RESEND_FROM and APP_URL or EMAIL_VERIFICATION_URL are required)',
      );
    }
    return base;
  }

  /**
   * Issues a single-use, 24h, SHA-256-hashed token and emails the link.
   * Rate limited to one per minute and five per day per user. The response is
   * the same whether or not the address exists, to avoid account enumeration.
   */
  async resendEmailVerification(email: string) {
    const base = this.assertEmailVerificationConfigured();
    const generic = {
      message:
        'If the address belongs to an unverified account, a verification link has been sent',
    };
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.users.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
      select: { id: true, email: true, email_verified: true },
    });
    if (!user?.email || user.email_verified) return generic;

    const now = Date.now();
    const recent = await this.prisma.email_verification_tokens.findMany({
      where: {
        user_id: user.id,
        created_at: { gte: new Date(now - 24 * 60 * 60 * 1000) },
      },
      select: { created_at: true },
      orderBy: { created_at: 'desc' },
    });
    if (
      recent.length >= AuthService.EMAIL_VERIFICATION_MAX_PER_DAY ||
      (recent[0] &&
        now - recent[0].created_at.getTime() <
          AuthService.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS)
    ) {
      throw new HttpException(
        'Too many verification emails requested. Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const token = randomBytes(32).toString('hex');
    await this.prisma.$transaction([
      // Any older unused link stops working once a new one is issued.
      this.prisma.email_verification_tokens.updateMany({
        where: { user_id: user.id, used_at: null },
        data: { used_at: new Date(now) },
      }),
      this.prisma.email_verification_tokens.create({
        data: {
          user_id: user.id,
          email: user.email,
          token_hash: this.hashVerificationToken(token),
          expires_at: new Date(now + AuthService.EMAIL_VERIFICATION_TTL_MS),
        },
      }),
    ]);

    const link = `${base}${base.includes('?') ? '&' : '?'}token=${token}`;
    await this.notifications.sendEmailOrThrow(
      user.email,
      'Verify your FARM email',
      `<html><body style="font-family:Arial,sans-serif;background:#f5f5f5;padding:24px;">` +
        `<div style="max-width:540px;margin:auto;background:#fff;border:1px solid #e0e0e0;border-radius:12px;padding:24px;">` +
        `<div style="font-size:14px;font-weight:700;color:#000;letter-spacing:1px;">FARM</div>` +
        `<h2 style="margin:18px 0 12px;color:#000;">Verify your email</h2>` +
        `<p style="font-size:15px;line-height:1.6;color:#333;">Tap the button below to confirm this email address. The link expires in 24 hours and can be used once.</p>` +
        `<div style="text-align:center;margin:26px 0;"><a href="${link}" style="display:inline-block;background:#000;color:#fff;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:700;">VERIFY EMAIL</a></div>` +
        `<p style="font-size:12px;color:#777;">If you did not request this, you can ignore this email.</p>` +
        `</div></body></html>`,
      `Confirm your FARM email address (link valid 24 hours, single use): ${link}`,
    );
    return generic;
  }

  async verifyEmail(token: string) {
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      throw new BadRequestException('Invalid or expired verification link');
    }
    const tokenHash = this.hashVerificationToken(token.toLowerCase());
    const row = await this.prisma.email_verification_tokens.findUnique({
      where: { token_hash: tokenHash },
      select: {
        id: true,
        user_id: true,
        email: true,
        used_at: true,
        expires_at: true,
      },
    });
    if (!row || row.used_at || row.expires_at.getTime() <= Date.now()) {
      throw new BadRequestException('Invalid or expired verification link');
    }

    await this.prisma.$transaction(async (tx) => {
      // Atomic single-use claim: only one concurrent request can win.
      const claimed = await tx.email_verification_tokens.updateMany({
        where: { id: row.id, used_at: null, expires_at: { gt: new Date() } },
        data: { used_at: new Date() },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException('Invalid or expired verification link');
      }
      // Only verify if the account still has the address the link was sent to.
      const updated = await tx.users.updateMany({
        where: { id: row.user_id, email: row.email },
        data: { email_verified: true },
      });
      if (updated.count !== 1) {
        throw new BadRequestException('Invalid or expired verification link');
      }
    });
    return { message: 'Email verified successfully' };
  }

  // ── Change password ─────────────────────────────────────────────────────────
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    currentJti?: string,
  ) {
    if (dto.new_password !== dto.confirm_password) {
      throw new BadRequestException('Passwords do not match');
    }
    if (dto.new_password === dto.current_password) {
      throw new BadRequestException(
        'New password must be different from the current password',
      );
    }
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { id: true, password_hash: true },
    });
    if (!user?.password_hash) {
      throw new BadRequestException(
        'Password sign-in is not set up for this account',
      );
    }
    const valid = await bcrypt.compare(
      dto.current_password,
      user.password_hash,
    );
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;
    const passwordHash = await bcrypt.hash(dto.new_password, rounds);
    await this.prisma.$transaction(async (tx) => {
      await tx.users.update({
        where: { id: userId },
        data: { password_hash: passwordHash, failed_login_attempts: 0 },
      });
      // Revoke every other session (and its refresh token); keep this one.
      await tx.user_sessions.updateMany({
        where: {
          user_id: userId,
          OR: [{ is_revoked: false }, { is_revoked: null }],
          ...(currentJti ? { NOT: { jwt_id: currentJti } } : {}),
        },
        data: { is_revoked: true },
      });
      await tx.activity_logs.create({
        data: { user_id: userId, activity: 'PASSWORD_CHANGED' },
      });
    });

    try {
      await this.notifications.sendNotification(userId, {
        type: 'security',
        title: 'Password changed',
        body: 'Your FARM password was changed and other devices were signed out. If this was not you, contact support immediately.',
      });
    } catch (error) {
      this.logger.warn(
        `Password-change notification failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      message: 'Password changed successfully. Other sessions were signed out.',
    };
  }

  async deleteAccount(userId: string, dto: DeleteAccountDto) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      include: { wallets: { where: { is_active: true }, take: 1 } },
    });

    if (!user) {
      throw new NotFoundException('Account not found');
    }

    if (!dto?.password || !dto?.acknowledged || !dto?.confirm_delete) {
      throw new BadRequestException(
        'Password, acknowledgment, and final confirmation are required',
      );
    }

    const passwordMatches = await bcrypt.compare(
      dto.password,
      user.password_hash,
    );
    if (!passwordMatches) {
      throw new UnauthorizedException('Incorrect password');
    }

    const wallet = user.wallets?.[0];
    if (wallet && Number(wallet.balance ?? 0) !== 0) {
      throw new ForbiddenException(
        'Account cannot be deleted while wallet balance is not zero',
      );
    }

    const pendingWithdrawals = await this.prisma.withdrawal.count({
      where: {
        userId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    });

    if (pendingWithdrawals > 0) {
      throw new ForbiddenException(
        'Please clear pending withdrawals before deleting your account',
      );
    }

    const pendingDeposits = await this.prisma.deposit.count({
      where: {
        userId,
        status: { in: ['PENDING', 'PROCESSING'] },
      },
    });

    if (pendingDeposits > 0) {
      throw new ForbiddenException(
        'Please clear pending deposits before deleting your account',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user_sessions.updateMany({
        where: { user_id: userId },
        data: { is_revoked: true, expires_at: new Date() },
      });

      await tx.users.update({
        where: { id: userId },
        data: {
          is_active: false,
          is_deleted: true,
          deleted_at: new Date(),
          email: null,
          phone: `deleted_${userId.slice(0, 12)}`,
          username: `deleted_${userId}`,
          password_hash: await bcrypt.hash(
            `deleted-${userId}-${Date.now()}`,
            12,
          ),
          profile_image: null,
          bio: null,
          country: null,
          city: null,
          address: null,
          referral_code: null,
          referred_by: null,
          pin_hash: null,
        },
      });

      await tx.device_tokens.deleteMany({ where: { user_id: userId } });
      await tx.biometric_settings.deleteMany({ where: { user_id: userId } });
      await tx.api_keys.deleteMany({ where: { user_id: userId } });
      await tx.notifications.deleteMany({ where: { user_id: userId } });
    });

    await this.logger.log(`Account deleted for user ${userId}`);

    return { message: 'Account deleted successfully' };
  }

  async registerDeviceToken(userId: string, token: string, platform?: string) {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new BadRequestException('Device token is required');
    }

    const existing = await this.prisma.device_tokens.findFirst({
      where: { user_id: userId, token: normalizedToken },
    });

    if (existing) {
      await this.prisma.device_tokens.update({
        where: { id: existing.id },
        data: {
          is_active: true,
          platform: platform || existing.platform,
          last_seen: new Date(),
        },
      });
      return { message: 'Device token updated' };
    }

    await this.prisma.device_tokens.create({
      data: {
        user_id: userId,
        token: normalizedToken,
        platform: platform || 'unknown',
        is_active: true,
        last_seen: new Date(),
      },
    });

    return { message: 'Device token registered' };
  }

  // ── Refresh ──────────────────────────────────────────────────────────────────
  private static readonly REFRESH_RACE_GRACE_MS = 30_000;

  async refresh(
    userId: string,
    rawRefreshToken: string,
    ip?: string,
    deviceId?: string,
  ) {
    // Match the presented token to its own active session. This prevents a
    // refresh on one device from consuming another device's session.
    const sessions = (await this.prisma.user_sessions.findMany({
      where: {
        user_id: userId,
        expires_at: { gt: new Date() },
        OR: [{ is_revoked: false }, { is_revoked: null }],
      },
      orderBy: { created_at: 'desc' },
      include: {
        users: {
          include: { wallets: { take: 1 } },
        },
      },
    })) as any[];

    let session: any = null;
    for (const candidate of sessions) {
      if (await bcrypt.compare(rawRefreshToken, candidate.refresh_token)) {
        session = candidate;
        break;
      }
    }

    if (!session) {
      await this.logSecurityEvent(
        userId,
        'REFRESH_TOKEN_INVALID',
        'No valid session found',
        'high',
        ip,
      );
      throw new UnauthorizedException('Session not found or expired');
    }

    // Check if this refresh token has already been used (token reuse detection)
    if (
      this.deviceBinding &&
      !(await this.deviceBinding.isSessionDeviceValid(
        session.trusted_device_id,
        deviceId,
      ))
    ) {
      await this.prisma.user_sessions.update({
        where: { id: session.id },
        data: { is_revoked: true },
      });
      await this.logSecurityEvent(
        userId,
        'REFRESH_DEVICE_MISMATCH',
        'Device-bound refresh token used without its trusted device',
        'high',
        ip,
      );
      throw new UnauthorizedException('Session not valid on this device');
    }

    if (session.used_at) {
      // Token has been used before - possible theft!
      await this.handleTokenTheft(userId, session, ip);
      throw new UnauthorizedException(
        'Refresh token has been compromised. All sessions revoked.',
      );
    }

    // Atomically claim the token. A concurrent request that loses this
    // update has replayed an already-rotated token.
    const claimed = await this.prisma.user_sessions.updateMany({
      where: {
        id: session.id,
        is_revoked: false,
        used_at: null,
      },
      data: {
        used_at: new Date(),
        is_revoked: true,
      },
    });
    if (claimed.count !== 1) {
      // Lost the race to another request presenting the same token. If that
      // happened moments ago it is almost always the same client retrying or
      // refreshing twice in parallel (app resume, two tabs), not theft, so do
      // not wipe every session; just reject this duplicate request.
      const current = await this.prisma.user_sessions.findUnique({
        where: { id: session.id },
        select: { used_at: true },
      });
      const usedAt = current?.used_at ? new Date(current.used_at).getTime() : 0;
      if (usedAt && Date.now() - usedAt < AuthService.REFRESH_RACE_GRACE_MS) {
        await this.logSecurityEvent(
          userId,
          'REFRESH_RACE',
          'Concurrent refresh with the same token rejected',
          'low',
          ip,
        );
        throw new UnauthorizedException(
          'Refresh already in progress. Retry with the latest token.',
        );
      }
      await this.handleTokenTheft(userId, session, ip);
      throw new UnauthorizedException(
        'Refresh token has been compromised. All sessions revoked.',
      );
    }

    // Check for suspicious activity (different IP, user agent, etc.)
    if (ip && session.ip_address && session.ip_address !== ip) {
      await this.logSecurityEvent(
        userId,
        'SUSPICIOUS_ACTIVITY',
        `Refresh token used from different IP: ${ip} (original: ${session.ip_address})`,
        'medium',
        ip,
      );
    }

    // Issue new tokens
    const walletId = session.users?.wallets[0]?.id;
    const userRole = session.users?.role ?? 'user';
    const tokens = await this.issueTokens(userId, userRole, walletId);
    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;

    // Create new session with rotated refresh token
    await this.prisma.user_sessions.create({
      data: {
        trusted_device_id: session.trusted_device_id ?? null,
        user_id: userId,
        refresh_token: await bcrypt.hash(tokens.refresh_token, rounds),
        jwt_id: tokens.jti, // Store the new JWT ID
        ip_address: ip,
        user_agent: session.user_agent, // Keep same user agent
        device_name: session.device_name,
        device_os: session.device_os,
        expires_at: this.refreshSessionExpiry(),
      },
    });

    await this.logSecurityEvent(
      userId,
      'TOKEN_REFRESHED',
      'Refresh token rotated successfully',
      'low',
      ip,
    );

    return {
      data: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: 'Bearer',
        expires_in: 900,
      },
      message: 'Tokens refreshed successfully',
    };
  }

  // ── Logout ───────────────────────────────────────────────────────────────────
  async logout(userId: string, currentJti?: string, revokeAll = false) {
    if (revokeAll) {
      await this.prisma.user_sessions.updateMany({
        where: { user_id: userId, is_revoked: false },
        data: { is_revoked: true },
      });
    } else if (currentJti) {
      await this.prisma.user_sessions.updateMany({
        where: {
          user_id: userId,
          jwt_id: currentJti,
          OR: [{ is_revoked: false }, { is_revoked: null }],
        },
        data: { is_revoked: true },
      });
    } else {
      await this.prisma.user_sessions.updateMany({
        where: { user_id: userId, is_revoked: false },
        data: { is_revoked: true },
      });
    }

    await this.prisma.activity_logs.create({
      data: { user_id: userId, activity: 'LOGOUT' },
    });
    return { message: 'Logged out successfully' };
  }

  async revokeOtherSessions(userId: string, currentJti?: string) {
    if (!currentJti) {
      throw new BadRequestException('Current session identifier missing');
    }

    await this.prisma.user_sessions.updateMany({
      where: {
        user_id: userId,
        jwt_id: { not: currentJti },
        OR: [{ is_revoked: false }, { is_revoked: null }],
      },
      data: { is_revoked: true },
    });

    await this.prisma.activity_logs.create({
      data: {
        user_id: userId,
        activity: 'REVOKE_OTHER_SESSIONS',
      },
    });

    return { message: 'Other sessions revoked successfully' };
  }

  async getSessions(userId: string) {
    const sessions = await this.prisma.user_sessions.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        device_name: true,
        device_os: true,
        ip_address: true,
        user_agent: true,
        is_revoked: true,
        used_at: true,
        expires_at: true,
        created_at: true,
      },
    });

    return { sessions };
  }

  async revokeSession(userId: string, sessionId: string) {
    const session = await this.prisma.user_sessions.findUnique({
      where: { id: sessionId },
      select: { user_id: true, is_revoked: true },
    });
    if (!session || session.user_id !== userId) {
      throw new UnauthorizedException('Session not found');
    }
    if (session.is_revoked) {
      return { message: 'Session already revoked' };
    }

    await this.prisma.user_sessions.update({
      where: { id: sessionId },
      data: { is_revoked: true },
    });

    await this.prisma.activity_logs.create({
      data: {
        user_id: userId,
        activity: 'REVOKE_SESSION',
        metadata: { session_id: sessionId },
      },
    });

    return { message: 'Session revoked successfully' };
  }

  async triggerHoneypot(path: string, ip?: string, userAgent?: string) {
    await this.prisma.security_events.create({
      data: {
        event_type: 'HONEYPOT_TRIGGERED',
        description: `Honeypot route accessed: ${path} | userAgent: ${userAgent || 'unknown'}`,
        severity: 'high',
        ip_address: ip,
      },
    });

    return { message: 'Not found' };
  }

  // ── Set PIN ───────────────────────────────────────────────────────────────────
  async setPin(userId: string, dto: SetPinDto) {
    if (dto.pin !== dto.confirm_pin) {
      throw new BadRequestException('PINs do not match');
    }

    if (!/^\d{4,6}$/.test(dto.pin)) {
      throw new BadRequestException('PIN must be 4-6 digits');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { pin_hash: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // 🚨 Prevent overwriting existing PIN
    if (user.pin_hash) {
      throw new ForbiddenException(
        'PIN already exists. Use Change PIN instead.',
      );
    }

    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;

    // Security fix: Do NOT concatenate userId with PIN
    // bcrypt generates its own salt - userId is public anyway
    const pin_hash = await bcrypt.hash(dto.pin, rounds);

    await this.prisma.users.update({
      where: { id: userId },
      data: {
        pin_hash,
        failed_pin_attempts: 0,
      },
    });

    await this.prisma.activity_logs.create({
      data: {
        user_id: userId,
        activity: 'SET_PIN',
      },
    });

    return {
      message: 'PIN set successfully',
    };
  }

  // ── Verify PIN (used by other services) ──────────────────────────────────────
  async verifyPin(userId: string, pin: string): Promise<void> {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { pin_hash: true, failed_pin_attempts: true },
    });
    if (!user?.pin_hash)
      throw new BadRequestException('PIN not set. Please set a PIN first.');

    const failedPinAttempts = user.failed_pin_attempts ?? 0;

    if (failedPinAttempts >= MAX_PIN_ATTEMPTS)
      throw new ForbiddenException('PIN locked. Contact support.');

    // Compare the raw PIN to the stored bcrypt hash.
    // Historically some code concatenated the userId to the PIN before hashing,
    // but setPin/changePin/hash generation use the PIN alone. Use the raw PIN
    // so comparisons are consistent with how PINs are stored.
    const valid = await bcrypt.compare(pin, user.pin_hash);
    if (!valid) {
      await this.prisma.users.update({
        where: { id: userId },
        data: { failed_pin_attempts: { increment: 1 } },
      });
      const left = MAX_PIN_ATTEMPTS - failedPinAttempts - 1;
      throw new UnauthorizedException(
        `Incorrect PIN. ${left} attempt(s) remaining.`,
      );
    }
    await this.prisma.users.update({
      where: { id: userId },
      data: { failed_pin_attempts: 0 },
    });
  }

  async changePin(userId: string, dto: ChangePinDto) {
    if (dto.new_pin !== dto.confirm_pin) {
      throw new BadRequestException('New PINs do not match');
    }
    if (!/^\d{4,6}$/.test(dto.new_pin)) {
      throw new BadRequestException('PIN must be 4-6 digits');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: {
        pin_hash: true,
      },
    });

    if (!user?.pin_hash) {
      throw new BadRequestException('No PIN found');
    }

    // Security fix: Don't concatenate userId with PIN
    const validOldPin = await bcrypt.compare(dto.old_pin, user.pin_hash);

    if (!validOldPin) {
      throw new UnauthorizedException('Old PIN is incorrect');
    }

    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;

    const newHash = await bcrypt.hash(dto.new_pin, rounds);

    await this.prisma.users.update({
      where: { id: userId },
      data: {
        pin_hash: newHash,
        failed_pin_attempts: 0,
      },
    });

    await this.prisma.activity_logs.create({
      data: {
        user_id: userId,
        activity: 'CHANGE_PIN',
      },
    });

    return {
      message: 'PIN changed successfully',
    };
  }

  async resetForgottenPin(userId: string, dto: ResetPinDto) {
    if (dto.new_pin !== dto.confirm_pin) {
      throw new BadRequestException('PINs do not match');
    }
    if (!/^\d{4,6}$/.test(dto.new_pin)) {
      throw new BadRequestException('PIN must be 4-6 digits');
    }

    const user = await this.prisma.users.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // The supplied phone must be the account's phone (it was previously ignored).
    if (
      !dto.phone ||
      this.normalizePhoneNumber(dto.phone) !==
        this.normalizePhoneNumber(user.phone)
    ) {
      throw new BadRequestException('Phone number does not match this account');
    }

    // Check the password before consuming the OTP.
    const validPassword = await bcrypt.compare(
      dto.password,
      user.password_hash,
    );

    if (!validPassword) {
      throw new UnauthorizedException('Incorrect password');
    }

    await this.verifyOtp(user.phone, dto.otp, 'forgot_pin');

    const rounds = Number(this.cfg.get('BCRYPT_ROUNDS')) || 12;

    // Security fix: Don't concatenate userId with PIN
    const pin_hash = await bcrypt.hash(dto.new_pin, rounds);

    await this.prisma.users.update({
      where: { id: userId },
      data: {
        pin_hash,
        failed_pin_attempts: 0,
      },
    });

    await this.prisma.activity_logs.create({
      data: {
        user_id: userId,
        activity: 'RESET_FORGOTTEN_PIN',
      },
    });

    return {
      message: 'PIN reset successfully',
    };
  }

  // ── Send OTP ─────────────────────────────────────────────────────────────────
  async sendOtp(
    userId: string,
    phone: string,
    purpose: string,
    background = false,
  ) {
    const recent = await this.prisma.otp_verifications.findFirst({
      where: {
        user_id: userId,
        purpose,
        verified: false,
        created_at: { gte: new Date(Date.now() - 60_000) },
      },
    });

    if (recent)
      throw new BadRequestException(
        'Please wait 60 seconds before requesting a new OTP',
      );

    const code = generateOtp(6);

    const expires_at = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000);

    await this.prisma.otp_verifications.create({
      data: {
        user_id: userId,
        otp_code: hashOtp(code, this.otpSecret()),
        purpose,
        expires_at,
      },
    });
    // Send OTP via configured SMS provider (do not log OTP contents)
    const deliver = async () => {
      try {
        const message = `Your FARM OTP is ${code}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`;
        // Prefer push if user has push notifications enabled and device tokens registered
        try {
          const settings = await this.prisma.user_settings.findUnique({
            where: { user_id: userId },
          });
          if (settings?.push_notifications) {
            const pushBody = `Your FARM OTP is ${code}. It expires in ${OTP_EXPIRY_MINUTES} minutes.`;
            const pushed = await this.notifications.sendPush(
              userId,
              'Your FARM OTP',
              pushBody,
              {
                otp_code: code,
                otp_expires: String(OTP_EXPIRY_MINUTES),
                purpose,
                auto_fill: 'true',
              },
            );
            if (pushed) {
              return { message: 'OTP sent to your device' };
            }
          }
        } catch (e) {
          this.logger.debug('Push attempt failed or not configured: ' + e);
        }

        await this.notifications.sendSms(phone, message);
      } catch (e) {
        this.logger.error('OTP SMS send failed: ' + e);
      }
      return { message: 'OTP sent to your phone' };
    };

    if (background) {
      void deliver();
      return { message: 'OTP delivery started' };
    }
    return deliver();
  }

  // Add this method inside the AuthService class

  async resendOtp(userId: string) {
    const user = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { phone: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.sendOtp(userId, user.phone, 'phone_verification');
  }
  // ── Private helpers ───────────────────────────────────────────────────────────
  private normalizePhoneNumber(phone?: string | null) {
    if (!phone) return '';
    const digits = phone.toString().replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('254') && digits.length === 12) {
      return `+${digits}`;
    }
    if (digits.startsWith('0') && digits.length === 10) {
      return `+254${digits.slice(1)}`;
    }
    if (digits.startsWith('254') && digits.length > 12) {
      return `+${digits.slice(0, 12)}`;
    }
    return `+${digits}`;
  }

  private async issueTokens(userId: string, role: string, walletId?: string) {
    // Security: Secrets MUST be set in environment (no hardcoded fallbacks)
    const accessSecret = this.cfg.get<string>('JWT_ACCESS_SECRET');
    const refreshSecret = this.cfg.get<string>('JWT_REFRESH_SECRET');

    if (!accessSecret || !refreshSecret) {
      throw new Error(
        'JWT secrets not configured. Set JWT_ACCESS_SECRET and JWT_REFRESH_SECRET in environment.',
      );
    }
    const jti = randomBytes(16).toString('hex');
    const payload = { sub: userId, role, wallet_id: walletId, jti };
    const [access_token, refresh_token] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: accessSecret,
        expiresIn: this.cfg.get('JWT_ACCESS_EXPIRES', '15m'),
      }),
      this.jwt.signAsync(payload, {
        secret: refreshSecret,
        expiresIn: `${this.refreshTtlDays()}d`,
      }),
    ]);
    return { access_token, refresh_token, jti };
  }

  private refreshSessionExpiry(): Date {
    const days = this.refreshTtlDays();
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }

  private async handleTokenTheft(userId: string, session: any, ip?: string) {
    // Revoke ALL active sessions for this user (token family rotation)
    await this.prisma.user_sessions.updateMany({
      where: { user_id: userId, is_revoked: false },
      data: { is_revoked: true },
    });

    // Log critical security event
    await this.logSecurityEvent(
      userId,
      'TOKEN_THEFT_DETECTED',
      `Refresh token reuse detected. Session ID: ${session.id}. All sessions revoked.`,
      'critical',
      ip,
    );

    // Optional: Send alert email/SMS to user
    // TODO: Implement notification service call
    this.logger.warn(
      `🚨 TOKEN THEFT DETECTED for user ${userId} from IP ${ip}`,
    );
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupExpiredSessions() {
    const deleted = await this.prisma.user_sessions.deleteMany({
      where: {
        expires_at: { lt: new Date() },
      },
    });

    if (deleted.count > 0) {
      this.logger.log(`Cleaned up ${deleted.count} expired user session(s)`);
    }

    await this.prisma.pending_login_verifications.deleteMany({
      where: { expires_at: { lt: new Date() } },
    });
  }

  private async logSecurityEvent(
    userId: string,
    eventType: string,
    description: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    ip?: string,
  ) {
    try {
      await this.prisma.security_events.create({
        data: {
          user_id: userId,
          event_type: eventType,
          description,
          severity,
          ip_address: ip,
        },
      });

      if (
        severity === 'medium' ||
        severity === 'high' ||
        severity === 'critical'
      ) {
        const logMessage = `[SECURITY EVENT] ${severity.toUpperCase()} ${eventType} user=${userId} ip=${ip ?? 'unknown'} description=${description}`;
        if (severity === 'critical') {
          this.logger.error(logMessage, 'AuthService');
        } else {
          this.logger.warn(logMessage, 'AuthService');
        }
      }
    } catch (error: any) {
      // Don't fail the main operation if logging fails
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to log security event: ${message}`);
    }
  }
}
