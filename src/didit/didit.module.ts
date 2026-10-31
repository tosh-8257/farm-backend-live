import { Module } from '@nestjs/common';
import { DiditSessionController } from './didit-session.controller';
import { DiditWebhookController } from './didit-webhook.controller';
import { DiditService } from './didit.service';

@Module({
  controllers: [DiditSessionController, DiditWebhookController],
  providers: [DiditService],
  exports: [DiditService],
})
export class DiditModule {}
