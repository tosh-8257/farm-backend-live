import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ChainWalletService } from './chain-wallet.service';
import { ChainSyncService } from './chain-sync.service';

@ApiTags('Wallet - Algorand')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'wallet/chain', version: '1' })
export class ChainWalletController {
  constructor(private readonly svc: ChainWalletService) {}
  @Get('status') status() {
    return this.svc.status();
  }
  @Get() mine(@CurrentUser() u: any) {
    return this.svc.mine(u.id);
  }
  @Get('deposits') deposits(@CurrentUser() u: any) {
    return this.svc.myDeposits(u.id);
  }
}

/**
 * 'send' is the real (on-chain) mode. 'execute' is kept as an alias, but the
 * global SafeInputValidationPipe rejects that keyword, so clients use 'send'.
 * Anything else is a dry run.
 */
export function reconcileMode(mode?: string): 'dry' | 'execute' {
  return mode === 'send' || mode === 'execute' ? 'execute' : 'dry';
}

@ApiTags('Admin - Algorand')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/chain', version: '1' })
export class AdminChainController {
  constructor(
    private readonly svc: ChainWalletService,
    private readonly sync: ChainSyncService,
  ) {}
  @Get('outbox') outbox() {
    return this.sync.summary();
  }
  @Post('outbox/process') async processOutbox() {
    const e = await this.sync.enqueue();
    return { data: { ...e, ...(await this.sync.process()) } };
  }
  @Post('outbox/retry') retryOutbox() {
    return this.sync.retryNow();
  }
  @Get('status') status() {
    return this.svc.status();
  }
  @Post('deposits/sync') async syncDeposits() {
    const polled = await this.svc.pollUsdc();
    return { data: { ...polled, ...(await this.svc.creditPending()) } };
  }
  @Get('readiness') readiness(@Query('transfers') transfers?: string) {
    const n = Number(transfers);
    return this.svc.readiness(Number.isFinite(n) && n > 0 ? n : undefined);
  }
  @Get('reconcile') runs() {
    return this.svc.runs();
  }
  @Post('reconcile') reconcile(
    @CurrentUser() u: any,
    @Query('mode') mode?: string,
    @Query('limit') limit?: string,
    @Query('address') address?: string,
  ) {
    return this.svc.reconcile(
      u.id,
      reconcileMode(mode),
      Number(limit ?? 100) || 100,
      address,
    );
  }
}
