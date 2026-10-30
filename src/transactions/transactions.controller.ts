import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { Throttle } from '@nestjs/throttler';

@ApiTags('Transactions')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Controller({ path: 'transactions', version: '1' })
export class TransactionsController {
  constructor(private readonly svc: TransactionsService) {}
  @Permissions('transactions:read')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get()      findAll(@CurrentUser() u: any, @Query() q: any) { return this.svc.findAll(u.id, q); }

  @Permissions('transactions:read')
  @Get(':id') findOne(@CurrentUser() u: any, @Param('id') id: string) { return this.svc.findOne(u.id, id); }
}
