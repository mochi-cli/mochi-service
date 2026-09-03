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
  /**
   * How many webhook deliveries have ever been handled.
   *
   * Zero is the number worth watching. A webhook endpoint registered without
   * its path, or with the wrong secret, fails on Polar's side and succeeds at
   * looking fine from here — every other check passes, and the only symptom is
   * that subscription changes arrive a day late instead of at once. That
   * happened, and it took reading a delivery log in another product to find.
   *
   * A count is not data. It says the pipe has carried something, which is the
   * one thing nothing else here can tell you.
   */
  let webhooksHandled: number | null = null;
  try {
    const rows = await sql()`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
    `;
    database = true;
    const present = new Set(rows.map((row) => row.table_name as string));
    missingTables = EXPECTED.filter((name) => !present.has(name));
    if (present.has('handled_events')) {
      const counted = await sql()`SELECT count(*)::int AS n FROM handled_events`;
      webhooksHandled = (counted[0]?.n as number | undefined) ?? 0;
    }
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

  /**
   * Exactly which names are absent from this build's environment.
   *
   * The grouped booleans below say *something* is wrong with Google or the
   * origin; they do not say whether a name was misspelled, scoped to Preview
   * only, or set on a different project. Every one of these names is already
   * in the public repository, so listing them costs nothing and ends the
   * guessing.
   */
  const missingEnv = [
    'SERVICE_ORIGIN',
    'DATABASE_URL',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'POLAR_ACCESS_TOKEN',
    'POLAR_PRODUCT_MONTHLY',
    'POLAR_PRODUCT_YEARLY',
    'CLAIM_KID',
  ].filter((name) => !process.env[name]?.trim());

  const checks = {
    missingEnv,
    /**
     * Which build is answering, so "did my redeploy land?" is a question with
     * an answer. Without it, a variable that was set correctly and a variable
     * that was never picked up look identical from outside, and the only way
     * to tell them apart is to guess. The repository is public; the commit is
     * not a secret.
     */
    deployedCommit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    environment: process.env.VERCEL_ENV ?? null,
    database,
    /** Empty when schema.sql has been applied. Anything here is a 500 waiting. */
    missingTables,
    /** Zero means no webhook has ever been delivered successfully. */
    webhooksHandled,
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
