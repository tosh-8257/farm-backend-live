import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../common/enums';
import { BusinessService } from './business.service';
import { ReviewBusinessDto, SaveBusinessDraftDto } from './business.dto';

@ApiTags('Business')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Controller({ path: 'business', version: '1' })
export class BusinessController {
  constructor(private readonly svc: BusinessService) {}

  @Get('me')
  @ApiOperation({
    summary: 'My business application/account and upgrade eligibility',
  })
  me(@CurrentUser() u: any) {
    return this.svc.getMine(u.id);
  }

  @Get('status')
  @ApiOperation({ summary: 'Current KYB status of my business' })
  status(@CurrentUser() u: any) {
    return this.svc.getStatus(u.id);
  }

  @Post('upgrade')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Start Merchant -> Business upgrade (creates a Draft)',
  })
  upgrade(@CurrentUser() u: any) {
    return this.svc.upgradeFromMerchant(u.id);
  }

  @Put('draft')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Save business onboarding draft' })
  saveDraft(@CurrentUser() u: any, @Body() dto: SaveBusinessDraftDto) {
    return this.svc.saveDraft(u.id, dto);
  }

  @Post('submit')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Manual KYB submit. Disabled unless MANUAL_KYB_ENABLED=true. Use Didit KYB.',
  })
  submit(@CurrentUser() u: any) {
    return this.svc.submit(u.id);
  }
}

@ApiTags('Admin - Business')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/businesses', version: '1' })
export class AdminBusinessController {
  constructor(private readonly svc: BusinessService) {}

  @Get()
  list(@Query() q: { status?: string; page?: string; limit?: string }) {
    return this.svc.adminList(q);
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.svc.adminGet(id);
  }

  @Post(':id/review')
  @ApiOperation({
    summary: 'Manual KYB decision. Disabled unless MANUAL_KYB_ENABLED=true.',
  })
  review(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewBusinessDto,
  ) {
    return this.svc.adminReview(u.id, id, dto);
  }
}
