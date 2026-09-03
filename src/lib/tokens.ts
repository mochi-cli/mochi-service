import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from './db.ts';

/**
 * The refresh token a machine keeps so it can ask for a fresh claim.
 *
 * Only a hash is stored. The raw value is shown once, at sign-in, and never
 * needed again — so a leaked database hands somebody a list of hashes rather
 * than a list of working tokens.
 *
 * Deliberately not a Google token. This opens exactly one thing: the plan on
 * one account. Somebody who takes it off a laptop learns that that person has
 * Pro, which is roughly what it is worth.
 */

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function issueRefreshToken(accountId: string): Promise<string> {
  const token = `mrt_${randomBytes(32).toString('base64url')}`;
  await sql()`
    INSERT INTO refresh_tokens (token_sha256, account_id) VALUES (${hash(token)}, ${accountId})
  `;
  return token;
}

export async function accountForRefreshToken(token: string): Promise<string | null> {
  const rows = await sql()`
    UPDATE refresh_tokens SET last_used_at = now()
     WHERE token_sha256 = ${hash(token)}
     RETURNING account_id
  `;
  return (rows[0]?.account_id as string | undefined) ?? null;
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await sql()`DELETE FROM refresh_tokens WHERE token_sha256 = ${hash(token)}`;
}

/** Constant-time, for comparing a PKCE challenge without leaking by timing. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
