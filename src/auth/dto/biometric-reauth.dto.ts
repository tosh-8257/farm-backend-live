import { Type } from 'class-transformer';
import { IsOptional, IsString, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DeviceProofDto } from '../device-binding/dto/device-proof.dto';

export class BiometricReauthDto {
  @ApiProperty({
    type: DeviceProofDto,
    description:
      'Signature from the device key. The OS should require biometrics before the key can sign.',
  })
  @ValidateNested()
  @Type(() => DeviceProofDto)
  device!: DeviceProofDto;

  @ApiPropertyOptional({
    description:
      'Current refresh token, when the app still has one. A missing or stale token still renews the session for this trusted device.',
  })
  @IsOptional()
  @IsString()
  refresh_token?: string;
}
