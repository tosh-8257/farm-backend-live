import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import { DeviceProofDto } from '../device-binding/dto/device-proof.dto';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class FirebaseLoginDto {
  @ApiPropertyOptional({
    description: 'Phone number or identifier linked to the account',
  })
  @IsOptional()
  @IsString()
  identifier?: string;

  @ApiPropertyOptional({
    description: 'Firebase ID token returned after phone verification',
  })
  @IsOptional()
  @IsString()
  firebase_token?: string;

  @ApiPropertyOptional({
    description: 'Alternate Firebase ID token field used by the Flutter client',
  })
  @IsOptional()
  @IsString()
  firebaseIdToken?: string;

  @ApiPropertyOptional({ description: 'Country code such as +254 or 254' })
  @IsOptional()
  @IsString()
  country_code?: string;

  @ApiPropertyOptional({ description: 'Cloudflare Turnstile token' })
  @IsOptional()
  @IsString()
  cf_turnstile_response?: string;

  @ApiPropertyOptional({ description: 'Alternate Turnstile token field' })
  @IsOptional()
  @IsString()
  turnstile_token?: string;

  @ApiPropertyOptional({
    type: DeviceProofDto,
    description: 'Device-binding proof (required when DEVICE_BINDING_ENABLED)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeviceProofDto)
  device?: DeviceProofDto;
}
