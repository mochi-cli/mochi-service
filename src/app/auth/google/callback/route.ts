import { NextResponse } from 'next/server';
import { completeSession } from '@/lib/codes.ts';
import { emailFromCode } from '@/lib/google.ts';
import { env } from '@/lib/env.ts';

export const runtime = 'nodejs';

/**
 * Where Google sends the browser back to.
 *
 * The only thing this hands the browser afterwards is a page saying it can be
 * closed. No token, no claim, nothing worth stealing lands in a tab — which is
 * what removes the usual web token-theft surface entirely: there is nothing in
 * the page to take.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const googleCode = url.searchParams.get('code');
  const ourCode = url.searchParams.get('state');

  const back = (status: string) =>
    NextResponse.redirect(`${env.origin}/signed-in?status=${status}`);

  if (!googleCode || !ourCode) return back('failed');

  const email = await emailFromCode(googleCode).catch(() => null);
  if (!email) return back('failed');

  // The session may have expired while the person was choosing an account.
  const ok = await completeSession(ourCode, email);
  return back(ok ? 'ok' : 'expired');
}
