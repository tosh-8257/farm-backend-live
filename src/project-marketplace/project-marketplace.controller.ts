import { ProjectFundsService } from './project-funds.service';
import {
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { MarketplaceService } from './marketplace.service';
import { BusinessProjectsService } from './business-projects.service';
import { ProjectReviewService } from './project-review.service';
import {
  EligibilityDto,
  MarketplaceInvestDto,
  ProjectDocumentDto,
  ProjectInputDto,
  ProjectUpdateDto,
  ReviewActionDto,
  MilestoneNotesDto,
  MilestonePlanDto,
  MilestoneRequestDto,
  FundsSettingsDto,
  ReturnDepositDto,
  ProjectSpendDto,
  FundsPauseDto,
} from './project.dto';

@ApiTags('Marketplace - Projects')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'marketplace', version: '1' })
export class MarketplaceController {
  constructor(
    private readonly svc: MarketplaceService,
    private readonly funds: ProjectFundsService,
  ) {}

  @Get('projects/:id/funds-timeline') fundsTimeline(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.funds.investorTimeline(u.id, id);
  }

  @Get('sectors') sectors() {
    return this.svc.sectors();
  }
  @Get('risk-disclosure') disclosure() {
    return this.svc.disclosure();
  }
  @Get('projects')
  @ApiOperation({ summary: 'Browse listed projects (multi-sector)' })
  list(@Query() q: any) {
    return this.svc.list(q);
  }
  @Get('projects/legacy') legacy() {
    return this.svc.legacyList();
  }
  @Get('projects/:id') detail(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.detail(id, u.id);
  }
  @Get('eligibility') eligibility(@CurrentUser() u: any) {
    return this.svc.eligibility(u.id);
  }
  @Post('eligibility/request') requestEligibility(@CurrentUser() u: any) {
    return this.svc.requestEligibility(u.id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('projects/:id/invest')
  @ApiOperation({ summary: 'Invest (eligibility + risk disclosure + PIN)' })
  invest(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MarketplaceInvestDto,
    @Ip() ip: string,
  ) {
    return this.svc.invest(u.id, id, dto, ip);
  }

  @Get('portfolio') portfolio(@CurrentUser() u: any) {
    return this.svc.portfolio(u.id);
  }
  @Get('portfolio/history') history(@CurrentUser() u: any, @Query() q: any) {
    return this.svc.history(u.id, q);
  }
  @Get('portfolio/documents') documents(@CurrentUser() u: any) {
    return this.svc.investorDocuments(u.id);
  }
  @Get('portfolio/updates') updates(@CurrentUser() u: any) {
    return this.svc.investorUpdates(u.id);
  }
}

@ApiTags('Business - Projects')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'business/projects', version: '1' })
export class BusinessProjectsController {
  constructor(
    private readonly svc: BusinessProjectsService,
    private readonly funds: ProjectFundsService,
  ) {}

  @Patch(':id/funds-settings') fundsSettings(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FundsSettingsDto,
  ) {
    return this.funds.setSettings(u.id, id, dto);
  }
  @Post(':id/returns') depositReturns(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReturnDepositDto,
  ) {
    return this.funds.deposit(u.id, id, dto);
  }
  @Get(':id/funds-timeline') fundsTimeline(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.funds.ownerTimeline(u.id, id);
  }
  @Post(':id/spend')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Pay an invoice or payment link from project funds',
  })
  spendFunds(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProjectSpendDto,
  ) {
    return this.funds.spend(u.id, id, dto);
  }

  @Get() list(@CurrentUser() u: any) {
    return this.svc.list(u.id);
  }
  @Post() create(@CurrentUser() u: any, @Body() dto: ProjectInputDto) {
    return this.svc.create(u.id, dto);
  }
  @Get(':id') get(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.get(u.id, id);
  }
  @Patch(':id') update(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProjectInputDto,
  ) {
    return this.svc.update(u.id, id, dto);
  }
  @Post(':id/documents') addDoc(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProjectDocumentDto,
  ) {
    return this.svc.addDocument(u.id, id, dto);
  }
  @Delete(':id/documents/:docId') rmDoc(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    return this.svc.removeDocument(u.id, id, docId);
  }
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post(':id/submit')
  submit(@CurrentUser() u: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.submit(u.id, id);
  }
  @Patch(':id/milestones') milestones(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MilestonePlanDto,
  ) {
    return this.svc.setMilestones(u.id, id, dto.milestones);
  }
  @Post(':id/milestones/:mid/request')
  requestMs(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mid', ParseUUIDPipe) mid: string,
    @Body() dto: MilestoneRequestDto,
  ) {
    return this.svc.requestMilestone(u.id, id, mid, dto);
  }
  @Post(':id/updates') postUpdate(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ProjectUpdateDto,
  ) {
    return this.svc.postUpdate(u.id, id, dto);
  }
}

@ApiTags('Admin - Projects')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/projects', version: '1' })
export class AdminProjectsController {
  constructor(
    private readonly svc: ProjectReviewService,
    private readonly funds: ProjectFundsService,
  ) {}

  @Patch(':id/funds-pause') fundsPause(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FundsPauseDto,
  ) {
    return this.funds.setPaused(u.id, id, dto.paused, dto.reason);
  }
  @Get(':id/funds-audit') fundsAudit(@Param('id', ParseUUIDPipe) id: string) {
    return this.funds.adminAudit(id);
  }
  @Post('funds-moves/:moveId/retry') retryMove(
    @CurrentUser() u: any,
    @Param('moveId', ParseUUIDPipe) moveId: string,
  ) {
    return this.funds.retryMove(u.id, moveId);
  }

  @Get() list(@Query() q: any) {
    return this.svc.list(q);
  }
  @Get('investors') investors(@Query() q: any) {
    return this.svc.listInvestors(q);
  }
  @Patch('investors/:userId/eligibility')
  eligibility(
    @CurrentUser() u: any,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: EligibilityDto,
  ) {
    return this.svc.setEligibility(u.id, userId, dto);
  }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.get(id);
  }
  @Post(':id/review') review(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewActionDto,
  ) {
    return this.svc.transition(u.id, id, dto.action, dto.notes);
  }
  /** Project made a loss: refund this project's consolidation reserve pro-rata. */
  @Post(':id/consolidation-refund')
  consolidationRefund(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MilestoneNotesDto,
  ) {
    return this.svc.refundReserveForLoss(u.id, id, dto.notes);
  }
  /** Project completed successfully: release its remaining reserve to FARM revenue. */
  @Post(':id/consolidation-release')
  consolidationRelease(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MilestoneNotesDto,
  ) {
    return this.svc.releaseReserveToFarm(u.id, id, dto.notes);
  }
  @Post(':id/milestones/:mid/release')
  release(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mid', ParseUUIDPipe) mid: string,
    @Body() dto: MilestoneNotesDto,
  ) {
    return this.svc.releaseMilestone(u.id, id, mid, dto.notes);
  }
  @Post(':id/milestones/:mid/return')
  returnMilestone(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mid', ParseUUIDPipe) mid: string,
    @Body() dto: MilestoneNotesDto,
  ) {
    return this.svc.returnMilestone(u.id, id, mid, dto.notes ?? '');
  }
}
