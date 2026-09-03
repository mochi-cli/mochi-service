import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isActive } from '../src/lib/db.ts';
import { planFor } from '../src/lib/billing.ts';

/**
 * Polar's status vocabulary, pinned.
 *
 * This exists because the vocabulary changed underneath this code once already,
 * when billing moved from Stripe to Polar, and a status that quietly stops
 * being recognised does not throw — it just makes a paying customer Free, which
 * is the one failure mode nobody reports as a bug because the app keeps working.
 */

const subscription = (status: string) => ({
  accountId: 'acc_1',
  polarId: 'sub_1',
  status,
  seats: 1,
  currentPeriodEnd: null,
  syncedAt: new Date().toISOString(),
});

describe('who may use Pro', () => {
  test('the three statuses that mean yes', () => {
    for (const status of ['active', 'trialing', 'past_due']) {
      assert.equal(isActive(status), true, status);
    }
  });

  test('past_due is deliberate, not an oversight', () => {
    // The card failed and Polar is retrying. Taking the product away mid-retry
    // punishes somebody whose bank declined a payment they intend to make.
    assert.equal(isActive('past_due'), true);
    // `unpaid` is where that patience stops.
    assert.equal(isActive('unpaid'), false);
  });

  test('every other status Polar can send means Free', () => {
    for (const status of ['incomplete', 'incomplete_expired', 'canceled', 'unpaid', 'paused']) {
      assert.equal(isActive(status), false, status);
    }
  });

  test('a status nobody has seen before means Free, not a crash', () => {
    // Polar's status is an open enum in the SDK, so a new value is a thing that
    // can arrive without an SDK upgrade. Failing safe beats failing.
    assert.equal(isActive('something_invented_next_year'), false);
  });

  test('no subscription at all is Free with one seat', () => {
    assert.deepEqual(planFor(null), { plan: 'free', seats: 1 });
  });

  test('an active subscription carries its seat count through', () => {
    assert.deepEqual(planFor({ ...subscription('active'), seats: 4 }), { plan: 'pro', seats: 4 });
  });

  test('a cancelled subscription is Free even with seats on the row', () => {
    assert.deepEqual(planFor({ ...subscription('canceled'), seats: 4 }), { plan: 'free', seats: 1 });
  });
});
