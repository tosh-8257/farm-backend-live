import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty() @IsNotEmpty() @IsString() refresh_token!: string;

  @ApiPropertyOptional({
    description: 'Device id; required for device-bound refresh tokens',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  device_id?: string;
}
