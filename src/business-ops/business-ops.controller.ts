import {
  Body,
  Controller,
  Get,
  Ip,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { BusinessAccessService } from './business-access.service';
import { BusinessTeamService } from './business-team.service';
import { BusinessFinanceService } from './business-finance.service';
import { BusinessCommerceService } from './business-commerce.service';
import { BusinessEscrowService } from './business-escrow.service';
import {
  AddMemberDto,
  BusinessEscrowDto,
  CustomerDto,
  InvoiceDto,
  PaymentLinkDto,
  PinDto,
  ProfileDto,
  ToggleLinkDto,
  UpdateMemberDto,
} from './business-ops.dto';

const UUID = new ParseUUIDPipe({ version: '4' });

@ApiTags('Business operations')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'business', version: '1' })
export class BusinessOpsController {
  constructor(
    private readonly access: BusinessAccessService,
    private readonly team: BusinessTeamService,
    private readonly finance: BusinessFinanceService,
    private readonly commerce: BusinessCommerceService,
    private readonly escrow: BusinessEscrowService,
  ) {}

  @Get('context')
  @ApiOperation({ summary: 'My business, role and permissions' })
  context(@CurrentUser() u: any) {
    return this.access.context(u.id);
  }

  @Get('dashboard') dashboard(@CurrentUser() u: any) {
    return this.finance.dashboard(u.id);
  }
  @Get('wallet') wallet(@CurrentUser() u: any) {
    return this.finance.wallet(u.id);
  }
  /** Free move from the business wallet to the owner's personal wallet (BUSINESS_WALLET_ENABLED). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('wallet/move-to-personal')
  moveToPersonal(
    @CurrentUser() u: any,
    @Body() body: { amount: number; pin?: string; note?: string },
  ) {
    return this.finance.moveToPersonal(u.id, body);
  }
  @Get('analytics') analytics(
    @CurrentUser() u: any,
    @Query('range') range = '30d',
  ) {
    return this.finance.analytics(u.id, range);
  }

  @Get('transactions') transactions(@CurrentUser() u: any, @Query() q: any) {
    return this.finance.transactions(u.id, q);
  }
  @Get('transactions/:id') transaction(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.finance.transaction(u.id, id);
  }

  @Get('payouts') payouts(@CurrentUser() u: any, @Query() q: any) {
    return this.finance.payouts(u.id, q);
  }
  // POST business/payouts moved to BusinessPayoutsController (automatic payouts).

  @Get('team') team_(@CurrentUser() u: any) {
    return this.team.list(u.id);
  }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('team')
  addMember(@CurrentUser() u: any, @Body() dto: AddMemberDto) {
    return this.team.add(u.id, dto);
  }
  @Patch('team/:id') updateMember(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.team.update(u.id, id, dto);
  }
  @Post('team/:id/remove') removeMember(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Body() dto: PinDto,
  ) {
    return this.team.remove(u.id, id, dto.pin);
  }

  @Get('profile') profile(@CurrentUser() u: any) {
    return this.team.getProfile(u.id);
  }
  @Put('profile') updateProfile(
    @CurrentUser() u: any,
    @Body() dto: ProfileDto,
  ) {
    return this.team.updateProfile(u.id, dto);
  }

  @Get('customers') customers(@CurrentUser() u: any, @Query() q: any) {
    return this.commerce.listCustomers(u.id, q);
  }
  @Get('customers/:id') customer(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.commerce.getCustomer(u.id, id);
  }
  @Post('customers') createCustomer(
    @CurrentUser() u: any,
    @Body() dto: CustomerDto,
  ) {
    return this.commerce.createCustomer(u.id, dto);
  }
  @Put('customers/:id') updateCustomer(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Body() dto: CustomerDto,
  ) {
    return this.commerce.updateCustomer(u.id, id, dto);
  }

  @Get('invoices') invoices(@CurrentUser() u: any, @Query() q: any) {
    return this.commerce.listInvoices(u.id, q);
  }
  @Get('invoices/:id') invoice(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.commerce.getInvoice(u.id, id);
  }
  @Post('invoices') createInvoice(
    @CurrentUser() u: any,
    @Body() dto: InvoiceDto,
  ) {
    return this.commerce.createInvoice(u.id, dto);
  }
  @Put('invoices/:id') updateInvoice(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Body() dto: InvoiceDto,
  ) {
    return this.commerce.updateInvoice(u.id, id, dto);
  }
  @Post('invoices/:id/send') sendInvoice(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.commerce.sendInvoice(u.id, id);
  }
  @Post('invoices/:id/resend') resendInvoice(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.commerce.resendInvoice(u.id, id);
  }
  @Post('invoices/:id/cancel') cancelInvoice(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.commerce.cancelInvoice(u.id, id);
  }

  @Get('payment-links') links(@CurrentUser() u: any, @Query() q: any) {
    return this.commerce.listLinks(u.id, q);
  }
  @Get('payment-links/:id') link(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.commerce.getLink(u.id, id);
  }
  @Post('payment-links') createLink(
    @CurrentUser() u: any,
    @Body() dto: PaymentLinkDto,
  ) {
    return this.commerce.createLink(u.id, dto);
  }
  @Patch('payment-links/:id') toggleLink(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Body() dto: ToggleLinkDto,
  ) {
    return this.commerce.setLinkActive(u.id, id, dto.is_active);
  }

  @Get('escrows') escrows(@CurrentUser() u: any, @Query() q: any) {
    return this.escrow.list(u.id, q);
  }
  @Get('escrows/:id') escrowOne(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.escrow.get(u.id, id);
  }
  @Post('escrows') createEscrow(
    @CurrentUser() u: any,
    @Body() dto: BusinessEscrowDto,
  ) {
    return this.escrow.create(u.id, dto);
  }
  @Post('escrows/:id/send') sendEscrow(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.escrow.send(u.id, id);
  }
  @Post('escrows/:id/start') startEscrow(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.escrow.start(u.id, id);
  }
  @Post('escrows/:id/request-release') requestRelease(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.escrow.requestRelease(u.id, id);
  }
  @Post('escrows/:id/milestones/:index/request-release') requestMilestone(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Param('index', ParseIntPipe) index: number,
  ) {
    return this.escrow.requestMilestone(u.id, id, index);
  }
  @Post('escrows/:id/cancel') cancelEscrow(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
  ) {
    return this.escrow.cancel(u.id, id);
  }
}

/** Payer-facing endpoints: any signed-in Farm user paying a business. */
@ApiTags('Business payments')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'pay', version: '1' })
export class BusinessPayController {
  constructor(
    private readonly commerce: BusinessCommerceService,
    private readonly escrow: BusinessEscrowService,
  ) {}

  @Get('links/:code') link(@Param('code') code: string) {
    return this.commerce.publicLink(code);
  }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('links/:code')
  payLink(
    @CurrentUser() u: any,
    @Param('code') code: string,
    @Body() dto: PinDto,
    @Ip() ip: string,
  ) {
    return this.commerce.payLink(u.id, code, dto.pin, ip);
  }

  @Get('invoices/:number') invoice(
    @CurrentUser() u: any,
    @Param('number') n: string,
  ) {
    return this.commerce.publicInvoice(u.id, n);
  }
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('invoices/:number')
  payInvoice(
    @CurrentUser() u: any,
    @Param('number') n: string,
    @Body() dto: PinDto,
    @Ip() ip: string,
  ) {
    return this.commerce.payInvoice(u.id, n, dto.pin, ip);
  }

  @Get('escrows') incoming(@CurrentUser() u: any) {
    return this.escrow.incoming(u.id);
  }
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('escrows/:id/fund')
  fund(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Body() dto: PinDto,
  ) {
    return this.escrow.fund(u.id, id, dto.pin);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('escrows/:id/milestones/:index/release')
  releaseMilestone(
    @CurrentUser() u: any,
    @Param('id', UUID) id: string,
    @Param('index', ParseIntPipe) index: number,
    @Body() dto: PinDto,
  ) {
    return this.escrow.releaseMilestone(u.id, id, index, dto.pin);
  }
}
