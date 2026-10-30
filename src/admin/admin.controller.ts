import { Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsBoolean, IsNumber, IsNotEmpty, MaxLength, IsInt, IsDateString, Min, IsEmail } from 'class-validator';
import { Type } from 'class-transformer';
import { ForbiddenException, GoneException } from '@nestjs/common';
import { CreateWithdrawDto } from '../withdraw/dto/create-withdraw.dto';
import { AdminService } from './admin.service';
import { WithdrawService } from '../withdraw/withdraw.service';
import { NotFoundException } from '@nestjs/common';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { UserRole } from '../common/enums';

class UserStatusDto { @IsOptional() @IsBoolean() is_active?: boolean; @IsOptional() @IsBoolean() is_suspended?: boolean; }
class ResolveDto { @IsIn(['buyer','seller']) winner!: 'buyer'|'seller'; @IsString() note!: string; }
class KycReviewDto { @IsIn(['verified','rejected','under_review','additional_info_required']) status!: string; @IsOptional() @IsString() rejection_reason?: string; }
class MerchantDecisionDto { @IsIn(['approved','rejected']) status!: 'approved'|'rejected'; @IsOptional() @IsString() rejection_reason?: string; }
class SettingDto { @IsString() value!: string; }

class ExchangeRateDto {
  @IsString() base_currency!: string;
  @IsString() target_currency!: string;
  @IsNumber() rate!: number;
}

class ExchangeRatesDto {
  @IsNotEmpty() rates!: ExchangeRateDto[];
}

class CurrencyRateDto {
  @IsNumber() usd_kes_rate!: number;
}

class NowpaymentsPayoutVerificationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  verification_code!: string;
}

class RejectWithdrawalDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class ProcessWithdrawalDto {
  @IsOptional()
  @IsIn(['completed', 'failed'])
  status?: 'completed' | 'failed';

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class CreateSuperadminDto {
  @IsString() first_name!: string;
  @IsString() last_name!: string;
  @IsString() username!: string;
  @IsString() phone!: string;
  @IsString() email!: string;
  @IsString() password!: string;
  @IsString() country!: string;
}

class UpdateUserDto {
  @IsOptional() @IsString() first_name?: string;
  @IsOptional() @IsString() last_name?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsIn(['user', 'merchant', 'admin', 'super_admin']) role?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsBoolean() is_suspended?: boolean;
}

class UpdateFeeDto { @IsNotEmpty() @IsString() @MaxLength(100) value!: string; }

class UpdateSuperadminDto {
  @IsOptional() @IsString() @MaxLength(100) first_name?: string;
  @IsOptional() @IsString() @MaxLength(100) last_name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(32) phone?: string;
  @IsOptional() @IsString() @MaxLength(100) country?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
}

class CreateProjectDto {
  @IsNotEmpty() @IsString() @MaxLength(255) project_name!: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsString() @MaxLength(2048) banner_image?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) target_amount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minimum_investment?: number;
  @IsOptional() @Type(() => Number) @IsNumber() roi_percent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) duration_months?: number;
  @IsOptional() @IsString() @MaxLength(50) status?: string;
  @IsOptional() @IsDateString() starts_at?: string;
  @IsOptional() @IsDateString() ends_at?: string;
}

class UpdateProjectDto {
  @IsOptional() @IsString() @MaxLength(255) project_name?: string;
  @IsOptional() @IsString() @MaxLength(100) category?: string;
  @IsOptional() @IsString() @MaxLength(10000) description?: string;
  @IsOptional() @IsString() @MaxLength(2048) banner_image?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) target_amount?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) minimum_investment?: number;
  @IsOptional() @Type(() => Number) @IsNumber() roi_percent?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) duration_months?: number;
  @IsOptional() @IsString() @MaxLength(50) status?: string;
  @IsOptional() @IsDateString() starts_at?: string;
  @IsOptional() @IsDateString() ends_at?: string;
}

class SendNotificationDto {
  @IsString() user_id!: string;
  @IsString() title!: string;
  @IsString() body!: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() metadata?: any;
  @IsOptional() @IsBoolean() push?: boolean;
  @IsOptional() @IsBoolean() email?: boolean;
  @IsOptional() @IsBoolean() sms?: boolean;
}

class BroadcastNotificationDto {
  @IsString() title!: string;
  @IsString() body!: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() metadata?: any;
  @IsOptional() @IsBoolean() push?: boolean;
  @IsOptional() @IsBoolean() email?: boolean;
  @IsOptional() @IsBoolean() sms?: boolean;
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() target_role?: string;
  @IsOptional() recipientIds?: string[];
  @IsOptional() recipientEmails?: string[];
  @IsOptional() recipientPhones?: string[];
}

@ApiTags('Admin')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  constructor(private readonly svc: AdminService, private readonly withdrawService: WithdrawService) {}

  @Permissions('admin:read')
  @Get('dashboard')               stats() { return this.svc.getDashboardStats(); }
  @Permissions('admin:read')
  @Get('transactions')            transactions(@Query() q: any) { return this.svc.listTransactions({ ...q, transaction_type: q.transaction_type ?? q.type }); }
  @Permissions('admin:read')
  @Get('transactions/:id')        transaction(@Param('id') id: string) { return this.svc.getTransactionDetails(id); }
  @Permissions('admin:read')
  @Get('users')                   users(@Query() q: any) { return this.svc.listUsers(q); }
  @Permissions('admin:read')
  @Roles(UserRole.SUPER_ADMIN)
  @Get('admins')
  admins(@Query() q: any) { return this.svc.listAdmins(q); }
  @Permissions('admin:write')
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('admins/:id/suspend')
  suspendAdmin(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.setAdminStatus(id, 'suspend', u.id);
  }
  @Permissions('admin:write')
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('admins/:id/approve')
  approveAdmin(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.setAdminStatus(id, 'approve', u.id);
  }
  @Permissions('admin:write')
  @Roles(UserRole.SUPER_ADMIN)
  @Delete('admins/:id')
  deleteAdmin(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.deleteAdmin(id, u.id);
  }
  @Permissions('admin:read')
  @Get('users/:id')               user(@Param('id') id: string) { return this.svc.getUserDetail(id); }
  @Permissions('admin:write')
  @Patch('users/:id/status')      userStatus(@Param('id') id: string, @Body() dto: UserStatusDto, @CurrentUser() u: any) { return this.svc.updateUserStatus(id, dto, u.id); }
  @Permissions('admin:write')
  @Patch('users/:id')             updateUser(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() u: any) {
    // Only a SUPER_ADMIN may change roles (prevents admin -> super_admin escalation).
    if (dto.role !== undefined && String(u?.role ?? '').toLowerCase() !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Only a super admin can change user roles');
    }
    return this.svc.updateUser(id, dto, u.id);
  }
  @Permissions('admin:write')
  @Delete('users/:id')            deleteUser(@Param('id') id: string, @CurrentUser() u: any) { return this.svc.deleteUser(id, u.id); }
  @Permissions('admin:read')
  @Get('escrow')                  escrows(@Query() q: any) { return this.svc.listAllEscrows(q); }
  @Permissions('admin:read')
  @Get('escrow/:id')              escrowDetail(@Param('id') id: string) { return this.svc.getEscrow(id); }
  @Permissions('admin:write')
  @Post('escrow/:id/resolve')     resolve(@Param('id') id: string, @CurrentUser() u: any, @Body() dto: ResolveDto) { return this.svc.resolveDispute(id, u.id, dto); }
  @Permissions('admin:read')
  @Get('merchants')               merchants(@Query() q: any) { return this.svc.listMerchants(q); }
  @Permissions('admin:read')
  @Get('merchants/:id')           merchant(@Param('id') id: string) { return this.svc.getMerchant(id); }
  @Permissions('admin:write')
  @Post('merchants/:id/decision') decision(@Param('id') id: string, @CurrentUser() u: any, @Body() dto: MerchantDecisionDto) { return this.svc.approveMerchant(id, u.id, dto); }
  @Permissions('admin:read')
  @Get('payouts')                 payouts(@Query() q: any) { return this.svc.listPayouts(q); }
  @Permissions('admin:read')
  @Get('crypto-withdrawals/pending')
  async pendingNowpaymentsCryptoWithdrawals() {
    return {
      data: await this.withdrawService.getPendingNowpaymentsCryptoWithdrawals(),
    };
  }
  @Permissions('admin:write')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('crypto-withdrawals/:reference/approve')
  approveNowpaymentsCryptoWithdrawal(
    @Param('reference') reference: string,
    @CurrentUser() user: any,
  ) {
    return this.withdrawService.approveNowpaymentsCryptoWithdrawal(
      reference,
      user.id,
    );
  }
  @Permissions('admin:write')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @Post('crypto-withdrawals/:reference/verify')
  verifyNowpaymentsCryptoWithdrawal(
    @Param('reference') reference: string,
    @Body() dto: NowpaymentsPayoutVerificationDto,
    @CurrentUser() user: any,
  ) {
    return this.withdrawService.verifyNowpaymentsCryptoWithdrawal(
      reference,
      dto.verification_code,
      user.id,
    );
  }
  @Permissions('admin:read')
  @Get('fees')                    fees() { return this.svc.getFees(); }
  @Permissions('admin:write')
  @Put('fees/:id')                updateFee(@Param('id') id: string, @Body() dto: UpdateFeeDto, @CurrentUser() u: any) { return this.svc.updateFee(id, dto.value, u.id); }
  @Permissions('admin:write')
  @Post('payouts/:id/process')    processPayout(@Param('id') id: string, @CurrentUser() u: any) { return this.svc.processPayout(id, u.id, 'completed'); }
  @Permissions('admin:write')
  @Post('notifications/send')     sendNotification(@CurrentUser() u: any, @Body() dto: SendNotificationDto) { return this.svc.sendNotification(u.id, dto); }
  @Permissions('admin:write')
  @Post('notifications/broadcast') broadcastNotification(@CurrentUser() u: any, @Body() dto: BroadcastNotificationDto) { return this.svc.broadcastNotification(u.id, dto); }
  @Permissions('admin:read')
  @Get('kyc/queue')               kycQueue(@Query() q: any) { return this.svc.listKycQueue(q); }
  @Permissions('admin:read')
  @Get('kyc/:id')                 kycDetail(@Param('id') id: string) { return this.svc.getKycDocument(id); }
  @Permissions('admin:write')
  @Post('kyc/:id/review')         reviewKyc(@Param('id') _id: string, @CurrentUser() _u: any, @Body() _dto: KycReviewDto) {
    // Manual KYC review is retired; decisions come from Didit. History stays readable.
    throw new GoneException('Manual KYC review has been retired. KYC decisions now come from Didit.');
  }
  @Permissions('admin:read')
  @Get('analytics')               analytics() { return this.svc.getAdminAnalytics(); }
  @Permissions('admin:read')
  @Get('settings')                settings() { return this.svc.getSettings(); }
  @Permissions('admin:write')
  @Put('settings/:key')           updateSetting(@Param('key') key: string, @Body() dto: SettingDto, @CurrentUser() u: any) { return this.svc.updateSetting(key, dto.value, u.id); }
  @Permissions('admin:read')
  @Get('exchange-rates')          getExchangeRates() { return this.svc.getExchangeRates(); }
  @Permissions('admin:write')
  @Put('exchange-rates')          updateExchangeRates(@Body() dto: ExchangeRatesDto, @CurrentUser() u: any) { return this.svc.updateExchangeRates(dto.rates, u.id); }
  @Permissions('admin:read')
  @Get('currency-rates')          getCurrencyRates() { return this.svc.getCurrencyRates(); }
  @Permissions('admin:write')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Put('currency-rates')          updateCurrencyRate(@Body() dto: CurrencyRateDto, @CurrentUser() u: any) { return this.svc.updateCurrencyRate(dto.usd_kes_rate, u.id); }
  @Permissions('admin:read')
  @Get('audit-logs')              auditLogs(@Query() q: any) { return this.svc.getAuditLogs(q); }
  @Permissions('admin:write')
  @Post('investments')            createProject(@CurrentUser() u: any, @Body() dto: CreateProjectDto) { return this.svc.createProject(u.id, dto); }
  @Permissions('admin:write')
  @Put('investments/:id')         updateProject(@Param('id') id: string, @Body() dto: UpdateProjectDto) { return this.svc.updateProject(id, dto); }

  // ── Audit Dashboard ──────────────────────────────────────────────────────────
  @Permissions('admin:read')
  @Get('audit/dashboard')         auditDashboard() { return this.svc.getAuditDashboard(); }
  @Permissions('admin:read')
  @Get('audit/security-events')   securityEvents(@Query() q: any) { return this.svc.getSecurityEvents(q); }
  @Permissions('admin:read')
  @Get('audit/security-stats')    securityStats() { return this.svc.getSecurityStats(); }
  @Permissions('admin:read')
  @Get('audit/users/:id/activity') userActivity(@Param('id') id: string, @Query() q: any) { return this.svc.getUserActivityLog(id, q); }
  @Permissions('admin:read')
  @Get('audit/users/:id/sessions') userSessions(@Param('id') id: string, @Query() q: any) { return this.svc.getUserSessions(id, q); }
  @Permissions('admin:read')
  @Get('audit/admin-logs')        adminLogs(@Query() q: any) { return this.svc.getAdminAuditLog(q); }
  @Permissions('admin:read')
  @Get('audit/compliance')        complianceReport(@Query() q: any) { return this.svc.getComplianceReport(q); }

  @Permissions('admin:read')
  @Get('withdrawals')             allWithdrawals(@Query() q: any) { return this.svc.listAllWithdrawals(q); }

  @Permissions('admin:write')
  @Post('withdrawals/:id/approve')
  approveWithdrawal(@Param('id') id: string) {
    return this.withdrawService.adminApproveWithdrawal(id);
  }

  @Permissions('admin:write')
  @Post('withdrawals/:id/reject')
  rejectWithdrawal(
    @Param('id') id: string,
    @Body() dto: RejectWithdrawalDto,
  ) {
    return this.withdrawService.adminRejectWithdrawal(
      id,
      dto.reason ?? 'Rejected by support',
    );
  }

  @Permissions('admin:write')
  @Post('withdrawals/:id/process')
  processWithdrawal(
    @Param('id') id: string,
    @Body() dto: ProcessWithdrawalDto,
  ) {
    return dto.status === 'failed'
      ? this.withdrawService.adminRejectWithdrawal(
          id,
          dto.reason ?? 'Rejected by support',
        )
      : this.withdrawService.adminApproveWithdrawal(id);
  }

  // ── Superadmin Wallet ────────────────────────────────────────────────────────
  @Permissions('admin:read')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Get('wallet')
  async getSuperadminWallet(@CurrentUser() u: any) {
    return this.svc.getSuperadminWallet(u.id);
  }

  @Permissions('admin:write')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post('wallet/withdraw')
  async withdrawSuperadminFunds(@CurrentUser() u: any, @Body() dto: CreateWithdrawDto) {
    return this.svc.superadminWithdraw(u.id, dto);
  }

  // ── Superadmin Management ────────────────────────────────────────────────────
  @Permissions('admin:write')
  @Roles(UserRole.SUPER_ADMIN)
  @Post('superadmin/create')
  createSuperadmin(@Body() dto: CreateSuperadminDto, @CurrentUser() u: any) {
    return this.svc.createSuperadmin(dto, u.id);
  }

  @Permissions('admin:read')
  @Roles(UserRole.SUPER_ADMIN)
  @Get('superadmin/list')
  listSuperadmins(@Query() q: any) {
    return this.svc.listSuperadmins(q);
  }

  @Permissions('admin:read')
  @Roles(UserRole.SUPER_ADMIN)
  @Get('superadmin/:id')
  getSuperadmin(@Param('id') id: string) {
    return this.svc.getSuperadmin(id);
  }

  @Permissions('admin:write')
  @Roles(UserRole.SUPER_ADMIN)
  @Patch('superadmin/:id')
  updateSuperadmin(@Param('id') id: string, @Body() dto: UpdateSuperadminDto, @CurrentUser() u: any) {
    return this.svc.updateSuperadmin(id, dto, u.id);
  }

  @Permissions('admin:write')
  @Roles(UserRole.SUPER_ADMIN)
  @Post('superadmin/:id/deactivate')
  deactivateSuperadmin(@Param('id') id: string, @CurrentUser() u: any) {
    return this.svc.deactivateSuperadmin(id, u.id);
  }
}

// ── Superadmin Controller ────────────────────────────────────────────────────
@ApiTags('Superadmin')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
@Controller({ path: 'superadmin', version: '1' })
export class SuperadminController {
  constructor(private readonly svc: AdminService) {}

  @Permissions('admin:read')
  @Get('dashboard')
  superadminDashboard() {
    return this.svc.getSuperadminDashboard();
  }

  @Permissions('admin:read')
  @Get('currency-rates/current')
  getCurrentCurrencyRate() {
    return this.svc.getCurrentCurrencyRate();
  }
}