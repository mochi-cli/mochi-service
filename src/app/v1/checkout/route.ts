import { NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db.ts';
import { accountForRefreshToken } from '@/lib/tokens.ts';
import { checkoutUrl } from '@/lib/billing.ts';
import { bearer, fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

const body = z.object({ cadence: z.enum(['monthly', 'yearly']).default('monthly') });

/**
 * A Polar Checkout URL for the app to open in a browser.
 *
 * The card is entered on Polar's page, under Polar's domain. Nothing in this
 * service ever receives a card number, and there is no column here that could
 * hold one.
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

    const parsed = body.safeParse(await request.json().catch(() => ({})));
    const cadence = parsed.success ? parsed.data.cadence : 'monthly';

    const url = await checkoutUrl({ id: row.id as string, email: row.email as string }, cadence);
    return NextResponse.json({ url });
  });
}
