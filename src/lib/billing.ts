import { Polar } from '@polar-sh/sdk';
import type { Subscription as PolarSubscription } from '@polar-sh/sdk/models/components/subscription.js';
import { env } from './env.ts';
import { isActive, saveSubscription, subscriptionFor, type Account, type Subscription } from './db.ts';

/**
 * Polar, and the rule that Polar is the source of truth.
 *
 * Polar is a merchant of record, which is the whole reason it is here rather
 * than a payment processor: Polar is the seller, so Polar owes the VAT in every
 * country somebody buys from. A processor would leave that with us, and digital
 * goods sold to consumers in the EU have no small-seller threshold to hide
 * under — the obligation starts at the first euro.
 *
 * Nothing here ever sees a card. Checkout and the customer portal are Polar's
 * own pages; this service holds a subscription id and a status, which is
 * everything it needs and nothing that would matter if it leaked.
 */

export function polar(): Polar {
  return new Polar({ accessToken: env.polar.accessToken, server: env.polar.server });
}

/** How stale a cached subscription may be before a read re-checks Polar. */
const RECONCILE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Our account id, handed to Polar as the customer's `externalCustomerId`.
 *
 * This is worth more than it looks. Polar will create the customer on first
 * checkout and key it by this, so there is no create-customer round trip, no
 * customer id to store, and no column to fall out of sync — and a webhook
 * arriving for a customer we have never heard of carries the account id in
 * itself rather than needing a lookup table to decode.
 */
function externalId(account: Account): string {
  return account.id;
}

export async function checkoutUrl(account: Account, cadence: 'monthly' | 'yearly'): Promise<string> {
  const checkout = await polar().checkouts.create({
    products: [cadence === 'yearly' ? env.polar.productYearly : env.polar.productMonthly],
    externalCustomerId: externalId(account),
    customerEmail: account.email,
    // Polar collects the card on its own page, under its own domain. This
    // service never receives a number, and could not store one if it tried.
    successUrl: `${env.origin}/billing/done`,
  });
  return checkout.url;
}

export async function portalUrl(account: Account): Promise<string> {
  const session = await polar().customerSessions.create({
    externalCustomerId: externalId(account),
    returnUrl: `${env.origin}/billing/done`,
  });
  // The token is inside this URL and is what authenticates the portal, so it is
  // single-use-ish and short-lived by design. Never log it.
  return session.customerPortalUrl;
}

/** Writes what Polar currently says about one subscription. */
export async function syncSubscription(
  accountId: string,
  subscription: PolarSubscription
): Promise<void> {
  await saveSubscription({
    accountId,
    polarId: subscription.id,
    status: subscription.status,
    // `seats` is null on everything that is not a seat-based plan, which is
    // every plan Mochi sells today. One machine, one seat.
    seats: subscription.seats ?? 1,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
  });
}

/**
 * The subscription, re-read from Polar if what we have is stale.
 *
 * This is the entire safety net for a webhook that never arrived, and it
 * replaces the nightly sweep an earlier design had. It does work proportional
 * to use rather than to the size of the customer table, it corrects the record
 * at the one moment the answer is used — just before a claim is signed — and
 * it is not a scheduled job that can quietly stop running while everyone goes
 * on believing there is a safety net.
 *
 * A failure to reach Polar is not fatal: the cached row is served instead.
 * Being a day out of date is much better than refusing to answer.
 */
export async function currentSubscription(accountId: string): Promise<Subscription | null> {
  const cached = await subscriptionFor(accountId);
  if (!cached) return null;

  const age = Date.now() - Date.parse(cached.syncedAt);
  if (Number.isFinite(age) && age < RECONCILE_AFTER_MS) return cached;

  try {
    const fresh = await polar().subscriptions.get({ id: cached.polarId });
    await syncSubscription(accountId, fresh);
    return await subscriptionFor(accountId);
  } catch (error) {
    console.error('[service] could not reconcile subscription', cached.polarId, error);
    return cached;
  }
}

/** What the claim should say, from whatever Polar last told us. */
export function planFor(subscription: Subscription | null): { plan: 'free' | 'pro'; seats: number } {
  if (subscription && isActive(subscription.status)) {
    return { plan: 'pro', seats: subscription.seats };
  }
  return { plan: 'free', seats: 1 };
}
