import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { MkulimaBillingService } from './mkulima-billing.service';

@ApiTags('Admin')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/mkulima-billing', version: '1' })
export class MkulimaBillingController {
  constructor(private readonly billing: MkulimaBillingService) {}

  @Get()
  @ApiOperation({
    summary:
      'Mkulima AI usage: provider cost, FARM charged, margin and shortfall (admin only).',
  })
  summary(@Query('days') days?: string) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return this.billing.adminSummary(d);
  }
}
