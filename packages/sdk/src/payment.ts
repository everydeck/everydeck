/**
 * Payments (server only), in their own module so the browser bundle does not carry them: the index of the package (Node) loads it, the browser entry
 * does not. Set where the app itself talks to its payment provider: the checkout it opens and the webhook it receives. Names follow the Segment
 * e-commerce spec (Checkout Started, Order Completed, Order Refunded) and Stripe (payment failed, checkout expired). Only the amount (`total`, in the
 * main unit of the currency, e.g. 49.00), the currency (ISO 4217), the product, the quantity, the provider's ids and a short failure reason travel;
 * the person and the object go in `subjectRef`, `accountRef`, `objectType`, `objectRef`. Never card data: an event with a value that looks like a card
 * number is not sent. `orderId` (or `checkoutId` for a checkout) is required: everydeck counts the same id once per event, so a repeated webhook is safe.
 * Several refunds of one order (partial refunds) and several failed attempts (retries): `refundId` (the provider's id of this refund, Stripe `re_…`) and
 * `attemptId` (of this failed attempt, Stripe `ch_…`) make each count once; without them everydeck keeps one refund and one failure per order, as before.
 * `provider` (as in money.providers of the app map: stripe, paddle …) tells everydeck which provider the payment came from.
 */
import { createHash } from 'node:crypto';
import { EverydeckClient, scrubClip } from './core.js';

/** Payment events (server only): the five moments of a payment, named after the Segment e-commerce spec and Stripe */
export const PAYMENT_EVENTS = { checkout_started: 'everydeck.checkout.started', order_completed: 'everydeck.order.completed', payment_failed: 'everydeck.payment.failed', order_refunded: 'everydeck.order.refunded', checkout_abandoned: 'everydeck.checkout.abandoned' } as const;
export type PaymentEvent = keyof typeof PAYMENT_EVENTS;
const PAYMENT_SHORT: Record<PaymentEvent, string> = { checkout_started: 'started', order_completed: 'paid', payment_failed: 'failed', order_refunded: 'refunded', checkout_abandoned: 'abandoned' };
const PAYMENT_ID_MAX = 100;
/** the length of a business key in an event (event batch schema); a longer key of an order and a refund or attempt becomes a hash of both ids */
const KEY_MAX = 128;
const PROVIDER = /^[a-z][a-z0-9_-]{0,39}$/;
export interface PaymentDetails { orderId?: string; checkoutId?: string; refundId?: string; attemptId?: string; total?: number; currency?: string; product?: string; quantity?: number; reason?: string; provider?: string; subjectRef?: string; accountRef?: string; objectType?: string; objectRef?: string }
/** 13 to 19 digits (also with spaces or dashes) with a valid Luhn checksum look like a card number */
export function looksLikeCard(v: string): boolean {
  for (const m of v.matchAll(/(?:\d[ -]?){12,18}\d/g)) {
    const d = m[0].replace(/[ -]/g, ''); if (d.length < 13 || d.length > 19) continue;
    let sum = 0; for (let i = 0; i < d.length; i++) { let x = Number(d[d.length - 1 - i]); if (i % 2) { x *= 2; if (x > 9) x -= 9; } sum += x; }
    if (sum % 10 === 0) return true;
  }
  return false;
}

declare module './core.js' {
  interface EverydeckClient {
    /** Payments (server only), see the top of payment.ts */
    payment(event: PaymentEvent, o: PaymentDetails): void;
  }
}

EverydeckClient.prototype.payment = function payment(this: EverydeckClient, event: PaymentEvent, o: PaymentDetails): void {
  const name = PAYMENT_EVENTS[event]; const id = o.orderId ?? o.checkoutId;
  if (!name) { this.opts.onWarning(`payment event rejected: ${String(event)}`); return; }
  if (!id || id.length > PAYMENT_ID_MAX) { if (id) this.noteLoss('sdk_payment_id'); this.opts.onWarning(`payment ${event} needs orderId or checkoutId (at most ${PAYMENT_ID_MAX} characters)`); return; }
  // the id of this one refund or failed attempt; only on its own event
  const subKey = event === 'order_refunded' ? 'refundId' : event === 'payment_failed' ? 'attemptId' : null;
  for (const k of ['refundId', 'attemptId'] as const) if (o[k] !== undefined && k !== subKey) this.opts.onWarning(`payment ${event}: ${k} belongs to ${k === 'refundId' ? 'order_refunded' : 'payment_failed'} (left out)`);
  const sub = subKey ? o[subKey] : undefined;
  if (sub !== undefined && (typeof sub !== 'string' || !sub || sub.length > PAYMENT_ID_MAX)) { if (sub) this.noteLoss('sdk_payment_id'); this.opts.onWarning(`payment ${event}: ${subKey} must be at most ${PAYMENT_ID_MAX} characters`); return; }
  const strings = [o.orderId, o.checkoutId, sub, o.product, o.reason, o.currency, o.subjectRef, o.accountRef, o.objectRef].filter((x): x is string => typeof x === 'string');
  if (strings.some(looksLikeCard)) { this.opts.onWarning(`payment ${event} not sent: a value looks like a card number`); return; }
  const total = typeof o.total === 'number' && Number.isFinite(o.total) && o.total >= 0 ? o.total : undefined;
  const quantity = typeof o.quantity === 'number' && Number.isInteger(o.quantity) && o.quantity >= 1 && o.quantity <= 100_000 ? o.quantity : undefined;
  const currency = typeof o.currency === 'string' && /^[A-Za-z]{3}$/.test(o.currency.trim()) ? o.currency.trim().toUpperCase() : undefined;
  if (o.total !== undefined && total === undefined) this.opts.onWarning(`payment ${event}: total must be a number of at least 0 (left out)`);
  if (o.currency !== undefined && currency === undefined) this.opts.onWarning(`payment ${event}: currency must be an ISO 4217 code such as USD (left out)`);
  const provider = typeof o.provider === 'string' && PROVIDER.test(o.provider) ? o.provider : undefined;
  if (o.provider !== undefined && provider === undefined) this.opts.onWarning(`payment ${event}: provider must be the name in money.providers of the app map, such as stripe (left out)`);
  // nobody is signed in during a webhook; without a person and an organization the payment counts for nobody (no customer shows what they pay)
  if (!o.subjectRef && !o.accountRef) this.opts.onWarning(`payment ${event} without subjectRef or accountRef: everydeck counts it for nobody, so no customer shows what they pay. In a webhook take them from what the app stored for this payment (the client_reference_id or metadata it set at checkout, or its row for the provider's customer or subscription)`);
  const fields: Record<string, string | number> = {};
  for (const [k, v] of Object.entries({ order_id: o.orderId, checkout_id: o.checkoutId, refund_id: subKey === 'refundId' ? sub : undefined, attempt_id: subKey === 'attemptId' ? sub : undefined, total, currency,
    product: o.product ? scrubClip(o.product, 120) : undefined, quantity, reason: o.reason ? scrubClip(o.reason, 60) : undefined, provider })) if (v !== undefined && v !== '') fields[k] = v;
  const refs = { businessKey: paymentKey(PAYMENT_SHORT[event], id, sub), fields, ...(o.subjectRef ? { subjectRef: o.subjectRef } : {}), ...(o.accountRef ? { accountRef: o.accountRef } : {}), ...(o.objectType ? { objectType: o.objectType } : {}), ...(o.objectRef ? { objectRef: o.objectRef } : {}) };
  this.signal(name, `everydeck.sdk:payment:${id}`, refs);
};

/** the business key: one per event of an order, with the refund or attempt id; too long for an event, a hash of both ids (the same in the Python SDK) */
export function paymentKey(short: string, id: string, sub?: string): string {
  if (!sub) return `everydeck.pay:${short}:${id}`;
  const key = `everydeck.pay:${short}:${id}:${sub}`;
  return key.length <= KEY_MAX ? key : `everydeck.pay:${short}:h:${createHash('sha256').update(`${id}\n${sub}`).digest('hex')}`;
}
