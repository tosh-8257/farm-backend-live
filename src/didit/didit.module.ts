import { Module } from '@nestjs/common';
import { DiditSessionController } from './didit-session.controller';
import { DiditWebhookController } from './didit-webhook.controller';
import { DiditService } from './didit.service';
import { RecoveryOwnerMatchService } from './recovery-owner-match.service';

@Module({
  controllers: [DiditSessionController, DiditWebhookController],
  providers: [DiditService, RecoveryOwnerMatchService],
  exports: [DiditService, RecoveryOwnerMatchService],
})
export class DiditModule {}
