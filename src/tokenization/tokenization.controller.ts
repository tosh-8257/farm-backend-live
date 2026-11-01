import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  Min,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TokenizationService } from './tokenization.service';
import { TokenBuybackService } from './token-buyback.service';

export class TokenRequestDto {
  @IsString() @Length(1, 32) asset_name!: string;
  @IsString() @Matches(/^[A-Za-z0-9]{1,8}$/) unit_name!: string;
  /** 'on_invest' = mint at listing, deliver as people invest. */
  @IsOptional() @IsIn(['on_invest', 'post_funding']) mode?: string;
  /** Business accepts the 15% buyback hold-back (required). */
  @IsBoolean() accept_buyback_commitment!: boolean;
}
export class SellBackDto {
  @IsInt() @Min(1) units!: number;
}
export class TokenNotesDto {
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

@ApiTags('Tokenization')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ version: '1' })
export class TokenizationController {
  constructor(private readonly svc: TokenizationService) {}

  @Get('tokenization/status') status() {
    return this.svc.status();
  }
  @Get('investments/tokens') mine(@CurrentUser() u: any) {
    return this.svc.myTokens(u.id);
  }
  @Get('business/projects/:id/tokenization')
  get(@CurrentUser() u: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.businessGet(u.id, id);
  }
  @Post('business/projects/:id/tokenization')
  request(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TokenRequestDto,
  ) {
    return this.svc.request(u.id, id, dto);
  }
}

@ApiTags('Admin - Tokenization')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/tokenization', version: '1' })
export class AdminTokenizationController {
  constructor(private readonly svc: TokenizationService) {}

  @Get() list(@Query('status') status?: string) {
    return this.svc.adminList(status);
  }
  @Post(':id/approve') approve(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.approveAndMint(u.id, id);
  }
  @Post(':id/reject')
  reject(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TokenNotesDto,
  ) {
    return this.svc.reject(u.id, id, dto.notes ?? '');
  }
}

@ApiTags('Token buyback')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'investments/tokens', version: '1' })
export class TokenBuybackController {
  constructor(private readonly svc: TokenBuybackService) {}

  @Get('sell-backs') mine(@CurrentUser() u: any) {
    return this.svc.mine(u.id);
  }
  @Get('sell-back/allowance/:projectId') allowance(
    @CurrentUser() u: any,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.allowance(u.id, projectId).then((data) => ({ data }));
  }
  @Post(':allocationId/sell-back') sell(
    @CurrentUser() u: any,
    @Param('allocationId', ParseUUIDPipe) id: string,
    @Body() dto: SellBackDto,
  ) {
    return this.svc.request(u.id, id, dto.units);
  }
}

@ApiTags('Admin - Token buyback')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
@Controller({ path: 'admin/token-buybacks', version: '1' })
export class AdminTokenBuybackController {
  constructor(private readonly svc: TokenBuybackService) {}

  @Get() list(@Query('status') status?: string) {
    return this.svc.adminList(status);
  }
  @Get('pools') pools() {
    return this.svc.adminPools();
  }
  @Post(':id/approve') approve(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.approve(u.id, id);
  }
  @Post(':id/reject') reject(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TokenNotesDto,
  ) {
    return this.svc.reject(u.id, id, dto.notes ?? '');
  }
}
