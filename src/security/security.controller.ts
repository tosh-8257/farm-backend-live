import type { AuthUser } from '../common/types/auth-user';
import {
  Controller,
  Get,
  Put,
  Post,
  Body,
  UseGuards,
  Logger,
  BadRequestException,
  Delete,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsBoolean, IsString, IsOptional, Length } from 'class-validator';
import { SecurityService } from './security.service';
import { AuthService } from '../auth/auth.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';

class UpdateBiometricsDto {
  @IsBoolean()
  enabled!: boolean;

  @IsOptional()
  @IsString()
  deviceFingerprint?: string;

  @IsOptional()
  @IsString()
  biometricType?: string;

  @IsOptional()
  @IsString()
  @Length(4, 6)
  pin?: string;
}

class VerifyDeviceDto {
  @IsString()
  deviceFingerprint!: string;
}

class CreateBiometricsDto {
  @IsString()
  deviceFingerprint!: string;

  @IsOptional()
  @IsString()
  biometricType?: string;

  @IsString()
  @Length(4, 6)
  pin!: string;
}

@ApiTags('Security')
@Controller({ path: 'security', version: '1' })
export class SecurityController {
  private readonly logger = new Logger(SecurityController.name);
  constructor(
    private readonly svc: SecurityService,
    private readonly auth: AuthService,
  ) {}

  private async confirmPin(userId: string, pin?: string) {
    if (!pin) {
      throw new BadRequestException(
        'Enter your PIN to turn on biometrics for payments',
      );
    }
    await this.auth.verifyPin(userId, pin);
  }

  @Permissions('security:read')
  @Get('settings')
  @UseGuards(JwtGuard, RolesGuard)
  settings(@CurrentUser() user: AuthUser) {
    this.logger.log(`settings requested by user=${user?.id || 'anon'}`);
    return this.svc.getSettings(user.id);
  }

  @Permissions('security:write')
  @Put('biometrics')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enable or disable biometric authentication' })
  async updateBiometrics(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateBiometricsDto,
  ) {
    this.logger.log(
      `Biometric update requested by user=${user?.id}, enabled=${dto.enabled}`,
    );

    if (dto.enabled) {
      if (!dto.deviceFingerprint) {
        throw new BadRequestException(
          'deviceFingerprint is required when enabling biometrics',
        );
      }
      await this.confirmPin(user.id, dto.pin);
      return this.svc.enableBiometrics(
        user.id,
        dto.deviceFingerprint,
        dto.biometricType,
      );
    } else {
      return this.svc.disableBiometrics(user.id);
    }
  }

  @Permissions('security:write')
  @Post('verify-device')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Verify device fingerprint on app resume' })
  async verifyDevice(
    @CurrentUser() user: AuthUser,
    @Body() dto: VerifyDeviceDto,
  ) {
    this.logger.log(`Device verification requested by user=${user?.id}`);
    return this.svc.verifyDevice(user.id, dto.deviceFingerprint);
  }

  @Permissions('security:write')
  @Post('biometrics')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Enable biometric authentication for this device' })
  async createBiometrics(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBiometricsDto,
  ) {
    this.logger.log(`Create biometric requested by user=${user?.id}`);

    if (!dto.deviceFingerprint) {
      throw new BadRequestException('deviceFingerprint is required');
    }
    await this.confirmPin(user.id, dto.pin);

    return this.svc.enableBiometrics(
      user.id,
      dto.deviceFingerprint,
      dto.biometricType,
    );
  }

  @Permissions('security:read')
  @Get('biometrics')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get biometric settings status' })
  async getBiometricStatus(@CurrentUser() user: AuthUser) {
    this.logger.log(`Biometric status requested by user=${user?.id}`);
    return this.svc.getBiometricStatus(user.id);
  }

  @Permissions('security:write')
  @Delete('biometrics')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Delete biometric trusted device or disable biometrics',
  })
  async deleteBiometrics(@CurrentUser() user: AuthUser) {
    this.logger.log(`Delete biometric requested by user=${user?.id}`);
    return this.svc.deleteBiometrics(user.id);
  }
}
