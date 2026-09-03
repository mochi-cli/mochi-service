import { createHash, randomBytes } from 'node:crypto';
import { Redis } from '@upstash/redis';
import { env } from './env.ts';

/**
 * The short-lived sign-in code, and the PKCE challenge that makes it safe to
 * lose.
 *
 * Redis rather than Postgres for one reason: these must disappear on their own.
 * Native TTL is exactly that; a table would need a sweeper, and a sweeper that
 * stops running leaves single-use codes lying around indefinitely.
 */

const TTL_SECONDS = 10 * 60;

function redis(): Redis {
  const { url, token } = env.redis;
  return new Redis({ url, token });
}

export interface PendingSession {
  /** base64url(sha256(verifier)) — the app keeps the verifier in memory. */
  challenge: string;
  /** Set once the browser has finished with Google. */
  email?: string;
}

export function newCode(): string {
  return randomBytes(32).toString('base64url');
}

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export async function startSession(code: string, challenge: string): Promise<void> {
  await redis().set(`session:${code}`, { challenge } satisfies PendingSession, { ex: TTL_SECONDS });
}

export async function readSession(code: string): Promise<PendingSession | null> {
  return (await redis().get<PendingSession>(`session:${code}`)) ?? null;
}

/** Called by the OAuth callback once Google has said who this is. */
export async function completeSession(code: string, email: string): Promise<boolean> {
  const client = redis();
  const pending = await client.get<PendingSession>(`session:${code}`);
  if (!pending) return false;
  await client.set(`session:${code}`, { ...pending, email }, { ex: TTL_SECONDS });
  return true;
}

/**
 * Single use. Deleting before the caller does anything with it means a race
 * between two exchanges cannot hand the same code to both.
 */
export async function consumeSession(code: string): Promise<PendingSession | null> {
  const client = redis();
  const pending = await client.get<PendingSession>(`session:${code}`);
  if (!pending) return null;
  await client.del(`session:${code}`);
  return pending;
}
