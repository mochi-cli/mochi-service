import { NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { env } from '@/lib/env.ts';
import { claimEvent, sql } from '@/lib/db.ts';
import { stripe, syncSubscription } from '@/lib/billing.ts';
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
 * 2. **Be idempotent.** Stripe retries, so the same event arrives more than
 *    once, and a duplicate must not upgrade or charge twice.
 * 3. **Reconcile, do not apply diffs.** `customer.subscription.updated` can
 *    arrive before `checkout.session.completed`. Reading the current state
 *    from Stripe and writing that makes order stop mattering; applying the
 *    event's delta makes it matter enormously.
 */
export async function POST(request: Request) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) return fail(400, 'unsigned', 'no Stripe signature on this request');

  // The raw bytes, before anything parses them.
  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
  } catch (error) {
    console.error('[service] webhook signature rejected', error);
    return fail(400, 'bad_signature', 'that signature does not check out');
  }

  // Stripe treats any 2xx as "delivered", so from here on a failure has to be
  // a non-2xx or the event is lost. It retries for days; reconcile-on-read
  // catches whatever slips through even then.
  try {
    if (!(await claimEvent(event.id))) {
      return NextResponse.json({ received: true, duplicate: true });
    }
    await handle(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error('[service] webhook handling failed', event.type, error);
    return fail(500, 'handler_failed', 'could not handle that event — please retry');
  }
}

async function handle(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const accountId = session.client_reference_id;
      if (!accountId || typeof session.subscription !== 'string') return;
      // Re-read rather than trusting the event's snapshot: by the time this
      // arrives the subscription may already have moved on.
      const subscription = await stripe().subscriptions.retrieve(session.subscription);
      await syncSubscription(accountId, subscription);
      if (typeof session.customer === 'string') {
        await sql()`UPDATE accounts SET stripe_customer = ${session.customer} WHERE id = ${accountId}`;
      }
      return;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const customer =
        typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
      const rows = await sql()`SELECT id FROM accounts WHERE stripe_customer = ${customer}`;
      const accountId = rows[0]?.id as string | undefined;
      // A subscription for a customer we have never seen is not ours to act on.
      if (!accountId) return;
      await syncSubscription(accountId, subscription);
      return;
    }

    default:
      // Everything else is noise for this service. Acknowledged so Stripe stops
      // retrying it, and deliberately not logged as a problem.
      return;
  }
}
