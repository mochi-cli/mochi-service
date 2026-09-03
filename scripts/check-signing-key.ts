import { createPublicKey, verify } from 'node:crypto';
import { buildClaim, signClaim } from '../src/lib/claim.ts';
import { env } from '../src/lib/env.ts';

/**
 * Proves the service and the app agree about the signing key.
 *
 * Two facts have to line up and nothing enforces it: `CLAIM_KMS_KEY` here, and
 * the PEM shipped in the app's `SHIPPED_KEYS` under the same `kid`. Get them
 * out of step — rotate the KMS key, forget to ship the new public half, name
 * the wrong version — and nothing throws anywhere. Signatures simply stop
 * verifying, every install falls back to Free, and it looks exactly like a
 * working free tier. Nobody files that bug.
 *
 * So: sign a real claim through whatever this environment is configured to use,
 * then verify it with the key the app would actually use. Run it after any
 * change to either side.
 *
 *   npm run check:key -- "$(pbpaste)"      # the app's shipped PEM
 *
 * With no argument it just prints what KMS holds, for copying into the app.
 */

async function main(): Promise<void> {
  const expected = process.argv[2]?.trim();

  console.log(`kid            ${env.signing.kid}`);
  console.log(`signing via    ${env.signing.kmsKey ? 'Cloud KMS' : 'a local PEM (development)'}`);
  if (env.signing.kmsKey) console.log(`key version    ${env.signing.kmsKey}`);

  if (env.signing.kmsKey) {
    const { KeyManagementServiceClient } = await import('@google-cloud/kms');
    const json = env.signing.serviceAccount;
    const client = new KeyManagementServiceClient(
      json ? { credentials: JSON.parse(json) as Record<string, unknown> } : undefined
    );
    const [key] = await client.getPublicKey({ name: env.signing.kmsKey });
    console.log(`\nThe public half, as KMS holds it:\n\n${key.pem?.trim()}\n`);
  }

  // The real test: a claim signed the way production signs, checked the way the
  // app checks. Anything wrong with the wiring shows up here rather than in
  // somebody's support email a week after they paid.
  const signed = await signClaim(buildClaim({ plan: 'pro', email: 'check@example.test', seats: 1 }));
  if (!expected) {
    console.log('Signed a test claim successfully. Pass the app’s shipped PEM to check it verifies.');
    return;
  }

  const ok = verify(
    null,
    Buffer.from(signed.claim, 'base64'),
    createPublicKey(expected),
    Buffer.from(signed.signature, 'base64')
  );
  console.log(ok ? '\nOK — the app can verify what this service signs.' : '\nMISMATCH');
  if (!ok) {
    console.error(
      'The shipped key does not match the signing key. Every install would be Free.\n' +
        'Copy the PEM printed above into SHIPPED_KEYS in the app, under this kid.'
    );
    process.exitCode = 1;
  }
}

await main();
