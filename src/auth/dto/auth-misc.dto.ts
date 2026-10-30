import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class ResendOtpDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(32)
  phone!: string;
}

export class ResendEmailVerificationDto {
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

export class ResolveLoginEmailDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(254)
  identifier!: string;
}

export class DeviceTokenDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(4096)
  token!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  platform?: string;
}
