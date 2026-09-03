import { NextResponse } from 'next/server';
import { env } from '@/lib/env.ts';
import { sql } from '@/lib/db.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Whether this deployment is actually wired up.
 *
 * Every other route hides its internals behind a generic 500, which is right —
 * a stranger provoking an error should learn nothing. The cost is that the
 * person who deployed it learns nothing either, and "500, go read the logs" is
 * a poor answer when the usual cause is a variable that was set in the
 * dashboard without redeploying.
 *
 * So this reports **presence and reachability, never values**. No connection
 * string, no token, and deliberately no exception messages — a failed Postgres
 * connection likes to quote the URL it tried, credentials included.
 */
export async function GET() {
  // Connecting is not the question — `SELECT 1` passes against an empty
  // database, and an empty database is exactly what you have after setting
  // DATABASE_URL and forgetting to run schema.sql. That combination produces a
  // 500 on the first real request and a health check that says everything is
  // fine, which is worse than no health check.
  const EXPECTED = [
    'accounts',
    'subscriptions',
    'sign_in_codes',
    'refresh_tokens',
    'usage',
    'handled_events',
  ];

  let database = false;
  let missingTables: string[] = EXPECTED;
  try {
    const rows = await sql()`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    database = true;
    const present = new Set(rows.map((row) => row.table_name as string));
    missingTables = EXPECTED.filter((name) => !present.has(name));
  } catch {
    // Deliberately swallowed: see above. The boolean is the whole answer.
  }

  // Reading through `env` because that is what the routes do — a variable set
  // to whitespace is missing here for the same reason it is missing there.
  const has = (read: () => unknown): boolean => {
    try {
      return Boolean(read());
    } catch {
      return false;
    }
  };

  const signing = has(() => env.signing.kmsKey)
    ? 'kms'
    : has(() => env.signing.localKey)
      ? 'local'
      : 'none';

  const checks = {
    database,
    /** Empty when schema.sql has been applied. Anything here is a 500 waiting. */
    missingTables,
    origin: has(() => env.origin),
    google: has(() => env.google.clientId) && has(() => env.google.clientSecret),
    polar:
      has(() => env.polar.accessToken) &&
      has(() => env.polar.productMonthly) &&
      has(() => env.polar.productYearly),
    polarWebhook: has(() => env.polar.webhookSecret),
    polarServer: has(() => env.polar.server) ? env.polar.server : null,
    signing,
    // On Vercel there is no metadata server, so KMS without this cannot sign.
    kmsCredentials: signing !== 'kms' || has(() => env.signing.serviceAccount),
    claimLifetimeDays: has(() => env.claimLifetimeDays) ? env.claimLifetimeDays : null,
  };

  // The webhook is allowed to be unconfigured — reconcile-on-read covers it —
  // so it is reported but does not make the deployment unhealthy.
  const ready =
    checks.database &&
    checks.missingTables.length === 0 &&
    checks.origin &&
    checks.google &&
    checks.polar &&
    checks.signing !== 'none' &&
    checks.kmsCredentials;

  return NextResponse.json({ ready, checks }, { status: ready ? 200 : 503 });
}
