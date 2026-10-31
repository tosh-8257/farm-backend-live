import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Res,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { escapeHtml as h } from './business-commerce.service';
import { BusinessWebCheckoutService } from './business-web-checkout.service';

const APP_LINK = 'farm://farm.com/pay-business';

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h(title)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f4f4f4;color:#111;margin:0;padding:24px}main{max-width:440px;margin:0 auto;background:#fff;border:1px solid #ddd;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px}.muted{color:#666}.amt{font-size:32px;font-weight:bold;margin:16px 0}.btn{display:block;width:100%;box-sizing:border-box;text-align:center;padding:14px;border-radius:8px;border:1px solid #111;background:#111;color:#fff;font-size:16px;text-decoration:none;margin-top:12px;cursor:pointer}
.btn.alt{background:#fff;color:#111}label{display:block;margin-top:12px;font-size:14px}select,input{width:100%;box-sizing:border-box;padding:10px;margin-top:4px;border:1px solid #bbb;border-radius:6px;font-size:16px}hr{border:0;border-top:1px solid #eee;margin:20px 0}</style></head><body><main>${body}</main></body></html>`;
}

/** Public hosted pay pages: /api/pay/l/:code and /api/pay/i/:invoiceNumber */
@ApiExcludeController()
@Controller({ path: 'pay', version: VERSION_NEUTRAL })
export class BusinessWebCheckoutController {
  constructor(private readonly svc: BusinessWebCheckoutService) {}

  private async render(
    res: Response,
    kind: 'link' | 'invoice',
    ref: string,
    error?: string,
  ) {
    try {
      const t = await this.svc.target(kind, ref);
      const appUrl = `${APP_LINK}?${kind === 'link' ? 'code' : 'invoice'}=${encodeURIComponent(t.ref)}`;
      let kes = '';
      if (t.payable) {
        try {
          kes = ` &middot; about KES ${(await this.svc.quoteKes(t.amount)).toFixed(2)}`;
        } catch {
          kes = '';
        }
      }
      const form = t.payable
        ? `<a class="btn" href="${h(appUrl)}">Open in FARM app</a><hr><p class="muted">No FARM app? Pay on the web.</p>
<form method="post" action="/api/pay/${kind === 'link' ? 'l' : 'i'}/${encodeURIComponent(t.ref)}/checkout">
<label>Payment method<select name="method" required><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="bank">Bank transfer</option><option value="crypto">Crypto</option></select></label>
<label>Email for your receipt<input type="email" name="email" maxlength="255" required></label>
<button class="btn alt" type="submit">Pay on the web</button></form>`
        : `<p><b>This ${kind === 'link' ? 'payment link' : 'invoice'} cannot be paid (${h(t.state)}).</b></p>`;
      res
        .status(200)
        .type('html')
        .send(
          page(
            t.title,
            `<p class="muted">${h(t.business_name)}</p><h1>${h(t.title)}</h1><p class="muted">${h(t.description)}</p>
<div class="amt">${t.amount.toFixed(2)} FARM</div><p class="muted">${kes.replace(/^ &middot; /, '')}</p>${error ? `<p><b>${h(error)}</b></p>` : ''}${form}`,
          ),
        );
    } catch (e) {
      const status = e instanceof HttpException ? e.getStatus() : 500;
      res
        .status(status)
        .type('html')
        .send(
          page(
            'Not available',
            `<h1>Not available</h1><p class="muted">${h(e instanceof HttpException ? e.message : 'Something went wrong. Try again later.')}</p>`,
          ),
        );
    }
  }

  private kindOf(kind: string) {
    return kind === 'l' ? 'link' : kind === 'i' ? 'invoice' : null;
  }

  /** JSON for the farmpay.africa hosted checkout (pay-doc.html). */
  @Get('data/:kind/:ref')
  async data(@Param('kind') kind: string, @Param('ref') ref: string) {
    const k = this.kindOf(kind);
    if (!k) throw new HttpException('Not found', 404);
    const t = await this.svc.target(k, ref);
    let amount_kes: number | null = null;
    if (t.payable) {
      try {
        amount_kes = Number((await this.svc.quoteKes(t.amount)).toFixed(2));
      } catch {
        amount_kes = null;
      }
    }
    return {
      success: true,
      data: {
        kind: k,
        ref: t.ref,
        title: t.title,
        description: t.description,
        business_name: t.business_name,
        amount: t.amount,
        amount_kes,
        payable: t.payable,
        state: t.state,
      },
    };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('data/:kind/:ref/checkout')
  async dataCheckout(
    @Param('kind') kind: string,
    @Param('ref') ref: string,
    @Body() body: { method?: string; email?: string },
  ) {
    const k = this.kindOf(kind);
    if (!k) throw new HttpException('Not found', 404);
    const email =
      typeof body?.email === 'string' ? body.email.slice(0, 255) : undefined;
    const { url, reference } = await this.svc.start(
      k,
      ref,
      String(body?.method ?? ''),
      email,
    );
    return { success: true, data: { url, reference } };
  }

  @Get('l/:code')
  link(@Param('code') code: string, @Res() res: Response) {
    return this.render(res, 'link', code);
  }

  @Get('i/:number')
  invoice(@Param('number') n: string, @Res() res: Response) {
    return this.render(res, 'invoice', n);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(':kind/:ref/checkout')
  async checkout(
    @Param('kind') kind: string,
    @Param('ref') ref: string,
    @Body() body: { method?: string; email?: string },
    @Res() res: Response,
  ) {
    const k = kind === 'l' ? 'link' : kind === 'i' ? 'invoice' : null;
    if (!k)
      return res
        .status(404)
        .type('html')
        .send(page('Not found', '<h1>Not found</h1>'));
    try {
      const email =
        typeof body?.email === 'string' ? body.email.slice(0, 255) : undefined;
      const { url } = await this.svc.start(
        k,
        ref,
        String(body?.method ?? ''),
        email,
      );
      // A link (not a 302) because Helmet's CSP form-action 'self' blocks
      // cross-origin redirects after a form post in some browsers.
      return res
        .type('html')
        .send(
          page(
            'Continue to payment',
            `<h1>Continue to payment</h1><p class="muted">You will finish paying with our payment provider.</p><a class="btn" href="${h(url)}">Continue</a>`,
          ),
        );
    } catch (e) {
      return this.render(
        res,
        k,
        ref,
        e instanceof HttpException ? e.message : 'Could not start the payment.',
      );
    }
  }

  /** Status page a payer (or the app) can open after paying; also reconciles. */
  @Get('status/:reference')
  async status(@Param('reference') reference: string, @Res() res: Response) {
    try {
      const s = await this.svc.reconcile(reference);
      const msg =
        s === 'completed'
          ? 'Payment received. Thank you.'
          : s === 'failed'
            ? 'The payment failed. You were not charged.'
            : 'Payment is still processing. Refresh this page in a minute.';
      return res
        .type('html')
        .send(
          page(
            'Payment status',
            `<h1>${h(msg)}</h1><p class="muted">Reference ${h(reference)}</p>`,
          ),
        );
    } catch (e) {
      return res
        .status(e instanceof HttpException ? e.getStatus() : 500)
        .type('html')
        .send(page('Payment status', '<h1>Payment not found</h1>'));
    }
  }
}
