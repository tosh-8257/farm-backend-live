import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { type notification_type } from '@prisma/client';
import { paginationParams, paginate } from '../common/utils/pagination.util';
import * as nodemailer from 'nodemailer';
import axios from 'axios';
import Twilio from 'twilio';
import { FirebaseService } from './firebase.service';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private mailer: nodemailer.Transporter;
  private twilioClient: any;

  constructor(private prisma: PrismaService, private cfg: ConfigService, private firebase: FirebaseService) {
    this.mailer = nodemailer.createTransport({
      host: cfg.get('SMTP_HOST'),
      port: cfg.get<number>('SMTP_PORT', 587),
      auth: { user: cfg.get('SMTP_USER'), pass: cfg.get('SMTP_PASS') },
    });

    const sid = cfg.get<string>('TWILIO_ACCOUNT_SID');
    const token = cfg.get<string>('TWILIO_AUTH_TOKEN');
    if (sid && token) {
      try {
        this.twilioClient = Twilio(sid, token);
        this.logger.log('Twilio SMS client initialized');
      } catch (e) {
        this.logger.error('Failed to initialize Twilio client: ' + e);
      }
    }

    // Firebase Admin is initialized by FirebaseService; ensure messaging is available
    if (this.firebase) {
      this.logger.log('FirebaseService provided for FCM');
    }
  }

  async getDeviceTokens(userId: string) {
    const tokens = await (this.prisma as any).device_tokens.findMany({ where: { user_id: userId, is_active: true } });
    return tokens.map((t) => t.token);
  }

  async registerDeviceToken(userId: string, token: string, platform?: string) {
    const normalizedToken = token.trim();
    if (!normalizedToken) throw new Error('Device token is required');

    const existing = await (this.prisma as any).device_tokens.findFirst({
      where: { token: normalizedToken },
    });

    if (existing) {
      await (this.prisma as any).device_tokens.update({
        where: { id: existing.id },
        data: {
          user_id: userId,
          platform: platform || existing.platform,
          is_active: true,
          last_seen: new Date(),
        },
      });
    } else {
      await (this.prisma as any).device_tokens.create({
        data: {
          user_id: userId,
          token: normalizedToken,
          platform: platform || 'unknown',
          is_active: true,
          last_seen: new Date(),
        },
      });
    }
    return { success: true };
  }

  async removeDeviceToken(userId: string, token: string) {
    await (this.prisma as any).device_tokens.updateMany({
      where: { user_id: userId, token },
      data: { is_active: false },
    });
    return { success: true };
  }

  async getSettings(userId: string) {

  const settings =
    await this.prisma.user_settings.findUnique({
      where: {
        user_id: userId,
      },
    });

  return {
    success: true,
    data: settings,
  };
}

async updateSettings(userId: string, body: any) {

  const settings =
    await this.prisma.user_settings.upsert({

      where: {
        user_id: userId,
      },

      update: {
        push_notifications:
          body.push_notifications,

        email_notifications:
          body.email_notifications,

        sms_notifications:
          body.sms_notifications,

        sound_enabled:
          body.sound_enabled,

        vibration_enabled:
          body.vibration_enabled,
      },

      create: {

        user_id: userId,

        push_notifications:
          body.push_notifications,

        email_notifications:
          body.email_notifications,

        sms_notifications:
          body.sms_notifications,

        sound_enabled:
          body.sound_enabled,

        vibration_enabled:
          body.vibration_enabled,
      },
    });

  return {
    success: true,
    data: settings,
  };
}

  async createInApp(userId: string, dto: {
    type: notification_type | string; title: string; body: string; metadata?: any; entityId?: string;
  }) {
    return this.prisma.notifications.create({
      data: {
        user_id: userId,
        type: dto.type as notification_type,
        title: dto.title,
        body: dto.body,
        metadata: {
          ...(dto.metadata ?? {}),
          type: dto.type,
          entityId: dto.entityId,
          timestamp: new Date().toISOString(),
        },
      },
    });
  }

  async getNotifications(userId: string, query: any) {
    const { skip, take, page, limit } = paginationParams(query.page, query.limit);
    try {
      const [items, total] = await Promise.all([
        this.prisma.notifications.findMany({
          where: { user_id: userId },
          skip,
          take,
          orderBy: { created_at: 'desc' },
          select: {
            id: true,
            type: true,
            title: true,
            body: true,
            metadata: true,
            is_read: true,
            created_at: true,
          },
        }),
        this.prisma.notifications.count({ where: { user_id: userId } }),
      ]);
      return { data: items, meta: paginate(total, page, limit) };
    } catch (error) {
      this.logger.error(
        `Notification list failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException(
        'Could not load notifications. Pull to refresh.',
      );
    }
  }

  async markRead(userId: string, id: string) {
    await this.prisma.notifications.updateMany({
      where: { id, user_id: userId },
      data: { is_read: true },
    });
    return { message: 'Notification marked as read' };
  }

  async markAllRead(userId: string) {
    await this.prisma.notifications.updateMany({
      where: { user_id: userId, is_read: false },
      data: { is_read: true },
    });
    return { message: 'All notifications marked as read' };
  }

  async deleteNotification(userId: string, id: string) {
    const result = await this.prisma.notifications.deleteMany({
      where: { id, user_id: userId },
    });
    if (result.count === 0) throw new Error('Notification not found');
    return { message: 'Notification deleted' };
  }

  async deleteAllNotifications(userId: string) {
    const result = await this.prisma.notifications.deleteMany({
      where: { user_id: userId },
    });
    return { message: 'All notifications deleted', deletedCount: result.count };
  }

  async sendEmail(to: string, subject: string, html: string) {
    try {
      await this.mailer.sendMail({ from: this.cfg.get('SMTP_FROM'), to, subject, html });
      return true;
    } catch (e) {
      this.logger.error(`Email failed to ${to}: ${e}`);
      return false;
    }
  }

  isTransactionalEmailConfigured(): boolean {
    const apiKey = this.cfg.get<string>('RESEND_API_KEY');
    const from =
      this.cfg.get<string>('RESEND_FROM') || this.cfg.get<string>('SMTP_FROM');
    return Boolean(apiKey && from);
  }

  async sendEmailOrThrow(
    to: string,
    subject: string,
    html: string,
    text: string,
  ): Promise<void> {
    const apiKey = this.cfg.get<string>('RESEND_API_KEY');
    const from =
      this.cfg.get<string>('RESEND_FROM') || this.cfg.get<string>('SMTP_FROM');
    if (!apiKey || !from) {
      throw new Error('Transactional email API is not configured');
    }

    try {
      await axios.post(
        'https://api.resend.com/emails',
        { from, to, subject, html, text },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );
    } catch (error) {
      const providerError = axios.isAxiosError(error)
        ? error.response?.data
        : undefined;
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      const providerCode =
        providerError &&
        typeof providerError === 'object' &&
        typeof providerError.name === 'string' &&
        /^[a-z_]+$/.test(providerError.name)
          ? providerError.name
          : undefined;
      this.logger.error(
        `Transactional email API delivery failed${status ? ` (HTTP ${status})` : ''}${providerCode ? ` (${providerCode})` : ''}`,
      );
      throw new Error(
        status
          ? `Transactional email provider rejected the request (HTTP ${status})`
          : 'Transactional email provider request failed',
      );
    }
  }

  async sendReceiptEmailOrThrow(input: {
    to: string;
    bcc?: string;
    receiptNumber: string;
    amount: number;
    currency: string;
    creditedAmount?: number;
    pdfBase64: string;
    logoBase64: string;
    merchantName: string;
    merchantEmail?: string | null;
    merchantPhone?: string | null;
    merchantLocation?: string | null;
    transactionId: string;
    paymentMethod: string;
    paidAt: string;
    downloadUrl: string;
    viewUrl: string;
  }): Promise<void> {
    const apiKey = this.cfg.get<string>('RESEND_API_KEY');
    const from =
      this.cfg.get<string>('RESEND_FROM') || this.cfg.get<string>('SMTP_FROM');
    if (!apiKey || !from) {
      throw new Error('Transactional email API is not configured');
    }

    const escapeHtml = (value: string) =>
      value.replace(
        /[&<>"']/g,
        (character) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[character]!,
      );
    const amount = `${input.amount.toLocaleString('en-KE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 8,
    })} ${escapeHtml(input.currency)}`;
    const details = [
      ['Business', input.merchantName],
      ...(input.merchantEmail ? [['Email', input.merchantEmail]] : []),
      ...(input.merchantPhone ? [['Phone', input.merchantPhone]] : []),
      ...(input.merchantLocation ? [['Location', input.merchantLocation]] : []),
    ]
      .map(
        ([label, value]) =>
          `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`,
      )
      .join('');
    const receiptNumber = escapeHtml(input.receiptNumber);
    const transactionId = escapeHtml(input.transactionId);
    const paymentMethod = escapeHtml(input.paymentMethod);
    const paidAt = escapeHtml(input.paidAt);
    const downloadUrl = escapeHtml(input.downloadUrl);
    const viewUrl = escapeHtml(input.viewUrl);
    const logoCid = 'farm-brand-logo';
    const html = `<!doctype html><html lang="en"><body>
      <img src="cid:${logoCid}" alt="FARM">
      <h1>Payment successful</h1>
      <p>Amount paid: ${amount}</p>
      ${input.creditedAmount == null ? '' : `<p>Credited to merchant wallet: ${input.creditedAmount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 8 })} FARM</p>`}
      <p>Receipt number: ${receiptNumber}</p>
      <p>Transaction ID: ${transactionId}</p>
      <p>Payment method: ${paymentMethod}</p>
      <p>Date: ${paidAt}</p>
      <table>${details}</table>
      <p><a href="${downloadUrl}">Download Receipt (PDF)</a></p>
      <p><a href="${viewUrl}">View Receipt Online</a></p>
      <p>Need help? Contact support@farmapp.africa or visit https://farmapp.africa.</p>
    </body></html>`;
    const text = [
      'Payment successful',
      `Amount paid: ${input.amount} ${input.currency}`,
      ...(input.creditedAmount == null
        ? []
        : [`Credited to merchant wallet: ${input.creditedAmount} FARM`]),
      `Receipt number: ${input.receiptNumber}`,
      `Merchant: ${input.merchantName}`,
      `Transaction ID: ${input.transactionId}`,
      `Payment method: ${input.paymentMethod}`,
      `Date: ${input.paidAt}`,
      `Download Receipt (PDF): ${input.downloadUrl}`,
      `View Receipt Online: ${input.viewUrl}`,
      'FARM Support: support@farmapp.africa',
      'Website: https://farmapp.africa',
    ].join('\n');

    try {
      await axios.post(
        'https://api.resend.com/emails',
        {
          from,
          to: input.to,
          ...(input.bcc ? { bcc: input.bcc } : {}),
          subject: `FARM payment receipt ${input.receiptNumber}`,
          html,
          text,
          attachments: [
            { filename: `${input.receiptNumber}.pdf`, content: input.pdfBase64 },
            {
              filename: 'farm-logo.png',
              content: input.logoBase64,
              content_id: logoCid,
            },
          ],
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );
    } catch (error) {
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      this.logger.error(
        `Receipt email delivery failed${status ? ` (HTTP ${status})` : ''}`,
      );
      throw new Error(
        status
          ? `Receipt email provider rejected the request (HTTP ${status})`
          : 'Receipt email provider request failed',
      );
    }
  }

  async sendSms(phone: string, message: string) {
    // Avoid logging message contents (OTP) to stdout.
    if (this.twilioClient) {
      try {
        const from = this.cfg.get<string>('TWILIO_SENDER') || this.cfg.get<string>('TWILIO_FROM');
        await this.twilioClient.messages.create({ body: message, from, to: phone });
        this.logger.debug(`[SMS → ${phone}]: sent`);
        return true;
      } catch (e) {
        this.logger.error(`Twilio SMS failed to ${phone}: ${e}`);
        return false;
      }
    }

    // No provider configured: fall back to debug-only (without revealing message contents)
    this.logger.debug(`[SMS → ${phone}]: provider not configured, skip send`);
    return false;
  }

  async sendPush(userId: string, title: string, body: string, data?: Record<string, any>) {
    if (!this.firebase) {
      this.logger.debug('FirebaseService not available; skipping push send');
      return false;
    }
    const messaging = this.firebase.messaging;
    if (!messaging) {
      this.logger.debug('Firebase messaging not available; skipping push send');
      return false;
    }
    try {
      const tokens = await this.getDeviceTokens(userId);
      if (!tokens || tokens.length === 0) return false;
      const timestamp = new Date().toISOString();
      const payloadData: Record<string, string> = Object.fromEntries(
        Object.entries({ ...data, title, body, timestamp }).map(([key, value]) => [
          key,
          value == null ? '' : String(value),
        ]),
      );
      const payload: any = {
        notification: { title, body },
        data: payloadData,
        tokens,
        android: {
          priority: 'high',
          notification: { channelId: 'farm_notifications' },
        },
        apns: { headers: { 'apns-priority': '10' } },
      };
      const resp = await messaging.sendEachForMulticast(payload as any);
      const invalidTokens = resp.responses
        .map((result, index) => ({ result, token: tokens[index] }))
        .filter(({ result }) => {
          const code = result.error?.code;
          return code === 'messaging/registration-token-not-registered' ||
              code === 'messaging/invalid-registration-token';
        })
        .map(({ token }) => token);
      if (invalidTokens.length > 0) {
        await (this.prisma as any).device_tokens.updateMany({
          where: { token: { in: invalidTokens } },
          data: { is_active: false },
        });
      }
      this.logger.debug(`FCM sent: success=${resp.successCount} failure=${resp.failureCount}`);
      return resp.successCount > 0;
    } catch (e) {
      this.logger.error('FCM send failed: ' + e);
      return false;
    }
  }

  async notifyTransfer(senderId: string, receiverId: string, amount: number, reference: string) {
    const sender = await this.prisma.users.findUnique({
      where: { id: senderId },
      select: { first_name: true, last_name: true, username: true },
    });
    const senderName =
      (sender?.username && `@${sender.username}`) ||
      [sender?.first_name, sender?.last_name].filter(Boolean).join(' ') ||
      'Someone';

    await Promise.all([
      this.sendNotification(senderId, {
        type: 'transfer_sent', entityId: reference, title: 'Transfer Successful',
        body: `You sent ${amount} FARM.`,
      }),
      this.sendNotification(receiverId, {
        type: 'transfer_received', entityId: reference, title: '💰 Money Received',
        body: `${senderName} sent you ${amount} FARM.`,
      }),
    ]);
  }

  async sendNotification(userId: string, dto: {
    type: notification_type | string;
    title: string;
    body: string;
    entityId?: string;
    metadata?: Record<string, any>;
  }) {
    const timestamp = new Date().toISOString();
    const metadata = {
      ...(dto.metadata ?? {}),
      type: dto.type,
      entityId: dto.entityId ?? '',
      timestamp,
    };
    const notification = await this.createInApp(userId, {
      ...dto,
      metadata,
    });
    await this.sendPush(userId, dto.title, dto.body, {
      type: dto.type,
      entityId: dto.entityId ?? '',
      timestamp,
      notificationId: notification.id,
    });
    return notification;
  }
}