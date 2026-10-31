import { AgentPaymentsModule } from '../agent-payments/agent-payments.module';
import { Module } from '@nestjs/common';
import { WalletsModule } from '../wallets/wallets.module';
import { TravelModule } from '../travel/travel.module';
import { AiAssistantController } from './ai-assistant.controller';
import { AiAssistantService } from './ai-assistant.service';
import { AiProvider } from './ai-provider';
import { AiToolsService } from './ai-tools.service';
import { VoiceService } from './voice.service';
import { CurrencyModule } from '../currency/currency.module';
import { MkulimaBillingService } from './mkulima-billing.service';
import { MkulimaBillingController } from './mkulima-billing.controller';

@Module({
  imports: [WalletsModule, TravelModule, AgentPaymentsModule, CurrencyModule],
  controllers: [AiAssistantController, MkulimaBillingController],
  providers: [
    AiAssistantService,
    AiProvider,
    AiToolsService,
    VoiceService,
    MkulimaBillingService,
  ],
  exports: [MkulimaBillingService],
})
export class AiAssistantModule {}
