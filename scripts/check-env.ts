import { env } from '../src/lib/env.ts';

/**
 * Says what is still missing, all at once.
 *
 * `env` throws on the first absent variable, which is right for a running
 * service and useless for setting one up: you fix one, redeploy, and find the
 * next. Worse, a missing variable on Vercel surfaces as a 500 on somebody's
 * checkout rather than at deploy time. So this touches every accessor and
 * collects the complaints instead of stopping at the first.
 */

const checks: Array<[string, () => unknown]> = [
  ['SERVICE_ORIGIN', () => env.origin],
  ['DATABASE_URL', () => env.databaseUrl],
  ['GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET', () => env.google],
  ['POLAR_* (token, webhook secret, two products, server)', () => env.polar],
  ['CLAIM_KID', () => env.signing.kid],
  ['CLAIM_LIFETIME_DAYS', () => env.claimLifetimeDays],
];

/**
 * Placeholders pass a presence check and fail at runtime, which is the worst
 * of both. `.env.local` starts life as a copy of `.env.example`, so half of
 * these are `replace_me` until somebody replaces them — and "ok" against a
 * placeholder is a lie that costs a deploy to discover.
 */
const PLACEHOLDER = /replace[-_]me|^00000000-0000-0000-0000-000000000000$|example\.(com|test|upstash\.io)|user:password@host/i;

function placeholders(): string[] {
  const named = [
    'SERVICE_ORIGIN', 'DATABASE_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET',
    'POLAR_ACCESS_TOKEN', 'POLAR_WEBHOOK_SECRET', 'POLAR_PRODUCT_MONTHLY',
    'POLAR_PRODUCT_YEARLY', 'CLAIM_KMS_KEY', 'GOOGLE_SERVICE_ACCOUNT_JSON',
  ];
  return named.filter((name) => {
    const value = process.env[name]?.trim();
    return Boolean(value) && PLACEHOLDER.test(value!);
  });
}

let missing = 0;
for (const [name, read] of checks) {
  try {
    read();
    console.log(`  ok      ${name}`);
  } catch (error) {
    missing += 1;
    console.log(`  MISSING ${name}\n          ${(error as Error).message}`);
  }
}

// Signing is the one with two valid shapes, so it cannot be a plain presence
// check: exactly one of the two must be set, and which one depends on where
// this is running.
// Guarded, because reading `env.signing` demands CLAIM_KID — and a script whose
// job is listing what is missing must not die on the first missing thing.
let signing: Partial<typeof env.signing> = {};
try {
  signing = env.signing;
} catch {
  // Already reported above as a missing CLAIM_KID; nothing to add here.
}
const { kmsKey, localKey, serviceAccount } = signing;
if (kmsKey) {
  console.log('  ok      CLAIM_KMS_KEY — signing through Cloud KMS');
  if (!serviceAccount) {
    console.log(
      '  WARN    GOOGLE_SERVICE_ACCOUNT_JSON is unset. Fine on Google infrastructure,\n' +
        '          where credentials come from the metadata server. On Vercel the first\n' +
        '          signature will fail with "Could not load the default credentials".'
    );
  }
  if (localKey) {
    console.log('  WARN    CLAIM_SIGNING_KEY is also set and will be ignored. Remove it.');
  }
} else if (localKey) {
  console.log('  ok      CLAIM_SIGNING_KEY — signing locally (refused in production)');
} else {
  missing += 1;
  console.log('  MISSING a signing key — set CLAIM_KMS_KEY, or CLAIM_SIGNING_KEY for development');
}

const stubs = placeholders();
for (const name of stubs) {
  console.log(`  STUB    ${name} still holds the value from .env.example`);
}

const outstanding = missing + stubs.length;
console.log(
  outstanding === 0
    ? '\nNothing outstanding. `npm run check:key` proves the key itself is wired to the app.'
    : `\n${outstanding} still to set — see .env.example.`
);
process.exitCode = outstanding === 0 ? 0 : 1;
