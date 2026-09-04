import { NextResponse } from 'next/server';
import { env } from '@/lib/env.ts';
import { claimEvent } from '@/lib/db.ts';
import { polar, syncSubscription } from '@/lib/billing.ts';
import { receiveWebhook, SUBSCRIPTION_EVENTS } from '@/lib/webhook.ts';

export const runtime = 'nodejs';

/**
 * The one endpoint strangers can reach that changes billing state.
 *
 * The rules it enforces — verify against the raw body, be idempotent by
 * `webhook-id`, and reconcile rather than apply diffs — live in
 * `lib/webhook.ts` where they can be tested. This file is the wiring: raw
 * bytes in, real database and real Polar client attached, HTTP out.
 */
export async function POST(request: Request) {
  // `request.text()`, never `request.json()`: the signature covers the exact
  // bytes and parsing has already destroyed them.
  const payload = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });

  const outcome = await receiveWebhook(payload, headers, {
    secret: env.polar.webhookSecret,
    claim: claimEvent,
    handle,
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}

/**
 * Typed loosely on purpose.
 *
 * The SDK's union covers thirty-odd payload shapes, and narrowing it here
 * would mean this file stops compiling every time Polar adds an event — for a
 * function whose first line is "is this one of ours". The two fields actually
 * read are asserted below, where they are read.
 */
async function handle(event: { type: string; data: unknown }): Promise<void> {
  // Everything outside the set is acknowledged and ignored — deliberately not
  // logged as a problem, because most of what Polar sends is not ours.
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return;

  // The account id travels inside the event, because checkout set it as the
  // customer's external id. No lookup table, and nothing to be out of date.
  const data = event.data as { id: string; customer?: { externalId?: string | null } };
  const accountId = data.customer?.externalId;
  if (!accountId) return;

  // Re-read rather than trusting the event's snapshot: `subscription.updated`
  // can arrive before `subscription.created`, and by the time this runs the
  // subscription may have moved on again. Reading the current state makes
  // order stop mattering; applying the event's delta makes it matter
  // enormously.
  const fresh = await polar().subscriptions.get({ id: data.id });
  await syncSubscription(accountId, fresh);
}
