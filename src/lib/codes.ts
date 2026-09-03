import { createHash, randomBytes } from 'node:crypto';
import { sql } from './db.ts';

/**
 * The short-lived sign-in code, and the PKCE challenge that makes it safe to
 * lose.
 *
 * These live in Postgres, in the database this service already has. An earlier
 * version kept them in Redis for its TTL, on the reasoning that a table would
 * need a sweeper and a sweeper that stops running leaves single-use codes lying
 * around. That reasoning does not survive contact: expiry is enforced by
 * `expires_at > now()` in every read, so a row that outlives its ten minutes is
 * already unusable and deleting it is housekeeping, not correctness. One
 * `DELETE` riding along with each insert is the whole sweeper.
 *
 * Moving them here also fixed a real bug — see `consumeSession`.
 *
 * The code is stored as a hash, like the refresh tokens, so a leaked database
 * hands somebody a list of hashes rather than a list of live sign-ins. The
 * challenge is stored in the clear because it is public by construction: it is
 * a hash of a verifier that never left the app.
 */

const TTL_SECONDS = 10 * 60;

function hash(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export interface PendingSession {
  /** base64url(sha256(verifier)) — the app keeps the verifier in memory. */
  challenge: string;
  /**
   * Set once the browser has finished with Google. Explicitly `| undefined`
   * because this tsconfig runs `exactOptionalPropertyTypes`, and a row that has
   * not been through the callback yet genuinely carries the value `undefined`
   * rather than being absent.
   */
  email?: string | undefined;
}

export function newCode(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function startSession(code: string, challenge: string): Promise<void> {
  await sql()`
    INSERT INTO sign_in_codes (code_sha256, challenge, expires_at)
    VALUES (${hash(code)}, ${challenge}, now() + make_interval(secs => ${TTL_SECONDS}))
  `;
  // Housekeeping, not correctness: every read already filters on expiry. Riding
  // along with the insert means the table stays small without a scheduled job
  // that can quietly stop running.
  await sql()`DELETE FROM sign_in_codes WHERE expires_at < now()`;
}

export async function readSession(code: string): Promise<PendingSession | null> {
  const rows = await sql()`
    SELECT challenge, email FROM sign_in_codes
     WHERE code_sha256 = ${hash(code)} AND expires_at > now()
  `;
  const row = rows[0];
  return row
    ? { challenge: row.challenge as string, email: (row.email as string | null) ?? undefined }
    : null;
}

/** Called by the OAuth callback once Google has said who this is. */
export async function completeSession(code: string, email: string): Promise<boolean> {
  const rows = await sql()`
    UPDATE sign_in_codes SET email = ${email}
     WHERE code_sha256 = ${hash(code)} AND expires_at > now()
     RETURNING code_sha256
  `;
  return rows.length > 0;
}

/**
 * Single use, and single use is the point.
 *
 * This is one statement. The Redis version it replaces was a `get` followed by
 * a `del`, which is two, and two round trips are two chances for a second
 * exchange to slip between them — both callers reading the same pending session
 * and both being issued a refresh token for the account. The old comment
 * claimed that could not happen. It could.
 *
 * `DELETE ... RETURNING` decides the winner in the database: exactly one caller
 * gets a row back, everybody else gets nothing.
 */
export async function consumeSession(code: string): Promise<PendingSession | null> {
  const rows = await sql()`
    DELETE FROM sign_in_codes
     WHERE code_sha256 = ${hash(code)} AND expires_at > now()
     RETURNING challenge, email
  `;
  const row = rows[0];
  return row
    ? { challenge: row.challenge as string, email: (row.email as string | null) ?? undefined }
    : null;
}
