import { neon } from '@neondatabase/serverless';
import { env } from './env.ts';

/**
 * Postgres over HTTP, which is what makes it usable from a function that may
 * be cold and will certainly not hold a connection pool between requests.
 *
 * Created per call rather than at module scope: the URL is read through `env`,
 * which throws when it is missing, and doing that at import time would break
 * every route in the build rather than the one request that needed a database.
 */
export function sql() {
  return neon(env.databaseUrl);
}

export interface Account {
  id: string;
  email: string;
}

export interface Subscription {
  accountId: string;
  polarId: string;
  status: string;
  seats: number;
  currentPeriodEnd: string | null;
  syncedAt: string;
}

/** Polar's statuses that mean "this person may use Pro right now". */
export function isActive(status: string): boolean {
  // `past_due` is deliberately included: the card failed, Polar is retrying,
  // and taking the product away mid-retry punishes someone whose bank declined
  // a payment they intend to make. `unpaid` is where that stops.
  //
  // Polar's full set is incomplete, incomplete_expired, trialing, active,
  // past_due, canceled, unpaid, paused. Everything not listed here is Free,
  // including `paused` — a paused subscription is one nobody is paying for.
  return status === 'active' || status === 'trialing' || status === 'past_due';
}

export async function accountByEmail(email: string): Promise<Account | null> {
  const rows = await sql()`SELECT id, email FROM accounts WHERE email = ${email}`;
  const row = rows[0];
  return row ? { id: row.id as string, email: row.email as string } : null;
}

export async function upsertAccount(email: string): Promise<Account> {
  const id = `acc_${crypto.randomUUID().replaceAll('-', '')}`;
  const rows = await sql()`
    INSERT INTO accounts (id, email) VALUES (${id}, ${email})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id, email
  `;
  const row = rows[0]!;
  return { id: row.id as string, email: row.email as string };
}

export async function subscriptionFor(accountId: string): Promise<Subscription | null> {
  const rows = await sql()`
    SELECT account_id, polar_id, status, seats, current_period_end, synced_at
      FROM subscriptions WHERE account_id = ${accountId}
  `;
  const row = rows[0];
  return row
    ? {
        accountId: row.account_id as string,
        polarId: row.polar_id as string,
        status: row.status as string,
        seats: Number(row.seats),
        currentPeriodEnd: row.current_period_end as string | null,
        syncedAt: row.synced_at as string,
      }
    : null;
}

export async function saveSubscription(input: {
  accountId: string;
  polarId: string;
  status: string;
  seats: number;
  currentPeriodEnd: string | null;
}): Promise<void> {
  await sql()`
    INSERT INTO subscriptions (account_id, polar_id, status, seats, current_period_end, synced_at)
    VALUES (${input.accountId}, ${input.polarId}, ${input.status}, ${input.seats},
            ${input.currentPeriodEnd}, now())
    ON CONFLICT (account_id) DO UPDATE SET
      polar_id = EXCLUDED.polar_id,
      status = EXCLUDED.status,
      seats = EXCLUDED.seats,
      current_period_end = EXCLUDED.current_period_end,
      synced_at = now()
  `;
}

/**
 * True the first time an event id is seen, false every time after.
 *
 * The id comes from the `webhook-id` header rather than the body: Polar follows
 * the Standard Webhooks spec, where the body carries only a type and a payload
 * and the delivery's identity lives in the headers.
 */
export async function claimEvent(eventId: string): Promise<boolean> {
  const rows = await sql()`
    INSERT INTO handled_events (event_id) VALUES (${eventId})
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id
  `;
  return rows.length > 0;
}

export async function recordUsage(accountId: string, week: string, calls: number): Promise<void> {
  // GREATEST, not assignment: the app sends a running total, so an out-of-order
  // or replayed request must never move the number backwards.
  await sql()`
    INSERT INTO usage (account_id, week, mcp_calls) VALUES (${accountId}, ${week}, ${calls})
    ON CONFLICT (account_id, week) DO UPDATE SET
      mcp_calls = GREATEST(usage.mcp_calls, EXCLUDED.mcp_calls),
      updated_at = now()
  `;
}

/** How long a Pro account must wait between messages. */
const FEEDBACK_EVERY_MS = 60_000;

/**
 * Stores one piece of feedback, unless the same account just sent one.
 *
 * Rate-limited in the same statement that inserts, rather than by reading
 * first and writing second: two windows open at once would both read "nothing
 * recent" and both write. Returns false when it was too soon, which the route
 * turns into a sentence rather than an error.
 */
export async function saveFeedback(input: {
  accountId: string;
  plan: string;
  appVersion: string | null;
  platform: string | null;
  message: string;
}): Promise<boolean> {
  const id = `fb_${crypto.randomUUID()}`;
  const rows = await sql()`
    INSERT INTO feedback (id, account_id, plan, app_version, platform, message)
    SELECT ${id}, ${input.accountId}, ${input.plan}, ${input.appVersion}, ${input.platform}, ${input.message}
    WHERE NOT EXISTS (
      SELECT 1 FROM feedback
       WHERE account_id = ${input.accountId}
         AND created_at > now() - ${`${FEEDBACK_EVERY_MS} milliseconds`}::interval
    )
    RETURNING id
  `;
  return rows.length > 0;
}
