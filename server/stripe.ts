import { Router, raw } from 'express';
import { applyBillingGrant, verifyBillingSignature } from './billing';
import { HttpError, type Deps } from './http';

/**
 * Stripe -> entitlement bridge for the Navigator paywall ($74.99/mo, priced on the Stripe side;
 * no prices live in this codebase by design).
 *
 * Checkout is a Stripe Payment Link (config: STRIPE_PAYMENT_LINK_NAVIGATOR). The link must set
 * subscription metadata `product=navigator` (or `navigator_radar_linked` for the bundle), and the
 * app sends buyers with `?client_reference_id=<tenantId>` appended so the webhook can attribute
 * the subscription. Stripe's `t=...,v1=...` signature scheme matches verifyBillingSignature, so
 * no Stripe SDK is needed. Grants flow through applyBillingGrant, the same idempotent path as
 * the internal billing webhook; Stripe event ids are prefixed `stripe:` in billing_events.
 */
export function stripeRouter(deps: Deps): Router {
  const r = Router();
  r.post('/stripe/webhook', raw({ type: '*/*', limit: '256kb' }), (req, res) => {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const secret = deps.config.stripeWebhookSecret;
    if (!secret) throw new HttpError(503, 'Stripe webhook is not configured', 'not_configured');
    if (!verifyBillingSignature(secret, body, req.header('stripe-signature'))) throw new HttpError(400, 'Invalid signature', 'invalid_signature');
    let event: { id?: string; type?: string; data?: { object?: Record<string, any> } };
    try { event = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'Invalid event', 'invalid_event'); }
    const obj = event?.data?.object ?? {};
    const tenantId = obj.client_reference_id || obj.metadata?.tenantId || obj.metadata?.tenant_id;
    const product = typeof obj.metadata?.product === 'string' ? obj.metadata.product : 'navigator';
    let granted: boolean | null = null;
    if (event.type === 'checkout.session.completed' && (obj.mode === 'subscription' || obj.payment_status === 'paid')) granted = true;
    else if (event.type === 'customer.subscription.deleted') granted = false;
    else if (event.type === 'customer.subscription.updated') {
      if (obj.status === 'active' || obj.status === 'trialing') granted = true;
      else if (obj.status === 'canceled' || obj.status === 'unpaid' || obj.status === 'incomplete_expired') granted = false;
    }
    if (granted === null) return res.json({ ok: true, outcome: 'ignored_type' });
    if (!tenantId || !event.id) return res.json({ ok: true, outcome: 'ignored_missing_tenant' });
    const outcome = applyBillingGrant(deps, {
      id: `stripe:${event.id}`,
      tenantId: String(tenantId),
      product,
      granted,
      payload: body.toString('utf8'),
    });
    res.json({ ok: true, outcome });
  });
  return r;
}
