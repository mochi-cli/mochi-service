import { env } from './env.ts';

/**
 * Google sign-in, over plain fetch rather than a client library — it is two
 * requests and a redirect, and a dependency for that is a dependency to keep
 * patched.
 *
 * The scope is `openid email` and nothing else, on purpose. It is the whole
 * reason a breach of this service is cheap: with only those, a stolen Google
 * token proves an email address and can do nothing at all with the account it
 * belongs to. Widening the scope makes this service worth attacking for
 * something other than its own data.
 */

const SCOPE = 'openid email';

export function authorizeUrl(code: string): string {
  const params = new URLSearchParams({
    client_id: env.google.clientId,
    redirect_uri: `${env.origin}/auth/google/callback`,
    response_type: 'code',
    scope: SCOPE,
    // Our own sign-in code rides along and comes back untouched, which is how
    // the callback knows which pending session it just completed.
    state: code,
    prompt: 'select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchanges Google's code for an id_token and reads the email out of it.
 *
 * The id_token's signature is not checked, and that is safe *here* specifically:
 * this is a server-to-server call to Google's own token endpoint over TLS, so
 * the token did not pass through the browser and there is no one in between to
 * have forged it. The signature exists for the case where a token arrives from
 * an untrusted hop, which is not this one.
 */
export async function emailFromCode(code: string): Promise<string | null> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      redirect_uri: `${env.origin}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!response.ok) return null;

  const body = (await response.json()) as { id_token?: string };
  if (!body.id_token) return null;

  const payload = body.id_token.split('.')[1];
  if (!payload) return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
    email?: string;
    email_verified?: boolean;
  };

  // An unverified address is somebody else's until they prove otherwise, and
  // this address is the account's identity.
  if (!claims.email || claims.email_verified === false) return null;
  return claims.email.toLowerCase();
}
