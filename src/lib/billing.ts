import Stripe from 'stripe';
import { env } from './env.ts';
import {
  isActive,
  saveSubscription,
  setStripeCustomer,
  subscriptionFor,
  type Account,
  type Subscription,
} from './db.ts';

/**
 * Stripe, and the rule that Stripe is the source of truth.
 *
 * Nothing here ever sees a card. Checkout and the billing portal are Stripe's
 * own pages; this service holds a customer id and a subscription status, which
 * is everything it needs and nothing that would matter if it leaked.
 */

export function stripe(): Stripe {
  // No apiVersion pin: the installed SDK pins its own, and a hand-written
  // literal here only ever drifts out of step with the types after an upgrade.
  return new Stripe(env.stripe.secretKey);
}

/** How stale a cached subscription may be before a read re-checks Stripe. */
const RECONCILE_AFTER_MS = 24 * 60 * 60 * 1000;

async function customerFor(account: Account): Promise<string> {
  if (account.stripeCustomer) return account.stripeCustomer;
  const created = await stripe().customers.create({
    email: account.email,
    metadata: { accountId: account.id },
  });
  await setStripeCustomer(account.id, created.id);
  return created.id;
}

export async function checkoutUrl(account: Account, cadence: 'monthly' | 'yearly'): Promise<string> {
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    customer: await customerFor(account),
    line_items: [
      {
        price: cadence === 'yearly' ? env.stripe.priceYearly : env.stripe.priceMonthly,
        quantity: 1,
      },
    ],
    // Stripe collects the card on its own page, under its own domain. This
    // service never receives a number, and could not store one if it tried.
    success_url: `${env.origin}/billing/done`,
    cancel_url: `${env.origin}/billing/cancelled`,
    client_reference_id: account.id,
  });
  if (!session.url) throw new Error('Stripe returned a session with no URL');
  return session.url;
}

export async function portalUrl(account: Account): Promise<string> {
  const session = await stripe().billingPortal.sessions.create({
    customer: await customerFor(account),
    return_url: `${env.origin}/billing/done`,
  });
  return session.url;
}

/** Writes what Stripe currently says about one subscription. */
export async function syncSubscription(
  accountId: string,
  subscription: Stripe.Subscription
): Promise<void> {
  await saveSubscription({
    accountId,
    stripeId: subscription.id,
    status: subscription.status,
    seats: subscription.items.data[0]?.quantity ?? 1,
    currentPeriodEnd: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
  });
}

/**
 * The subscription, re-read from Stripe if what we have is stale.
 *
 * This is the entire safety net for a webhook that never arrived, and it
 * replaces the nightly sweep an earlier design had. It does work proportional
 * to use rather than to the size of the customer table, it corrects the record
 * at the one moment the answer is used — just before a claim is signed — and
 * it is not a scheduled job that can quietly stop running while everyone goes
 * on believing there is a safety net.
 *
 * A failure to reach Stripe is not fatal: the cached row is served instead.
 * Being a day out of date is much better than refusing to answer.
 */
export async function currentSubscription(accountId: string): Promise<Subscription | null> {
  const cached = await subscriptionFor(accountId);
  if (!cached) return null;

  const age = Date.now() - Date.parse(cached.syncedAt);
  if (Number.isFinite(age) && age < RECONCILE_AFTER_MS) return cached;

  try {
    const fresh = await stripe().subscriptions.retrieve(cached.stripeId);
    await syncSubscription(accountId, fresh);
    return await subscriptionFor(accountId);
  } catch (error) {
    console.error('[service] could not reconcile subscription', cached.stripeId, error);
    return cached;
  }
}

/** What the claim should say, from whatever Stripe last told us. */
export function planFor(subscription: Subscription | null): { plan: 'free' | 'pro'; seats: number } {
  if (subscription && isActive(subscription.status)) {
    return { plan: 'pro', seats: subscription.seats };
  }
  return { plan: 'free', seats: 1 };
}
