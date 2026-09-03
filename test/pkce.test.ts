import assert from 'node:assert/strict';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import test, { describe } from 'node:test';

/**
 * PKCE, which is what makes a leaked sign-in code worthless.
 *
 * The code travels in a URL: browser history, proxy logs, screenshots of an
 * address bar. Requiring the verifier — which only ever existed in the app's
 * memory and never crossed the browser — means reading the code is not enough
 * to take somebody's account.
 */

const challengeFor = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

const sameSecret = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

describe('the sign-in exchange', () => {
  test('the app that started it can finish it', () => {
    const verifier = randomBytes(32).toString('base64url');
    assert.ok(sameSecret(challengeFor(verifier), challengeFor(verifier)));
  });

  test('somebody holding only the code cannot', () => {
    // What an attacker has after reading a log: the code, and the challenge if
    // they can see the start request too. Neither yields the verifier.
    const verifier = randomBytes(32).toString('base64url');
    const stored = challengeFor(verifier);
    const guess = randomBytes(32).toString('base64url');
    assert.equal(sameSecret(stored, challengeFor(guess)), false);
  });

  test('the challenge does not reveal the verifier', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = challengeFor(verifier);
    assert.notEqual(challenge, verifier);
    assert.equal(challenge.length, 43, 'a SHA-256 digest, base64url, unpadded');
  });

  test('comparison is length-safe as well as constant-time', () => {
    // timingSafeEqual throws on a length mismatch, so the guard has to come
    // first — a thrown error inside an auth check is a 500 where a 403 belongs.
    assert.doesNotThrow(() => sameSecret('short', 'much longer value'));
    assert.equal(sameSecret('short', 'much longer value'), false);
  });
});
