import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsPositive,
  IsOptional,
  Length,
} from 'class-validator';
import { WalletsService } from './wallets.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { KycGuard } from '../common/guards/kyc.guard';
import { EmailVerifiedGuard } from '../common/guards/email-verified.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';

class SendFundsDto {
  @IsNotEmpty() @IsString() recipient_identifier!: string;
  @IsNumber() @IsPositive() amount!: number;
  @IsOptional() @IsString() @Length(4, 6) pin?: string;
  @IsOptional() biometric_auth?: boolean;
  @IsOptional() @IsString() device_fingerprint?: string;
  @IsOptional() @IsString() description?: string;
}

@ApiTags('Wallet')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, EmailVerifiedGuard)
@Controller({ path: 'wallet', version: '1' })
export class WalletsController {
  constructor(private readonly svc: WalletsService) {}

  @Permissions('wallet:read')
  @Get()
  @ApiOperation({ summary: 'Get my wallet balance' })
  getWallet(@CurrentUser() u: any) {
    return this.svc.getMyWallet(u.id);
  }

  @Permissions('wallet:write')
  @Post('send')
  @UseGuards(JwtGuard, KycGuard)
  @ApiOperation({ summary: 'Send FARM tokens (PIN required)' })
  send(@CurrentUser() u: any, @Body() dto: SendFundsDto, @Req() req: Request) {
    return this.svc.sendFunds(u.id, dto, req.ip || '');
  }

  @Permissions('wallet:read')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get('transactions')
  @ApiOperation({ summary: 'List my transactions' })
  transactions(@CurrentUser() u: any, @Query() q: any) {
    return this.svc.getTransactions(u.id, q);
  }
}
