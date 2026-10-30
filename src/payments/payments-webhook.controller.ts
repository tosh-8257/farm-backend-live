import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { WebhookService } from '../webhook/webhook.service';
import { WebhookSignatureGuard } from '../common/guards/webhook-signature.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums';

@Controller({ path: 'payments/webhooks', version: '1' })
export class PaymentsWebhookController {
  private readonly logger = new Logger(PaymentsWebhookController.name);

  constructor(private readonly webhookService: WebhookService) {
    // Log the exact registered route during application startup
    this.logger.log('Registered route: /api/v1/payments/webhooks/ivorypay (GET, POST)');
  }

  @Get('ivorypay')
  health() {
    this.logger.log('Ivorypay webhook health check reached');
    return { success: true, message: 'Ivorypay webhook endpoint is alive' };
  }

  @UseGuards(WebhookSignatureGuard)
  @Post('ivorypay')
  async ivorypay(@Body() body: any) {
    this.logger.log('Ivorypay webhook reached');
    return this.webhookService.handleIvorypayWebhook(body, true);
  }

  // Admin-only endpoint to trigger the stuck-deposit repair job manually.
  @UseGuards(JwtGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  @Post('ivorypay/trigger-fix')
  async triggerFix() {
    this.logger.log('Manual trigger invoked: fixStuckDeposits');
    try {
      await this.webhookService.fixStuckDeposits();
      return { ok: true, message: 'fixStuckDeposits triggered' };
    } catch (e: any) {
      this.logger.error('Manual trigger failed', e as any);
      return { ok: false, error: 'fixStuckDeposits failed' };
    }
  }
}
