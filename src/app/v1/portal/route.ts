import { NextResponse } from 'next/server';
import { sql, subscriptionFor } from '@/lib/db.ts';
import { accountForRefreshToken } from '@/lib/tokens.ts';
import { portalUrl } from '@/lib/billing.ts';
import { bearer, fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

/**
 * Polar's customer portal: change card, change plan, cancel, download invoices.
 *
 * Everything billing-shaped that is not "start a subscription" lives there
 * rather than being rebuilt here — it is already correct, already localised,
 * and already handles the tax and invoice cases nobody wants to reimplement.
 * Being a merchant of record, Polar's invoices are also the ones that are
 * legally the seller's, which is not a document this service should be forging.
 */
export async function POST(request: Request) {
  return guarded(async () => {
    const token = bearer(request);
    if (!token) return fail(401, 'no_token', 'sign in first');
    const accountId = await accountForRefreshToken(token);
    if (!accountId) return fail(401, 'unknown_token', 'sign in again');

    const rows = await sql()`SELECT id, email FROM accounts WHERE id = ${accountId}`;
    const row = rows[0];
    if (!row) return fail(401, 'unknown_token', 'sign in again');

    // Polar only knows this customer once checkout has been through. Asking for
    // a session before then is a 404 from Polar dressed up as a 500 from us, so
    // answer it here instead.
    if (!(await subscriptionFor(accountId))) {
      return fail(409, 'no_subscription', 'there is nothing to manage on the free plan');
    }

    const url = await portalUrl({ id: row.id as string, email: row.email as string });
    return NextResponse.json({ url });
  });
}
