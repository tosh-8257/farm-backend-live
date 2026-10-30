import { GoneException } from '@nestjs/common';
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsOptional, IsIn } from 'class-validator';
import { KycService } from './kyc.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Permissions } from '../common/decorators/permissions.decorator';
import { UserRole } from '../common/enums';

class SubmitKycDto {
  @IsOptional() @IsString() document_type?: string;
  @IsOptional() @IsString() document_type_code?: string;
  @IsOptional() @IsString() document_number?: string;
  // Accept either base64 image payloads (front_image) OR already-uploaded URLs (front_image_url)
  @IsOptional() @IsString() front_image?: string;
  @IsOptional() @IsString() front_image_url?: string;
  @IsOptional() @IsString() back_image?: string;
  @IsOptional() @IsString() back_image_url?: string;
  @IsOptional() @IsString() selfie_image?: string;
  @IsOptional() @IsString() selfie_image_url?: string;
  @IsOptional() @IsString() address_document?: string;
  @IsOptional() @IsString() address_document_url?: string;
  @IsOptional() @IsString() first_name?: string;
  @IsOptional() @IsString() last_name?: string;
  @IsOptional() @IsString() dob?: string;
  @IsOptional() @IsString() date_of_birth?: string;
  @IsOptional() @IsString() gender?: string;
  @IsOptional() @IsString() nationality?: string;
  @IsOptional() @IsString() phone?: string;
  @IsOptional() @IsString() phone_number?: string;
  @IsOptional() @IsString() email?: string;
  @IsOptional() @IsString() country?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() postal_code?: string;
}
class ReviewDto {
  @IsIn(['under_review', 'verified', 'rejected', 'additional_info_required'])
  status!:
    | 'under_review'
    | 'verified'
    | 'rejected'
    | 'additional_info_required';
  @IsOptional() @IsString() rejection_reason?: string;
}

@ApiTags('KYC')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'kyc', version: '1' })
export class KycController {
  constructor(private readonly svc: KycService) {}

  @Post('submit')
  @Permissions('kyc:write')
  submit(@CurrentUser() _u: any, @Body() _dto: SubmitKycDto) {
    // Manual KYC uploads are retired: verification is done through Didit
    // (POST /api/verify/create-session). Historical submissions are kept.
    throw new GoneException(
      'Manual KYC submission is no longer available. Please update the FARM app from the Play Store to verify your identity with Didit.',
    );
  }
  @Get('my') getMyKyc(@CurrentUser() u: any) {
    return this.svc.getMyKyc(u.id);
  }

  @Permissions('kyc:read')
  @Get('queue')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  queue(@Query() q: any) {
    return this.svc.getQueue(q);
  }

  @Permissions('kyc:write')
  @Post(':id/review')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  review(
    @Param('id') _id: string,
    @CurrentUser() _u: any,
    @Body() _dto: ReviewDto,
  ) {
    // Manual approval/rejection is retired; KYC status now comes from Didit
    // decisions. The queue remains readable for historical submissions.
    throw new GoneException(
      'Manual KYC review has been retired. KYC decisions now come from Didit.',
    );
  }
}
