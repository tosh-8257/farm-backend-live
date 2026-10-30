import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsPositive,
} from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { Permissions } from '../common/decorators/permissions.decorator';
import { RequireOwnership } from '../common/decorators/ownership.decorator';

import { DepositService } from './deposit.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

class CreateDepositDto {
  @IsNotEmpty()
  @IsNumber()
  amount_fiat!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  paymentMethod?: string;

  // Accept frontend field name variations
  @IsOptional()
  @IsString()
  payment_method?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  payment_channel?: string;

  @IsOptional()
  @IsString()
  payment_provider?: string;

  @IsOptional()
  @IsString()
  provider?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  // Legacy clients may still send channels; the deposit service chooses the
  // Paystack channel from paymentMethod instead of trusting this client value.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(['card', 'mobile_money', 'bank', 'bank_transfer'], { each: true })
  channels?: string[];
}

@Controller({ path: 'deposit', version: '1' })
@UseGuards(JwtAuthGuard)
export class DepositController {
  constructor(private readonly depositService: DepositService) {}

  @Permissions('payments:write')
  @Throttle({
    default: {
      limit: 10,
      ttl: 60000,
    },
  })
  @Post('create')
  async create(@Req() req: any, @Body() dto: CreateDepositDto) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User ID not found in request');
    }
    return this.depositService.createDeposit(userId, dto);
  }

  @Permissions('payments:read')
  @Get('history')
  async history(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User ID not found in request');
    }

    return this.depositService.getUserDeposits(userId);
  }

  @Permissions('payments:read')
  @Get('wallet')
  async wallet(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User ID not found in request');
    }

    return this.depositService.getWalletBalance(userId);
  }

  @Permissions('payments:read')
  @Throttle({
    default: {
      limit: 10,
      ttl: 60000,
    },
  })
  @Post('verify/:reference')
  async verify(@Param('reference') reference: string, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User ID not found in request');
    }

    return this.depositService.verifyDepositStatus(userId, reference);
  }

  @Permissions('payments:read')
  @Get('status/:reference')
  async status(@Param('reference') reference: string, @Req() req: any) {
    const userId = req.user?.id;
    if (!userId) {
      throw new Error('User ID not found in request');
    }

    return this.depositService.getDepositStatus(userId, reference);
  }

  @Permissions('payments:read')
  @RequireOwnership('id')
  @Get(':id')
  async getOne(@Param('id') id: string, @Req() req: any) {
    const userId = req.user?.id;
    return this.depositService.getDepositById(id, userId);
  }
}

class CreateNowpaymentsDepositDto {
  @IsNumber()
  @IsPositive()
  price_amount!: number;

  @IsString()
  @IsIn(['usd', 'USD'])
  price_currency!: string;

  @IsNotEmpty()
  @IsString()
  pay_currency!: string;
}

@Controller({ path: 'wallet/deposit', version: '1' })
@UseGuards(JwtAuthGuard)
export class NowpaymentsWalletController {
  constructor(private readonly depositService: DepositService) {}

  @Permissions('payments:read')
  @Get('crypto/currencies')
  currencies() {
    return this.depositService.getNowpaymentsCurrencies();
  }

  @Permissions('payments:read')
  @Get('crypto/minimum/:currency')
  minimum(@Param('currency') currency: string) {
    return this.depositService.getNowpaymentsCryptoMinimum(currency);
  }

  @Permissions('payments:read')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('crypto/estimate')
  async estimate(
    @Query('amount') amountRaw: string,
    @Query('currency') currency: string,
  ) {
    return {
      data: await this.depositService.estimateUsdCrypto(
        Number(amountRaw),
        currency,
      ),
    };
  }

  // From main (83bcfe6): path-param variant kept for existing clients.
  @Permissions('payments:read')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('crypto/estimate/:currency')
  estimateByCurrency(
    @Param('currency') currency: string,
    @Query('price_amount') priceAmount: string,
  ) {
    return this.depositService.getNowpaymentsCryptoEstimate(
      currency,
      priceAmount,
    );
  }

  @Permissions('payments:write')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('crypto')
  createCrypto(@Req() req: any, @Body() dto: CreateNowpaymentsDepositDto) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }
    return this.depositService.createNowpaymentsCryptoDeposit(userId, dto);
  }

  @Permissions('payments:read')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('status/:paymentId')
  status(@Req() req: any, @Param('paymentId') paymentId: string) {
    const userId = req.user?.id;
    if (!userId) {
      throw new BadRequestException('User ID not found in request');
    }
    return this.depositService.getNowpaymentsCryptoDepositStatus(
      userId,
      paymentId,
    );
  }
}
