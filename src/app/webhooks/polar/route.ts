import { NextResponse } from 'next/server';
import { validateEvent, WebhookVerificationError } from '@polar-sh/sdk/webhooks.js';
import { env } from '@/lib/env.ts';
import { claimEvent } from '@/lib/db.ts';
import { polar, syncSubscription } from '@/lib/billing.ts';
import { fail } from '@/lib/http.ts';

export const runtime = 'nodejs';

/**
 * The one endpoint strangers can reach that changes billing state, so it is the
 * one worth being careful about. Three rules, all from having watched this go
 * wrong elsewhere:
 *
 * 1. **Verify the signature against the raw body.** Signing covers the exact
 *    bytes, and any framework that hands you parsed JSON has already destroyed
 *    them. `request.text()`, never `request.json()`. Getting this wrong fails
 *    closed and loudly, which is the good news.
 * 2. **Be idempotent.** Polar retries, so the same event arrives more than
 *    once, and a duplicate must not upgrade twice. Polar follows the Standard
 *    Webhooks spec, so the delivery's identity is the `webhook-id` header —
 *    unlike Stripe there is no event id inside the body to key on.
 * 3. **Reconcile, do not apply diffs.** `subscription.updated` can arrive
 *    before `subscription.created`. Reading the current state from Polar and
 *    writing that makes order stop mattering; applying the event's delta makes
 *    it matter enormously.
 */
export async function POST(request: Request) {
  // The raw bytes, before anything parses them.
  const payload = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });

  const deliveryId = headers['webhook-id'];
  if (!deliveryId) return fail(400, 'unsigned', 'no webhook-id on this request');

  let event: ReturnType<typeof validateEvent>;
  try {
    event = validateEvent(payload, headers, env.polar.webhookSecret);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      console.error('[service] webhook signature rejected');
      return fail(400, 'bad_signature', 'that signature does not check out');
    }
    throw error;
  }

  // Polar treats any 2xx as "delivered", so from here on a failure has to be a
  // non-2xx or the event is lost. It retries; reconcile-on-read catches
  // whatever slips through even then.
  try {
    if (!(await claimEvent(deliveryId))) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    await handle(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('[service] webhook handling failed', event.type, error);
    return fail(500, 'handler_failed', 'could not handle that event — please retry');
  }
}

async function handle(event: ReturnType<typeof validateEvent>): Promise<void> {
  switch (event.type) {
    case 'subscription.created':
    case 'subscription.updated':
    case 'subscription.active':
    case 'subscription.canceled':
    case 'subscription.uncanceled':
    case 'subscription.past_due':
    case 'subscription.revoked': {
      // The account id travels inside the event, because checkout set it as the
      // customer's external id. No lookup table, and nothing to be out of date.
      const accountId = event.data.customer.externalId;
      if (!accountId) return;

      // Re-read rather than trusting the event's snapshot: by the time this
      // arrives the subscription may already have moved on, and events can
      // overtake each other.
      const fresh = await polar().subscriptions.get({ id: event.data.id });
      await syncSubscription(accountId, fresh);
      return;
    }

    default:
      // Everything else is noise for this service. Acknowledged so Polar stops
      // retrying it, and deliberately not logged as a problem.
      return;
  }
}
