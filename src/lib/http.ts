import { NextResponse } from 'next/server';

/**
 * The error shape Mochi Table already knows how to read, so a failure here
 * arrives in the app as a sentence rather than as "unknown error".
 */
export function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/** Bearer token off the Authorization header, or null. */
export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? null;
}

/**
 * Wraps a handler so an unexpected throw is a 500 with a code, not a stack
 * trace. The message is logged rather than returned: internal paths and SQL
 * fragments are not the caller's business.
 */
export async function guarded(run: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await run();
  } catch (error) {
    console.error('[service]', error);
    return fail(500, 'internal', 'something went wrong here — it has been logged');
  }
}
