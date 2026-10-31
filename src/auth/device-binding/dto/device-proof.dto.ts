import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';

const DEVICE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Proof of possession of a device key, sent with a login request. */
export class DeviceProofDto {
  @ApiProperty() @Matches(DEVICE_ID) device_id!: string;
  @ApiProperty({ description: 'base64 SPKI or raw public key' })
  @IsString()
  @Length(40, 400)
  public_key!: string;
  @ApiProperty({ enum: ['ed25519', 'p256'] })
  @IsIn(['ed25519', 'p256'])
  key_alg!: 'ed25519' | 'p256';
  @ApiProperty() @IsString() @IsNotEmpty() challenge_id!: string;
  @ApiProperty({ description: 'base64 signature over the challenge message' })
  @IsString()
  @Length(40, 200)
  signature!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['android', 'ios', 'web'])
  platform?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;
}

export class DeviceChallengeDto {
  @ApiProperty() @Matches(DEVICE_ID) device_id!: string;
}

export class PendingDeviceStatusDto {
  @ApiProperty() @Matches(DEVICE_ID) device_id!: string;
}

export class RecoveryStartDto {
  @ApiProperty() @IsString() pending_device_id!: string;
  @ApiProperty() @Matches(DEVICE_ID) device_id!: string;
}

export class RecoveryOtpDto {
  @ApiProperty() @IsString() recovery_id!: string;
  @ApiProperty() @Matches(DEVICE_ID) device_id!: string;
  @ApiProperty() @Matches(/^\d{6}$/) otp!: string;
}

export class RecoveryCompleteDto {
  @ApiProperty() @IsString() recovery_id!: string;
  @ApiProperty() @Matches(DEVICE_ID) device_id!: string;
}
