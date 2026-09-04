import { NextResponse } from 'next/server';
import { accountForRefreshToken } from '@/lib/tokens.ts';
import { cancelSubscription, planFor } from '@/lib/billing.ts';
import { buildClaim, signClaim } from '@/lib/claim.ts';
import { sql } from '@/lib/db.ts';
import { bearer, fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

/**
 * Cancels at the end of the paid period.
 *
 * Answers with a fresh claim rather than an acknowledgement, so the app can
 * show the new state without a second round trip — and so the thing it shows
 * is signed rather than asserted by a response body it could not verify.
 */
export async function POST(request: Request) {
  return guarded(async () => {
    const token = bearer(request);
    if (!token) return fail(401, 'no_token', 'sign in first');
    const accountId = await accountForRefreshToken(token);
    if (!accountId) return fail(401, 'unknown_token', 'sign in again');

    const subscription = await cancelSubscription(accountId);
    if (!subscription) return fail(404, 'no_subscription', 'there is nothing to cancel');

    const rows = await sql()`SELECT email FROM accounts WHERE id = ${accountId}`;
    const email = (rows[0]?.email as string | undefined) ?? null;
    const { plan, seats } = planFor(subscription);

    return NextResponse.json({
      ...(await signClaim(buildClaim({ plan, email, seats }))),
      // Until when Pro actually lasts. The app says this back to the person,
      // and a date they can read is the difference between "cancelled" and
      // "cancelled, and you keep it until the 14th".
      currentPeriodEnd: subscription.currentPeriodEnd,
      status: subscription.status,
    });
  });
}
