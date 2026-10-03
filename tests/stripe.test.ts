import assert from 'node:assert/strict';
import test from 'node:test';
import { signBillingPayload } from '../server/billing';
import { registerTenant, startTestApp } from './helpers';

const SECRET = 'whsec_test_navigator_bridge_secret';

function stripeEvent(id: string, type: string, object: Record<string, unknown>) {
  return JSON.stringify({ id, type, data: { object } });
}

test('stripe bridge: checkout grants Navigator, duplicate ignored, deletion revokes, bad signature rejected', async () => {
  const t = await startTestApp({ stripeWebhookSecret: SECRET });
  try {
    const c = t.client();
    const me = await registerTenant(c, 'stripe@example.com');
    const post = (b: string, sig?: string) =>
      fetch(`${t.base}/billing/stripe/webhook`, { method: 'POST', body: b, headers: sig ? { 'stripe-signature': sig } : {} });

    const checkout = stripeEvent('evt_checkout_1', 'checkout.session.completed', {
      mode: 'subscription',
      payment_status: 'paid',
      client_reference_id: me.tenant.id,
      metadata: { product: 'navigator' },
    });
    assert.equal((await post(checkout)).status, 400);
    assert.equal((await post(checkout, signBillingPayload('wrong-secret-wrong-secret-wrong', checkout))).status, 400);

    const ok = await post(checkout, signBillingPayload(SECRET, checkout));
    assert.equal(ok.status, 200);
    assert.equal((await c.get('/auth/me')).body.entitlements.navigatorPlan, 'navigator');

    const dup = await (await post(checkout, signBillingPayload(SECRET, checkout))).json();
    assert.equal(dup.outcome, 'duplicate');
    assert.equal((await c.get('/auth/me')).body.entitlements.navigatorPlan, 'navigator');

    const deleted = stripeEvent('evt_sub_deleted_1', 'customer.subscription.deleted', {
      status: 'canceled',
      metadata: { tenantId: me.tenant.id, product: 'navigator' },
    });
    const del = await post(deleted, signBillingPayload(SECRET, deleted));
    assert.equal(del.status, 200);
    assert.equal((await c.get('/auth/me')).body.entitlements.navigatorPlan, 'evaluation');

    const unrelated = stripeEvent('evt_ping', 'payment_intent.created', { metadata: { tenantId: me.tenant.id } });
    const ignored = await (await post(unrelated, signBillingPayload(SECRET, unrelated))).json();
    assert.equal(ignored.outcome, 'ignored_type');
  } finally {
    await t.close();
  }
});

test('stripe bridge: unconfigured secret returns 503', async () => {
  const t = await startTestApp({ stripeWebhookSecret: '' });
  try {
    const res = await fetch(`${t.base}/billing/stripe/webhook`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 503);
  } finally {
    await t.close();
  }
});
