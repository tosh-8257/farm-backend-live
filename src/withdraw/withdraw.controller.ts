import type { AuthRequest } from '../common/types/auth-user';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Permissions } from '../common/decorators/permissions.decorator';
import { RequireOwnership } from '../common/decorators/ownership.decorator';

import { WithdrawService } from './withdraw.service';
import { KycGuard } from '../common/guards/kyc.guard';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

import { CreateWithdrawDto } from './dto/create-withdraw.dto';
import { TransferWithdrawDto } from './dto/transfer-withdraw.dto';

@Controller({
  path: 'withdraw',
  version: '1',
})
export class WithdrawController {
  constructor(private readonly withdrawService: WithdrawService) {}

  @Permissions('withdraw:write')
  @UseGuards(JwtAuthGuard, KycGuard)
  @Throttle({
    default: {
      limit: 10,
      ttl: 60000,
    },
  })
  @Post('create')
  async create(@Req() req, @Body() dto: CreateWithdrawDto) {
    return this.withdrawService.createWithdrawal(req.user.id, dto);
  }

  @Permissions('withdraw:write')
  @UseGuards(JwtAuthGuard, KycGuard)
  @Throttle({
    default: {
      limit: 10,
      ttl: 60000,
    },
  })
  @Post('transfer')
  async transfer(@Req() req, @Body() dto: TransferWithdrawDto) {
    // Normalize to existing CreateWithdrawDto shape expected by service
    const createDto: any = {
      amount: dto.amount,
      method: 'MOBILE_MONEY',
      phoneNumber: dto.phoneNumber,
      accountName: dto.accountName,
      mobileMoneyProvider: dto.mobileMoneyProvider,
      pin: dto.pin,
    };

    return this.withdrawService.createWithdrawal(req.user.id, createDto);
  }

  @Permissions('withdraw:read')
  @UseGuards(JwtAuthGuard)
  @Get('history')
  async history(@Req() req) {
    return this.withdrawService.getUserWithdrawals(req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('status/:reference')
  async getStatus(@Req() req, @Param('reference') reference: string) {
    const status = await this.withdrawService.getWithdrawalStatus(
      reference,
      req.user.id,
    );
    if (!status) {
      return { success: false, message: 'Withdrawal not found' };
    }
    return { success: true, status };
  }

  @Permissions('withdraw:read')
  @UseGuards(JwtAuthGuard)
  @Get('crypto/currencies')
  async getNowpaymentsCryptoCurrencies() {
    return this.withdrawService.getNowpaymentsCryptoCurrencies();
  }

  @Permissions('withdraw:read')
  @UseGuards(JwtAuthGuard)
  @Get('crypto/minimum')
  async getNowpaymentsCryptoMinimum() {
    return this.withdrawService.getNowpaymentsCryptoMinimum();
  }

  @Permissions('withdraw:read')
  @UseGuards(JwtAuthGuard)
  @Get('crypto/limits/:currency')
  async cryptoLimit(@Param('currency') currency: string) {
    return this.withdrawService.getCryptoCoinLimit(currency);
  }

  @Permissions('withdraw:write')
  @UseGuards(JwtAuthGuard, KycGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('crypto')
  async createNowpaymentsCrypto(
    @Req() req: AuthRequest,
    @Body() dto: CreateWithdrawDto,
  ) {
    return this.withdrawService.createNowpaymentsCryptoWithdrawal(
      req.user.id,
      dto,
    );
  }

  @Permissions('withdraw:read')
  @UseGuards(JwtAuthGuard)
  @Get('crypto/networks')
  async getCryptoNetworks(@Req() req, @Query('token') token: string) {
    return this.withdrawService.getProviderNetworks(token);
  }

  @UseGuards(JwtAuthGuard)
  @Get('paystack/destinations')
  async getPaystackDestinations(@Query('type') type?: string) {
    const normalizedType = type?.trim().toLowerCase();
    if (normalizedType && !['kepss', 'mobile_money'].includes(normalizedType)) {
      throw new BadRequestException('Unsupported Paystack destination type');
    }
    return {
      data: await this.withdrawService.getPaystackDestinations(normalizedType),
    };
  }

  @Permissions('withdraw:read')
  @RequireOwnership('id')
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async getOne(@Param('id') id: string, @Req() req: AuthRequest) {
    return this.withdrawService.getWithdrawal(id, req.user?.id);
  }
}
