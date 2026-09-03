import { NextResponse } from 'next/server';
import { sql } from '@/lib/db.ts';
import { accountForRefreshToken } from '@/lib/tokens.ts';
import { portalUrl } from '@/lib/billing.ts';
import { bearer, fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

/**
 * Stripe's billing portal: change card, change plan, cancel, download invoices.
 *
 * Everything billing-shaped that is not "start a subscription" lives there
 * rather than being rebuilt here — it is already correct, already localised,
 * and already handles the tax and invoice cases nobody wants to reimplement.
 */
export async function POST(request: Request) {
  return guarded(async () => {
    const token = bearer(request);
    if (!token) return fail(401, 'no_token', 'sign in first');
    const accountId = await accountForRefreshToken(token);
    if (!accountId) return fail(401, 'unknown_token', 'sign in again');

    const rows = await sql()`
      SELECT id, email, stripe_customer FROM accounts WHERE id = ${accountId}
    `;
    const row = rows[0];
    if (!row) return fail(401, 'unknown_token', 'sign in again');
    if (!row.stripe_customer) {
      return fail(409, 'no_subscription', 'there is nothing to manage on the free plan');
    }

    const url = await portalUrl({
      id: row.id as string,
      email: row.email as string,
      stripeCustomer: row.stripe_customer as string,
    });
    return NextResponse.json({ url });
  });
}
