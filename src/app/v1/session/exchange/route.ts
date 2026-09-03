import { NextResponse } from 'next/server';
import { z } from 'zod';
import { challengeFor, consumeSession, readSession } from '@/lib/codes.ts';
import { upsertAccount } from '@/lib/db.ts';
import { currentSubscription, planFor } from '@/lib/billing.ts';
import { buildClaim, signClaim } from '@/lib/claim.ts';
import { issueRefreshToken } from '@/lib/tokens.ts';
import { fail, guarded } from '@/lib/http.ts';
import { sameSecret } from '@/lib/tokens.ts';

export const runtime = 'nodejs';

const body = z.object({
  code: z.string().min(1),
  /** Proof the caller is the app that started this, not whoever read the code. */
  verifier: z.string().min(43).max(128),
});

/**
 * Polled while the browser is away. `202` until Google has answered, then the
 * signed claim and a refresh token.
 *
 * The verifier is the point. A bare code lands in browser history, in proxy
 * logs and in screenshots of an address bar; requiring proof that the caller
 * generated it means holding the code is not enough to take somebody's account.
 */
export async function POST(request: Request) {
  return guarded(async () => {
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail(400, 'invalid_input', 'code and verifier are required');
    const { code, verifier } = parsed.data;

    // Peeked at first: a wrong verifier must not burn the code, or a bug in one
    // client would lock somebody out of a sign-in they are in the middle of.
    const pending = await readSession(code);
    if (!pending) return fail(404, 'unknown_code', 'that sign-in has expired — start again');
    if (!sameSecret(pending.challenge, challengeFor(verifier))) {
      return fail(403, 'bad_verifier', 'this code was not started by this client');
    }
    if (!pending.email) {
      return NextResponse.json({ status: 'waiting' }, { status: 202 });
    }

    // Only now, with the caller proved and Google finished, is it spent.
    const consumed = await consumeSession(code);
    if (!consumed?.email) return fail(404, 'unknown_code', 'that sign-in has expired — start again');

    const account = await upsertAccount(consumed.email);
    const subscription = await currentSubscription(account.id);
    const { plan, seats } = planFor(subscription);

    return NextResponse.json({
      ...(await signClaim(buildClaim({ plan, email: account.email, seats }))),
      refreshToken: await issueRefreshToken(account.id),
    });
  });
}
