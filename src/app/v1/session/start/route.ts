import { NextResponse } from 'next/server';
import { z } from 'zod';
import { newCode, startSession } from '@/lib/codes.ts';
import { authorizeUrl } from '@/lib/google.ts';
import { fail, guarded } from '@/lib/http.ts';

export const runtime = 'nodejs';

const body = z.object({
  /** base64url(sha256(verifier)). The verifier itself never leaves the app. */
  challenge: z.string().min(43).max(128),
});

/**
 * Begins sign-in. Hands back a URL for the app to open in a browser, and a
 * code to poll with.
 *
 * The code alone proves nothing — see the exchange, which also wants the
 * verifier this challenge was made from.
 */
export async function POST(request: Request) {
  return guarded(async () => {
    const parsed = body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return fail(400, 'invalid_input', 'a PKCE challenge is required');

    const code = newCode();
    await startSession(code, parsed.data.challenge);
    return NextResponse.json({ code, authorizeUrl: authorizeUrl(code) });
  });
}
