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
  IsIn,
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

export class TokenRequestDto {
  @IsString() @Length(1, 32) asset_name!: string;
  @IsString() @Matches(/^[A-Za-z0-9]{1,8}$/) unit_name!: string;
  /** 'on_invest' = mint at listing, deliver as people invest. */
  @IsOptional() @IsIn(['on_invest', 'post_funding']) mode?: string;
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
