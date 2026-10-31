import { languageInstruction } from './voice.service';
import { Prisma } from '@prisma/client';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import { AiProvider, ChatMessage, ProviderUsage } from './ai-provider';
import { MkulimaBillingService } from './mkulima-billing.service';
import { AiToolsService } from './ai-tools.service';
import { TravelService } from '../travel/travel.service';
import { AgentPaymentsService } from '../agent-payments/agent-payments.service';
import { HotelsService } from '../travel/hotels.service';

export const AI_ACTIONS = [
  'send_farm',
  'book_flight',
  'book_hotel',
  'pay_intent',
] as const;
export const SPEND_CATEGORIES = [
  'Hotels',
  'Flights',
  'Transport',
  'Shopping',
  'Bills',
  'Services',
  'Investments',
  'Crypto',
] as const;
/** Category each AI action spends in. Sending FARM to a person is a transfer, governed by allowed_actions only. */
const ACTION_CATEGORY: Record<string, string | undefined> = {
  book_flight: 'Flights',
  book_hotel: 'Hotels',
  pay_intent: 'Services',
};
const ACTIVITY_STATUS: Record<string, string> = {
  pending: 'Awaiting Approval',
  processing: 'Processing',
  executed: 'Completed',
  failed: 'Failed',
  rejected: 'Cancelled',
  cancelled: 'Cancelled',
  expired: 'Cancelled',
};
const BOOKING_STATUS: Record<string, string> = {
  pending: 'Pending',
  payment_held: 'Processing',
  confirmed: 'Completed',
  needs_review: 'Pending',
  refunding: 'Processing',
  failed_refunded: 'Refunded',
};
const ACTION_TTL_MS = 10 * 60 * 1000;
const MAX_TOOL_ROUNDS = 4;
const HISTORY = 20;

const SYSTEM_PROMPT = `You are Mkulima, the assistant inside the FARM app (Kenya). FARM is the in-app currency, 1 FARM = 1 KSh.
Answer only from tool results; never invent balances, transactions, investments, invoices or projects. If data is missing say so.
You cannot approve businesses or projects, change limits, or move money yourself. For payments use propose_payment (or propose_intent_payment for a business payment request id): it only creates a pending request the user must confirm in the app with their PIN. Never say money was sent.
For hotels use search_hotels then propose_hotel_booking (the user confirms in chat with their PIN; guest details come from their profile). If a tool says flights or hotels are not available yet, tell the user plainly that the service is not available yet.
Never ask for, accept or repeat a PIN in chat; PINs are only entered in the app's secure PIN prompt.
Reply in the language the user writes or speaks (including Swahili and Sheng).
Give general information, not personalised financial advice. Be brief and clear.`;

const startOfDay = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Stringify a tool-call argument; non-primitive values become ''. */
const argStr = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    ? String(v)
    : '';

@Injectable()
export class AiAssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AiProvider,
    private readonly tools: AiToolsService,
    private readonly wallets: WalletsService,
    private readonly config: ConfigService,
    private readonly travel: TravelService,
    private readonly agentPayments: AgentPaymentsService,
    @Optional() private readonly hotels?: HotelsService,
    @Optional() private readonly billing?: MkulimaBillingService,
  ) {}

  status() {
    return { enabled: this.provider.isConfigured(), actions: AI_ACTIONS };
  }

  audit(userId: string, event: string, details?: Record<string, unknown>) {
    return this.prisma.ai_audit_log.create({
      data: {
        user_id: userId,
        event,
        details: (details ?? {}) as Prisma.InputJsonValue,
      },
    });
  }

  // ---------- conversations ----------
  listConversations(userId: string) {
    return this.prisma.ai_conversations.findMany({
      where: { user_id: userId },
      orderBy: { updated_at: 'desc' },
      take: 50,
    });
  }

  async getConversation(userId: string, id: string) {
    const c = await this.prisma.ai_conversations.findFirst({
      where: { id, user_id: userId },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    const messages = await this.prisma.ai_messages.findMany({
      where: {
        conversation_id: id,
        user_id: userId,
        role: { in: ['user', 'assistant'] },
      },
      orderBy: { created_at: 'asc' },
    });
    return { ...c, messages };
  }

  async deleteConversation(userId: string, id: string) {
    const r = await this.prisma.ai_conversations.deleteMany({
      where: { id, user_id: userId },
    });
    if (!r.count) throw new NotFoundException('Conversation not found');
    await this.audit(userId, 'conversation_deleted', { conversation_id: id });
    return { deleted: true };
  }

  async chat(
    userId: string,
    text: string,
    conversationId?: string,
    language?: string,
  ) {
    if (!this.provider.isConfigured())
      throw new HttpException(
        'AI assistant is not enabled',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    const message = (text ?? '').trim();
    if (!message || message.length > 2000)
      throw new BadRequestException('Message must be 1-2000 characters');
    const limit = Number(
      this.config.get<string>('AI_DAILY_MESSAGE_LIMIT') ?? 50,
    );
    const used = await this.prisma.ai_messages.count({
      where: {
        user_id: userId,
        role: 'user',
        created_at: { gte: startOfDay() },
      },
    });
    if (used >= limit)
      throw new HttpException(
        'Daily assistant message limit reached',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    // Silent billing: blocks with a plain top-up message when the wallet is too low.
    await this.billing?.assertCanUse(userId, this.provider.model());

    let conv = conversationId
      ? await this.prisma.ai_conversations.findFirst({
          where: { id: conversationId, user_id: userId },
        })
      : null;
    if (conversationId && !conv)
      throw new NotFoundException('Conversation not found');
    if (!conv)
      conv = await this.prisma.ai_conversations.create({
        data: { user_id: userId, title: message.slice(0, 60) },
      });

    const history = await this.prisma.ai_messages.findMany({
      where: { conversation_id: conv.id, role: { in: ['user', 'assistant'] } },
      orderBy: { created_at: 'desc' },
      take: HISTORY,
    });
    await this.prisma.ai_messages.create({
      data: {
        conversation_id: conv.id,
        user_id: userId,
        role: 'user',
        content: message,
      },
    });

    const msgs: ChatMessage[] = [
      {
        role: 'system',
        content: [SYSTEM_PROMPT, languageInstruction(language)]
          .filter(Boolean)
          .join('\n'),
      },
      ...history.reverse().map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: message },
    ];
    const proposed: unknown[] = [];
    const usages: ProviderUsage[] = [];
    let reply = '';
    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const { usage, ...out } = await this.provider.complete(
          msgs,
          round < MAX_TOOL_ROUNDS ? this.tools.specs() : [],
        );
        if (usage) usages.push(usage);
        if (!out.tool_calls?.length) {
          reply = (out.content ?? '').trim();
          break;
        }
        msgs.push(out);
        for (const call of out.tool_calls) {
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(call.function.arguments || '{}') as Record<
              string,
              unknown
            >;
          } catch {
            args = {};
          }
          let result: unknown;
          try {
            if (call.function.name === 'propose_payment') {
              const req = await this.proposePayment(userId, args, conv.id);
              proposed.push(req);
              result = {
                status: 'pending_user_confirmation',
                request_id: req.id,
                amount: Number(req.amount),
                recipient: req.recipient_identifier,
                expires_at: req.expires_at,
              };
            } else if (call.function.name === 'propose_flight_booking') {
              const req = await this.proposeFlight(userId, args, conv.id);
              proposed.push(req);
              result = {
                status: 'pending_user_confirmation',
                request_id: req.id,
                price_farm: Number(req.amount),
                note: 'The user must open the request, enter passenger details and confirm with their PIN.',
              };
            } else if (call.function.name === 'propose_intent_payment') {
              const req = await this.proposeIntent(userId, args, conv.id);
              proposed.push(req);
              result = {
                status: 'pending_user_confirmation',
                request_id: req.id,
                amount: Number(req.amount),
                business: req.recipient_identifier,
              };
            } else if (call.function.name === 'get_agent_payment_requests') {
              result = {
                requests: (
                  await this.agentPayments.myRequests(userId, 'pending')
                ).map((r) => ({
                  id: r.id,
                  business: r.business_name,
                  amount: r.amount,
                  description: r.description,
                  expires_at: r.expires_at,
                })),
                note: 'The user approves these in Payments > Agent requests with their PIN.',
              };
            } else if (call.function.name === 'search_hotels') {
              result = await this.searchHotels(args);
            } else if (call.function.name === 'propose_hotel_booking') {
              const req = await this.proposeHotel(userId, args, conv.id);
              proposed.push(req);
              result = {
                status: 'pending_user_confirmation',
                request_id: req.id,
                price_farm: Number(req.amount),
                hotel: req.recipient_identifier,
                note: 'The user confirms this booking in the chat with their PIN. Guest details come from their profile.',
              };
            } else if (
              call.function.name === 'search_flights' &&
              !this.travel.enabled()
            ) {
              result = {
                available: false,
                message: 'Flights are not available yet.',
              };
            } else if (call.function.name === 'search_flights') {
              const offers = await this.travel.search(args as any);
              result = {
                offers: offers.slice(0, 5).map((o) => ({
                  offer_id: o.id,
                  airline: o.owner,
                  price_farm: o.price_farm,
                  bookable: o.bookable,
                  slices: o.slices.map((x) => ({
                    from: x.origin,
                    to: x.destination,
                    departs: x.segments[0]?.departing_at,
                    stops: x.segments.length - 1,
                  })),
                })),
              };
            } else if (call.function.name === 'get_spend_permissions') {
              result = await this.getPermissions(userId);
            } else {
              result = await this.tools.run(userId, call.function.name, args);
            }
          } catch (e) {
            result = { error: (e as Error).message };
          }
          await this.audit(userId, 'tool_call', {
            tool: call.function.name,
            conversation_id: conv.id,
          });
          msgs.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(result),
          });
        }
      }
    } finally {
      // Charge for what the provider actually consumed, even if a later round failed.
      if (usages.length)
        await this.billing?.charge({
          userId,
          kind: 'chat',
          model: this.provider.model(),
          conversationId: conv.id,
          usages,
        });
    }
    if (!reply) reply = 'Sorry, I could not complete that. Please try again.';
    const saved = await this.prisma.ai_messages.create({
      data: {
        conversation_id: conv.id,
        user_id: userId,
        role: 'assistant',
        content: reply,
      },
    });
    await this.prisma.ai_conversations.update({
      where: { id: conv.id },
      data: { updated_at: new Date() },
    });
    return {
      conversation_id: conv.id,
      message: saved,
      pending_actions: proposed,
    };
  }

  // ---------- spend permissions ----------
  async getPermissions(userId: string) {
    const p = await this.prisma.ai_spend_permissions.findUnique({
      where: { user_id: userId },
    });
    if (!p)
      return {
        enabled: false,
        per_tx_cap: 0,
        daily_cap: 0,
        allowed_actions: [] as string[],
        spend_categories: [...SPEND_CATEGORIES] as string[],
        revoked_at: null,
        spent_today: 0,
      };
    return {
      enabled: p.enabled && !p.revoked_at,
      per_tx_cap: Number(p.per_tx_cap),
      daily_cap: Number(p.daily_cap),
      allowed_actions: p.allowed_actions,
      spend_categories: p.spend_categories,
      revoked_at: p.revoked_at,
      spent_today: await this.committedToday(userId),
    };
  }

  async updatePermissions(
    userId: string,
    dto: {
      enabled: boolean;
      per_tx_cap: number;
      daily_cap: number;
      allowed_actions: string[];
      spend_categories?: string[];
    },
  ) {
    const actions = [...new Set(dto.allowed_actions ?? [])];
    const cats =
      dto.spend_categories === undefined
        ? undefined
        : [...new Set(dto.spend_categories)];
    if (cats?.some((c) => !(SPEND_CATEGORIES as readonly string[]).includes(c)))
      throw new BadRequestException('Unknown category');
    if (actions.some((a) => !(AI_ACTIONS as readonly string[]).includes(a)))
      throw new BadRequestException('Unknown action');
    if (!(dto.per_tx_cap >= 0) || !(dto.daily_cap >= 0))
      throw new BadRequestException('Caps must be zero or more');
    if (dto.per_tx_cap > dto.daily_cap)
      throw new BadRequestException(
        'Per-transaction cap cannot exceed the daily cap',
      );
    if (dto.daily_cap > 100_000)
      throw new BadRequestException('Daily cap cannot exceed 100,000 FARM');
    const data = {
      enabled: !!dto.enabled,
      per_tx_cap: dto.per_tx_cap,
      daily_cap: dto.daily_cap,
      allowed_actions: actions,
      ...(cats ? { spend_categories: cats } : {}),
      revoked_at: null,
    };
    await this.prisma.ai_spend_permissions.upsert({
      where: { user_id: userId },
      create: { user_id: userId, ...data },
      update: data,
    });
    await this.audit(userId, 'permissions_updated', {
      enabled: data.enabled,
      per_tx_cap: dto.per_tx_cap,
      daily_cap: dto.daily_cap,
      allowed_actions: actions,
      spend_categories: cats,
    });
    return this.getPermissions(userId);
  }

  async revokePermissions(userId: string) {
    const now = new Date();
    await this.prisma.ai_spend_permissions.upsert({
      where: { user_id: userId },
      create: { user_id: userId, enabled: false, revoked_at: now },
      update: { enabled: false, revoked_at: now, allowed_actions: [] },
    });
    const cancelled = await this.prisma.ai_action_requests.updateMany({
      where: { user_id: userId, status: 'pending' },
      data: {
        status: 'cancelled',
        decided_at: now,
        failure_reason: 'permissions revoked',
      },
    });
    await this.audit(userId, 'permissions_revoked', {
      cancelled_pending: cancelled.count,
    });
    return this.getPermissions(userId);
  }

  /** Sum of today's executed + still-pending AI payments (pending counts so caps cannot be bypassed by queuing). */
  private async committedToday(userId: string) {
    const agg = await this.prisma.ai_action_requests.aggregate({
      where: {
        user_id: userId,
        created_at: { gte: startOfDay() },
        OR: [
          { status: 'executed' },
          { status: 'pending', expires_at: { gt: new Date() } },
        ],
      },
      _sum: { amount: true },
    });
    return Number(agg._sum.amount ?? 0);
  }

  private async checkCaps(
    userId: string,
    amount: number,
    excludeId?: string,
    action = 'send_farm',
  ) {
    const p = await this.prisma.ai_spend_permissions.findUnique({
      where: { user_id: userId },
    });
    if (!p || !p.enabled || p.revoked_at)
      throw new ForbiddenException(
        'AI payments are turned off. Enable them in Assistant settings.',
      );
    if (!p.allowed_actions.includes(action))
      throw new ForbiddenException(
        `${({ book_flight: 'Booking flights', book_hotel: 'Booking hotels', pay_intent: 'Paying businesses' } as Record<string, string>)[action] ?? 'Sending FARM'} is not an allowed AI action`,
      );
    const cat = ACTION_CATEGORY[action];
    if (cat && !(p.spend_categories ?? []).includes(cat))
      throw new ForbiddenException(
        `${cat} is turned off in your Mkulima spending categories`,
      );
    if (amount > Number(p.per_tx_cap))
      throw new ForbiddenException(
        `Amount exceeds your per-transaction AI cap of ${Number(p.per_tx_cap)} FARM`,
      );
    let today = await this.committedToday(userId);
    if (excludeId) {
      const self = await this.prisma.ai_action_requests.findFirst({
        where: { id: excludeId, user_id: userId },
      });
      if (self && self.created_at >= startOfDay()) today -= Number(self.amount);
    }
    if (today + amount > Number(p.daily_cap))
      throw new ForbiddenException(
        `Amount exceeds your daily AI cap of ${Number(p.daily_cap)} FARM`,
      );
  }

  // ---------- actions ----------
  async proposePayment(
    userId: string,
    args: Record<string, unknown>,
    conversationId?: string,
  ) {
    const recipient = argStr(args.recipient_identifier).trim();
    const amount = Math.round(Number(args.amount) * 100) / 100;
    const description = args.description
      ? argStr(args.description).slice(0, 140)
      : null;
    if (!recipient || recipient.length > 120)
      throw new BadRequestException('Recipient is required');
    if (!Number.isFinite(amount) || amount <= 0)
      throw new BadRequestException('Amount must be greater than zero');
    await this.checkCaps(userId, amount);
    const req = await this.prisma.ai_action_requests.create({
      data: {
        user_id: userId,
        conversation_id: conversationId ?? null,
        action: 'send_farm',
        recipient_identifier: recipient,
        amount,
        description,
        expires_at: new Date(Date.now() + ACTION_TTL_MS),
      },
    });
    await this.audit(userId, 'action_proposed', {
      request_id: req.id,
      action: 'send_farm',
      amount,
      recipient,
    });
    return req;
  }

  async proposeFlight(
    userId: string,
    args: Record<string, unknown>,
    conversationId?: string,
  ) {
    const offer = await this.travel.offer(argStr(args.offer_id));
    if (!offer.bookable || offer.price_farm == null)
      throw new BadRequestException(
        'This offer cannot be priced in FARM right now',
      );
    await this.checkCaps(userId, offer.price_farm, undefined, 'book_flight');
    const route = offer.slices
      .map((x) => `${x.origin}-${x.destination}`)
      .join(', ');
    const req = await this.prisma.ai_action_requests.create({
      data: {
        user_id: userId,
        conversation_id: conversationId ?? null,
        action: 'book_flight',
        recipient_identifier: `${offer.owner} ${route}`.slice(0, 120),
        amount: offer.price_farm,
        description: `Flight ${route}`,
        payload: { offer_id: offer.id },
        expires_at: new Date(Date.now() + ACTION_TTL_MS),
      },
    });
    await this.audit(userId, 'action_proposed', {
      request_id: req.id,
      action: 'book_flight',
      amount: offer.price_farm,
      recipient: route,
    });
    return req;
  }

  async searchHotels(args: Record<string, unknown>) {
    if (!this.hotels?.enabled())
      return { available: false, message: 'Hotels are not available yet.' };
    const offers = await this.hotels.search({
      city_name: argStr(args.city_name),
      country_code: argStr(args.country_code),
      checkin: argStr(args.checkin),
      checkout: argStr(args.checkout),
      adults: Number(args.adults ?? 1),
    });
    const priced = offers
      .filter((o) => o.bookable && o.price_farm != null)
      .sort((a, b) => a.price_farm! - b.price_farm!);
    if (!priced.length)
      return { offers: [], message: 'No rooms found for those dates.' };
    return {
      offers: priced.slice(0, 5).map((o) => ({
        offer_id: o.id,
        hotel: o.hotel_name,
        stars: o.stars ?? null,
        room: o.room_name,
        board: o.board ?? null,
        refundable: o.refundable,
        price_farm: o.price_farm,
      })),
      sandbox: this.hotels.status().sandbox,
    };
  }

  async proposeHotel(
    userId: string,
    args: Record<string, unknown>,
    conversationId?: string,
  ) {
    if (!this.hotels?.enabled())
      throw new BadRequestException('Hotels are not available yet');
    const pb = await this.hotels.prebook(argStr(args.offer_id));
    if (!pb.bookable || pb.price_farm == null)
      throw new BadRequestException(
        'This room cannot be priced in FARM right now',
      );
    await this.checkCaps(userId, pb.price_farm, undefined, 'book_hotel');
    const info = await this.hotels.info(pb.hotel_id).catch(() => null);
    const name = info?.name ?? 'Hotel';
    const req = await this.prisma.ai_action_requests.create({
      data: {
        user_id: userId,
        conversation_id: conversationId ?? null,
        action: 'book_hotel',
        recipient_identifier: name.slice(0, 120),
        amount: pb.price_farm,
        description: `${name} ${pb.checkin} to ${pb.checkout}`.slice(0, 140),
        payload: {
          prebook_id: pb.prebook_id,
          hotel_id: pb.hotel_id,
          checkin: pb.checkin,
          checkout: pb.checkout,
          room_name: pb.room_name ?? null,
          refundable: pb.refundable,
          sandbox: !pb.live_mode,
        },
        expires_at: new Date(Date.now() + ACTION_TTL_MS),
      },
    });
    await this.audit(userId, 'action_proposed', {
      request_id: req.id,
      action: 'book_hotel',
      amount: pb.price_farm,
      recipient: name,
    });
    return req;
  }

  private async guestFromProfile(userId: string) {
    const u = await this.prisma.users.findUnique({
      where: { id: userId },
      select: { first_name: true, last_name: true, email: true, phone: true },
    });
    if (!u?.email)
      throw new BadRequestException(
        'Add an email address to your profile to book hotels',
      );
    // Hotel providers accept plain Latin names only: drop accents and other characters.
    const clean = (v: string) =>
      String(v ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z' -]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
    const first = clean(u.first_name);
    const last = clean(u.last_name);
    if (!first || !last)
      throw new BadRequestException(
        'Your profile name cannot be used for a hotel booking. Update your first and last name, or book from Travel.',
      );
    return {
      first_name: first,
      last_name: last,
      email: u.email,
      phone: u.phone,
    };
  }

  async proposeIntent(
    userId: string,
    args: Record<string, unknown>,
    conversationId?: string,
  ) {
    const id = argStr(args.payment_intent_id).trim();
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new BadRequestException('A valid payment_intent_id is required');
    const i = await this.agentPayments.publicIntent(id);
    if (i.status !== 'requires_payment')
      throw new BadRequestException(`This payment is ${i.status}`);
    await this.checkCaps(userId, i.amount, undefined, 'pay_intent');
    const req = await this.prisma.ai_action_requests.create({
      data: {
        user_id: userId,
        conversation_id: conversationId ?? null,
        action: 'pay_intent',
        recipient_identifier: i.business_name.slice(0, 120),
        amount: i.amount,
        description: (i.description ?? `Payment to ${i.business_name}`).slice(
          0,
          140,
        ),
        payload: { payment_intent_id: i.id },
        expires_at: new Date(
          Math.min(
            Date.now() + ACTION_TTL_MS,
            new Date(i.expires_at).getTime(),
          ),
        ),
      },
    });
    await this.audit(userId, 'action_proposed', {
      request_id: req.id,
      action: 'pay_intent',
      amount: i.amount,
      recipient: i.business_name,
    });
    return req;
  }

  async listActions(userId: string, status?: string) {
    await this.prisma.ai_action_requests.updateMany({
      where: {
        user_id: userId,
        status: 'pending',
        expires_at: { lte: new Date() },
      },
      data: { status: 'expired' },
    });
    return this.prisma.ai_action_requests.findMany({
      where: { user_id: userId, ...(status ? { status } : {}) },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
  }

  async rejectAction(userId: string, id: string) {
    const r = await this.prisma.ai_action_requests.updateMany({
      where: { id, user_id: userId, status: 'pending' },
      data: { status: 'rejected', decided_at: new Date() },
    });
    if (!r.count) throw new NotFoundException('Pending request not found');
    await this.audit(userId, 'action_rejected', { request_id: id });
    return { id, status: 'rejected' };
  }

  async confirmAction(userId: string, id: string, pin: string, ip: string) {
    if (!pin) throw new BadRequestException('Transaction PIN is required');
    const req = await this.prisma.ai_action_requests.findFirst({
      where: { id, user_id: userId },
    });
    if (!req) throw new NotFoundException('Request not found');
    if (req.status !== 'pending')
      throw new BadRequestException(`Request is ${req.status}`);
    if (req.action === 'book_flight')
      throw new BadRequestException(
        'Open this request in Travel to add passenger details and confirm',
      );
    if (req.expires_at <= new Date()) {
      await this.prisma.ai_action_requests.update({
        where: { id },
        data: { status: 'expired' },
      });
      throw new BadRequestException('Request expired');
    }
    // Re-check caps and allowlist at confirm time (user may have lowered or revoked them).
    await this.checkCaps(userId, Number(req.amount), id, req.action);
    // Claim atomically so a double tap cannot execute twice.
    const claimed = await this.prisma.ai_action_requests.updateMany({
      where: { id, user_id: userId, status: 'pending' },
      data: { status: 'processing' },
    });
    if (!claimed.count)
      throw new BadRequestException('Request already being processed');
    try {
      let ref: string | null;
      let booking: unknown;
      if (req.action === 'book_hotel') {
        if (!this.hotels)
          throw new BadRequestException('Hotels are not available yet');
        const pl = (req.payload ?? {}) as { prebook_id?: string };
        // HotelsService verifies the PIN, re-prices, holds FARM and books.
        const b = (await this.hotels.book(
          userId,
          {
            prebook_id: String(pl.prebook_id ?? ''),
            expected_total_farm: Number(req.amount),
            idempotency_key: `ai-${id}`,
            pin,
            ai_action_id: id,
            guest: await this.guestFromProfile(userId),
          },
          ip,
        )) as {
          status?: string;
          booking_reference?: string | null;
          failure_reason?: string | null;
        };
        booking = b;
        if (b.status === 'failed_refunded') {
          // Terminal: the provider refused and FARM was returned. Don't reopen.
          const reason = (b.failure_reason ?? 'provider error').slice(0, 200);
          await this.prisma.ai_action_requests.update({
            where: { id },
            data: {
              status: 'failed',
              decided_at: new Date(),
              failure_reason: reason,
            },
          });
          await this.audit(userId, 'action_failed', { request_id: id, reason });
          return { id, status: 'failed', failure_reason: reason, booking: b };
        }
        ref = b.booking_reference ?? null;
      } else if (req.action === 'pay_intent') {
        // Pays the business intent; amount comes from the intent, never from the model.
        const intentId = String(
          (req.payload as { payment_intent_id?: string } | null)
            ?.payment_intent_id ?? '',
        );
        const paid = await this.agentPayments.payIntent(
          userId,
          intentId,
          pin,
          ip,
          'mkulima',
        );
        if (Math.abs(paid.amount - Number(req.amount)) > 0.001)
          throw new BadRequestException('Payment amount changed');
        ref = paid.transaction_reference ?? null;
      } else {
        // WalletsService verifies the PIN and applies the normal limits, fees and ledger logic.
        const result = (await this.wallets.sendFunds(
          userId,
          {
            recipient_identifier: req.recipient_identifier,
            amount: Number(req.amount),
            pin,
            description: req.description ?? 'Mkulima AI payment',
          },
          ip,
        )) as { data?: { transaction_reference?: string } } | undefined;
        ref = result?.data?.transaction_reference ?? null;
      }
      await this.prisma.ai_action_requests.update({
        where: { id },
        data: {
          status: 'executed',
          decided_at: new Date(),
          transaction_ref: ref,
          failure_reason: null,
        },
      });
      await this.audit(userId, 'action_executed', {
        request_id: id,
        amount: Number(req.amount),
        recipient: req.recipient_identifier,
        transaction_ref: ref,
      });
      return {
        id,
        status: 'executed',
        transaction_ref: ref,
        ...(booking ? { booking } : {}),
      };
    } catch (e) {
      const reason = (e as Error).message?.slice(0, 200) ?? 'failed';
      // Wrong PIN etc.: return to pending so the user can retry until expiry.
      await this.prisma.ai_action_requests.update({
        where: { id },
        data: { status: 'pending', failure_reason: reason },
      });
      await this.audit(userId, 'action_failed', { request_id: id, reason });
      throw e;
    }
  }

  auditLog(userId: string) {
    return this.prisma.ai_audit_log.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
  }

  // ---------- unified activity ----------
  /** Everything Mkulima did or proposed, in one shape. Real records only. */
  async activity(userId: string) {
    const reqs = await this.prisma.ai_action_requests.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    const ids = reqs.map((r) => r.id);
    const bookings = ids.length
      ? await this.prisma.travel_bookings.findMany({
          where: { user_id: userId, ai_action_id: { in: ids } },
        })
      : [];
    const byAction = new Map(bookings.map((b) => [b.ai_action_id, b]));
    const label: Record<string, string> = {
      send_farm: 'Send FARM',
      book_flight: 'Book flight',
      book_hotel: 'Book hotel',
      pay_intent: 'Pay business',
    };
    return reqs.map((r) => {
      const b = byAction.get(r.id);
      const pendingExpired =
        r.status === 'pending' && r.expires_at <= new Date();
      let status = pendingExpired
        ? 'Cancelled'
        : (ACTIVITY_STATUS[r.status] ?? 'Pending');
      if (b) status = BOOKING_STATUS[b.status] ?? status;
      return {
        id: r.id,
        request: r.description ?? null,
        agent_action: label[r.action] ?? r.action,
        category: ACTION_CATEGORY[r.action] ?? null,
        provider: b?.provider ?? r.recipient_identifier,
        amount: Number(b?.total_farm ?? r.amount),
        payment_method: 'FARM wallet',
        status,
        timestamp: r.created_at,
        booking_ref: b?.booking_reference ?? null,
        confirmation: r.transaction_ref ?? null,
        refund_status: b
          ? b.status === 'failed_refunded'
            ? 'Refunded'
            : b.status === 'refunding'
              ? 'Refunding'
              : null
          : null,
        failure_reason: r.failure_reason ?? b?.failure_reason ?? null,
      };
    });
  }
}
