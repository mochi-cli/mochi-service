import { NextResponse } from 'next/server';
import { sql } from '@/lib/db.ts';
import { accountForRefreshToken, revokeRefreshToken } from '@/lib/tokens.ts';
import { currentSubscription, planFor } from '@/lib/billing.ts';
import { buildClaim, signClaim } from '@/lib/claim.ts';
import { bearer, fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

/**
 * A fresh claim for a machine that already signed in.
 *
 * Called about once a day. Not once an hour: the claim is valid for days by
 * design, so a faster poll buys nothing and multiplies the invocation count by
 * however much faster it is.
 *
 * This is also where reconciliation happens — `currentSubscription` re-reads
 * Polar when the cached row is stale. There is no nightly job; see the README.
 */
export async function GET(request: Request) {
  return guarded(async () => {
    const token = bearer(request);
    if (!token) return fail(401, 'no_token', 'a refresh token is required');

    const accountId = await accountForRefreshToken(token);
    if (!accountId) return fail(401, 'unknown_token', 'sign in again');

    const rows = await sql()`SELECT email FROM accounts WHERE id = ${accountId}`;
    const email = (rows[0]?.email as string | undefined) ?? null;

    const subscription = await currentSubscription(accountId);
    const { plan, seats } = planFor(subscription);
    return NextResponse.json(await signClaim(buildClaim({ plan, email, seats })));
  });
}

/** Signing out on one machine. The account and its subscription are untouched. */
export async function DELETE(request: Request) {
  return guarded(async () => {
    const token = bearer(request);
    if (token) await revokeRefreshToken(token);
    // Unconditionally fine: signing out something already signed out is what
    // the caller wanted either way.
    return NextResponse.json({ signedOut: true });
  });
}
