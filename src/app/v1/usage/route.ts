import { NextResponse } from 'next/server';
import { z } from 'zod';
import { recordUsage } from '@/lib/db.ts';
import { accountForRefreshToken } from '@/lib/tokens.ts';
import { bearer, fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

const body = z.object({
  week: z.string().regex(/^\d{4}-W\d{2}$/),
  mcpCalls: z.number().int().min(0),
});

/**
 * The week's running total, reported when the app next talks to us.
 *
 * A total rather than a delta, so a lost request costs nothing and a replayed
 * one is harmless — the larger number wins. Counting happens on the machine,
 * because that is where the calls are; a local-first app should not send an
 * event per keystroke.
 *
 * Recorded for Pro accounts too, even though Pro has no limit. A counter that
 * stops when somebody pays is a counter nobody trusts, and it is the number
 * support and capacity planning both want.
 */
export async function POST(request: Request) {
  return guarded(async () => {
    const token = bearer(request);
    if (!token) return fail(401, 'no_token', 'a refresh token is required');
    const accountId = await accountForRefreshToken(token);
    if (!accountId) return fail(401, 'unknown_token', 'sign in again');

    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail(400, 'invalid_input', 'week and mcpCalls are required');

    await recordUsage(accountId, parsed.data.week, parsed.data.mcpCalls);
    return NextResponse.json({ recorded: true });
  });
}
