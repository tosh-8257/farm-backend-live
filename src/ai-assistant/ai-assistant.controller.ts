import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Express, Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AiAssistantService } from './ai-assistant.service';
import { STT_MODEL, VOICE_MAX_BYTES, VoiceService } from './voice.service';
import { MkulimaBillingService } from './mkulima-billing.service';

class ChatDto {
  @IsNotEmpty() @IsString() @MaxLength(2000) message!: string;
  @IsOptional() @IsUUID() conversation_id?: string;
  /** BCP-47 code from voice transcription, so Mkulima replies in the same language. */
  @IsOptional() @IsString() @MaxLength(12) language?: string;
}
class VoiceDto {
  @IsOptional() @IsString() @MaxLength(8) language?: string;
}
class PermissionsDto {
  @IsBoolean() enabled!: boolean;
  @IsNumber() @Min(0) per_tx_cap!: number;
  @IsNumber() @Min(0) daily_cap!: number;
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  allowed_actions!: string[];
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  spend_categories?: string[];
}
class ConfirmDto {
  @IsNotEmpty() @IsString() @Length(4, 6) pin!: string;
}

@ApiTags('AI Assistant')
@ApiBearerAuth('JWT')
@UseGuards(JwtGuard)
@Controller({ path: 'ai', version: '1' })
export class AiAssistantController {
  constructor(
    private readonly svc: AiAssistantService,
    private readonly voice: VoiceService,
    private readonly billing: MkulimaBillingService,
  ) {}

  @Get('status') status() {
    return this.svc.status();
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('chat')
  @ApiOperation({ summary: 'Send a message to Mkulima' })
  chat(@CurrentUser() u: any, @Body() dto: ChatDto) {
    return this.svc.chat(u.id, dto.message, dto.conversation_id, dto.language);
  }

  @Throttle({ default: { limit: 6, ttl: 60000 } })
  @Post('voice')
  @ApiOperation({
    summary:
      'Transcribe a voice message (xAI STT). Returns the transcript for the user to confirm; nothing is sent to Mkulima and the audio is not stored.',
  })
  @UseInterceptors(
    FileInterceptor('audio', {
      storage: memoryStorage(),
      limits: { fileSize: VOICE_MAX_BYTES, files: 1 },
    }),
  )
  async transcribe(
    @CurrentUser() u: any,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: VoiceDto,
  ) {
    await this.billing.assertCanUse(u.id, STT_MODEL, 'voice');
    const out = await this.voice.transcribe(file, dto?.language);
    await this.billing.charge({
      userId: u.id,
      kind: 'voice',
      model: STT_MODEL,
      audioSeconds: Number(out.duration ?? 0),
    });
    return out;
  }

  @Get('conversations') async list(@CurrentUser() u: any) {
    return { data: await this.svc.listConversations(u.id) };
  }
  @Get('conversations/:id') get(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getConversation(u.id, id);
  }
  @Delete('conversations/:id') del(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.deleteConversation(u.id, id);
  }

  @Get('permissions') perms(@CurrentUser() u: any) {
    return this.svc.getPermissions(u.id);
  }
  @Put('permissions') setPerms(
    @CurrentUser() u: any,
    @Body() dto: PermissionsDto,
  ) {
    return this.svc.updatePermissions(u.id, dto);
  }
  @Post('permissions/revoke') revoke(@CurrentUser() u: any) {
    return this.svc.revokePermissions(u.id);
  }

  @Get('actions') async actions(
    @CurrentUser() u: any,
    @Query('status') status?: string,
  ) {
    return { data: await this.svc.listActions(u.id, status) };
  }
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('actions/:id/confirm')
  confirm(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmDto,
    @Req() req: Request,
  ) {
    return this.svc.confirmAction(u.id, id, dto.pin, req.ip || '');
  }
  @Post('actions/:id/reject') reject(
    @CurrentUser() u: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.rejectAction(u.id, id);
  }

  @Get('activity') async activity(@CurrentUser() u: any) {
    return { data: await this.svc.activity(u.id) };
  }
  @Get('audit') async audit(@CurrentUser() u: any) {
    return { data: await this.svc.auditLog(u.id) };
  }
}
