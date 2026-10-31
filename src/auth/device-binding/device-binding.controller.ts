import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthUser } from '../../common/types/auth-user';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Permissions } from '../../common/decorators/permissions.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums';
import { JwtGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { DiditService } from '../../didit/didit.service';
import { DeviceBindingService } from './device-binding.service';
import {
  DeviceChallengeDto,
  PendingDeviceStatusDto,
  RecoveryCompleteDto,
  RecoveryOtpDto,
  RecoveryReviewRejectDto,
  RecoveryStartDto,
} from './dto/device-proof.dto';

type JtiUser = AuthUser & { jti?: string };

@ApiTags('Auth - devices')
@Controller({ path: 'auth/device', version: '1' })
export class DeviceBindingController {
  constructor(
    private readonly devices: DeviceBindingService,
    private readonly didit: DiditService,
  ) {}

  @Public()
  @Get('config')
  @ApiOperation({ summary: 'Whether device binding is enforced' })
  config() {
    return { data: { enabled: this.devices.isEnabled() } };
  }

  @Public()
  @Post('challenge')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Get a single-use nonce to sign at login' })
  challenge(@Body() dto: DeviceChallengeDto, @Req() req: Request) {
    return this.devices.createChallenge(dto.device_id, req.ip);
  }

  @Public()
  @Get('pending/:id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'New device polls its approval status' })
  pending(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PendingDeviceStatusDto,
  ) {
    return this.devices.pendingStatus(id, q.device_id);
  }

  @Public()
  @Post('recovery/start')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  @ApiOperation({ summary: 'Send an SMS code to recover onto this device' })
  recoveryStart(@Body() dto: RecoveryStartDto, @Req() req: Request) {
    return this.devices.startRecovery(
      dto.pending_device_id,
      dto.device_id,
      req.ip,
    );
  }

  @Public()
  @Post('recovery/verify-otp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @ApiOperation({ summary: 'Verify the SMS code and open a Didit ID check' })
  recoveryOtp(@Body() dto: RecoveryOtpDto, @Req() req: Request) {
    return this.devices.verifyRecoveryOtp(
      dto.recovery_id,
      dto.device_id,
      dto.otp,
      (vendor) => this.didit.createDeviceRecoverySession(vendor),
      req.ip,
    );
  }

  @Public()
  @Get('recovery/:id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  recoveryStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: PendingDeviceStatusDto,
  ) {
    return this.devices.recoveryStatus(id, q.device_id);
  }

  @Public()
  @Post('recovery/complete')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  @ApiOperation({ summary: 'Revoke old devices and trust this one' })
  recoveryComplete(@Body() dto: RecoveryCompleteDto, @Req() req: Request) {
    return this.devices.completeRecovery(
      dto.recovery_id,
      dto.device_id,
      req.ip,
    );
  }

  // ── Signed-in user ──────────────────────────────────────────────────────
  @UseGuards(JwtGuard, RolesGuard)
  @ApiBearerAuth('JWT')
  @Permissions('sessions:read')
  @Get('list')
  list(@CurrentUser() user: JtiUser) {
    return this.devices.listDevices(user.id, user.jti);
  }

  @UseGuards(JwtGuard, RolesGuard)
  @ApiBearerAuth('JWT')
  @Permissions('sessions:write')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  approve(
    @CurrentUser() user: JtiUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.devices.decidePending(user.id, user.jti, id, true, req.ip);
  }

  @UseGuards(JwtGuard, RolesGuard)
  @ApiBearerAuth('JWT')
  @Permissions('sessions:write')
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  reject(
    @CurrentUser() user: JtiUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.devices.decidePending(user.id, user.jti, id, false, req.ip);
  }

  @UseGuards(JwtGuard, RolesGuard)
  @ApiBearerAuth('JWT')
  @Permissions('sessions:write')
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  revoke(
    @CurrentUser() user: JtiUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.devices.revokeDevice(
      user.id,
      id,
      { id: user.id, admin: false },
      req.ip,
    );
  }
}

@ApiTags('Admin - devices')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/users/:userId/devices', version: '1' })
export class DeviceAdminController {
  constructor(private readonly devices: DeviceBindingService) {}

  @Permissions('admin:read')
  @Get()
  list(@Param('userId', ParseUUIDPipe) userId: string) {
    return this.devices.listDevices(userId);
  }

  @Permissions('admin:write')
  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentUser() admin: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.devices.revokeDevice(
      userId,
      id,
      { id: admin.id, admin: true },
      req.ip,
    );
  }
}

@ApiTags('Admin - device recovery')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/device-recoveries', version: '1' })
export class DeviceRecoveryAdminController {
  constructor(private readonly devices: DeviceBindingService) {}

  @Permissions('admin:read')
  @Get('review')
  @ApiOperation({ summary: 'Recoveries awaiting manual owner review' })
  list() {
    return this.devices.listRecoveryReviews();
  }

  @Permissions('admin:write')
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    return this.devices.approveRecoveryReview(id, admin.id, req.ip);
  }

  @Permissions('admin:write')
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() admin: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecoveryReviewRejectDto,
    @Req() req: Request,
  ) {
    return this.devices.rejectRecoveryReview(id, admin.id, dto.reason, req.ip);
  }
}
