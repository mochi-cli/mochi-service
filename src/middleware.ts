import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Answers the one wrong request everybody makes.
 *
 * A webhook endpoint registered as the bare origin — no path — POSTs to `/`,
 * which is a page, so Next answers 405 Method Not Allowed. From the sending
 * side that looks like the service rejecting the delivery rather than never
 * having been asked, and there is nothing in the message to suggest a missing
 * path. It cost four silent delivery failures and a subscription that was paid
 * for and never recorded before anybody looked at the log.
 *
 * So a POST to the root says where webhooks actually go. It is three lines and
 * it turns a dead end into a signpost.
 */
export function middleware(request: NextRequest) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return NextResponse.json(
      {
        error: {
          code: 'wrong_path',
          message:
            'nothing here accepts a POST. Webhooks go to /webhooks/polar — ' +
            'a webhook registered as the bare origin lands here instead.',
        },
      },
      { status: 404 }
    );
  }
  return NextResponse.next();
}

// The root only. Every other path has its own handler and must not be touched.
export const config = { matcher: '/' };
