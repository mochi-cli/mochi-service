import { NextResponse } from 'next/server';
import { z } from 'zod';
import { saveFeedback } from '@/lib/db.ts';
import { accountForRefreshToken } from '@/lib/tokens.ts';
import { currentSubscription, planFor } from '@/lib/billing.ts';
import { bearer, fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

/**
 * What a paying customer wanted to say.
 *
 * The only endpoint here that takes free text a person wrote, which is why the
 * schema is narrow on purpose: a message, and two facts about the build that
 * sent it. Nothing about their tables. "This is broken" is unanswerable
 * without knowing which version said it, and answerable with nothing more.
 *
 * Pro only, and the check is here rather than in the app. Hiding a button is a
 * courtesy; a plan gate that lives in a page is a plan gate anybody can edit in
 * devtools (TC-180).
 *
 * The plan is stored alongside the message rather than joined to later: a
 * complaint from somebody who has since cancelled still came from a Pro
 * customer, and reading the live subscription six months from now would
 * quietly rewrite that.
 */
const body = z.object({
  message: z.string().trim().min(1).max(4000),
  /** Which build is complaining. */
  appVersion: z.string().max(40).nullish(),
  platform: z.string().max(60).nullish(),
});

export async function POST(request: Request) {
  return guarded(async () => {
    const token = bearer(request);
    if (!token) return fail(401, 'no_token', 'a refresh token is required');
    const accountId = await accountForRefreshToken(token);
    if (!accountId) return fail(401, 'unknown_token', 'sign in again');

    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return fail(400, 'invalid_input', 'a message of up to 4000 characters is required');
    }

    const { plan } = planFor(await currentSubscription(accountId));
    if (plan !== 'pro') {
      return fail(403, 'pro_only', 'feedback from inside the app is part of Mochi Pro');
    }

    const stored = await saveFeedback({
      accountId,
      plan,
      appVersion: parsed.data.appVersion ?? null,
      platform: parsed.data.platform ?? null,
      message: parsed.data.message,
    });

    // Refused for being too soon, not for being wrong. Said as a sentence,
    // because a 429 in a text box reads as "your message was lost".
    if (!stored) {
      return fail(429, 'too_soon', 'that just went through — give it a minute before the next one');
    }

    return NextResponse.json({ received: true });
  });
}
