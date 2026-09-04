import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Webhook } from 'standardwebhooks';
import { receiveWebhook, SUBSCRIPTION_EVENTS } from '../src/lib/webhook.ts';

/**
 * The billing endpoint strangers can reach.
 *
 * Every rule here exists because of a failure that is invisible while it is
 * happening: a replayed delivery that upgrades somebody twice, an event acted
 * on despite a bad signature, an error swallowed as 200 so Polar never retries
 * and a payer quietly stays Free. None of them throws, none of them logs, and
 * the first report is a billing complaint.
 *
 * Until now none of it was testable — it lived inside a Next route handler
 * wired to a real database and a real Polar client.
 */

/** The raw secret, exactly as Polar hands it over and as the env holds it. */
const SECRET = 'mochi-test-webhook-secret-0123456789';

/** How both the SDK and this service turn that into a signing key. */
const signingKey = (secret: string) => Buffer.from(secret, 'utf-8').toString('base64');

/** A delivery signed the way Polar signs one. */
function delivery(
  body: unknown,
  options: { id?: string; secret?: string; timestamp?: Date } = {}
): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  const id = options.id ?? 'msg_1';
  const timestamp = options.timestamp ?? new Date();
  const signer = new Webhook(signingKey(options.secret ?? SECRET));
  const signature = signer.sign(id, timestamp, payload);
  return {
    payload,
    headers: {
      'webhook-id': id,
      'webhook-timestamp': Math.floor(timestamp.getTime() / 1000).toString(),
      'webhook-signature': signature,
    },
  };
}

const subscriptionEvent = (id = 'sub_1') => ({
  type: 'subscription.updated',
  data: { id, customer: { externalId: 'acc_1' } },
});

/** Deps that count what they were asked to do. */
function spy(options: { seen?: Set<string>; fail?: boolean } = {}) {
  const seen = options.seen ?? new Set<string>();
  const handled: string[] = [];
  return {
    handled,
    claimed: seen,
    deps: {
      secret: SECRET,
      // Polar's own validator parses against generated zod schemas; a payload
      // those accept is several hundred lines of fixture pinned to somebody
      // else's API shape. The signature above is real either way.
      parse: (payload: string) => JSON.parse(payload) as { type: string; data: unknown },
      claim: async (id: string) => {
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      },
      handle: async (event: { type: string }) => {
        if (options.fail) throw new Error('database is down');
        handled.push(event.type);
      },
    },
  };
}

describe('a webhook that arrives', () => {
  test('a good one is handled once and acknowledged', async () => {
    const { deps, handled } = spy();
    const { payload, headers } = delivery(subscriptionEvent());

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 200);
    assert.deepEqual(handled, ['subscription.updated']);
  });

  test('the same delivery three times is handled once', async () => {
    // Polar retries. A duplicate that upgraded twice would be a double charge,
    // and nothing about it would look like an error at the time.
    const { deps, handled } = spy();
    const { payload, headers } = delivery(subscriptionEvent(), { id: 'msg_retry' });

    const first = await receiveWebhook(payload, headers, deps);
    const second = await receiveWebhook(payload, headers, deps);
    const third = await receiveWebhook(payload, headers, deps);

    assert.equal(handled.length, 1, 'handled once, whatever the delivery count');
    assert.equal(first.body.duplicate, undefined);
    assert.equal(second.body.duplicate, true);
    assert.equal(third.body.duplicate, true);
    // All three are 200: a retry must stop retrying, not be refused.
    for (const outcome of [first, second, third]) assert.equal(outcome.status, 200);
  });

  test('two different deliveries of the same subscription both run', async () => {
    // Idempotency is per delivery, not per subscription — a genuine later
    // event about the same subscription has to be acted on.
    const { deps, handled } = spy();
    const one = delivery(subscriptionEvent(), { id: 'msg_a' });
    const two = delivery(subscriptionEvent(), { id: 'msg_b' });

    await receiveWebhook(one.payload, one.headers, deps);
    await receiveWebhook(two.payload, two.headers, deps);
    assert.equal(handled.length, 2);
  });

  test('a bad signature is refused and nothing is handled', async () => {
    const { deps, handled, claimed } = spy();
    const { payload, headers } = delivery(subscriptionEvent(), {
      secret: 'a-completely-different-secret-000000',
    });

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 400);
    assert.equal(outcome.error?.code, 'bad_signature');
    assert.deepEqual(handled, []);
    // And the delivery id is not spent. Claiming before verifying would let
    // anybody burn a real event's id with a forged request, and the real
    // delivery would then arrive looking like a duplicate.
    assert.equal(claimed.size, 0);
  });

  test('a tampered body is refused even with a real delivery id', async () => {
    const { deps, handled } = spy();
    const { headers } = delivery(subscriptionEvent());
    const outcome = await receiveWebhook(
      JSON.stringify({ type: 'subscription.updated', data: { id: 'sub_evil' } }),
      headers,
      deps
    );
    assert.equal(outcome.error?.code, 'bad_signature');
    assert.deepEqual(handled, []);
  });

  test('no webhook-id at all is refused', async () => {
    // Nothing to be idempotent about. Processing it once and hoping is how a
    // retry storm becomes a billing incident.
    const { deps, handled } = spy();
    const { payload, headers } = delivery(subscriptionEvent());
    delete headers['webhook-id'];

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 400);
    assert.equal(outcome.error?.code, 'unsigned');
    assert.deepEqual(handled, []);
  });

  test('a handler that throws answers 5xx, so Polar retries', async () => {
    // The dangerous version of this bug is a `catch` that returns 200: Polar
    // records the delivery as successful, never sends it again, and the
    // subscription silently never syncs.
    const { deps } = spy({ fail: true });
    const { payload, headers } = delivery(subscriptionEvent());

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 500);
    assert.equal(outcome.error?.code, 'handler_failed');
  });

  test('an old delivery is refused rather than replayed', async () => {
    // Standard Webhooks signs the timestamp too. A recording of yesterday's
    // upgrade should not be re-playable today.
    const { deps, handled } = spy();
    const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { payload, headers } = delivery(subscriptionEvent(), { timestamp: old });

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 400);
    assert.deepEqual(handled, []);
  });
});

/**
 * The bug this file found on the way past.
 *
 * The route had a `default:` branch commented "acknowledged so Polar stops
 * retrying it". It never ran: Polar's validator throws on an unknown event
 * type before any switch is reached, so the whole request 500'd and Polar
 * retried it for ever. Polar adds event types, and adds fields to existing
 * ones — either would have turned the billing endpoint into a permanent retry
 * loop whose only symptom is error noise nobody is reading.
 *
 * These use the real validator, no seam, because the real validator is the
 * thing that was wrong.
 */
describe('a payload this build does not understand', () => {
  const real = (body: unknown, id: string) => delivery(body, { id });

  test('an event type nobody here has heard of is acknowledged, not retried', async () => {
    const { deps, handled } = spy();
    delete (deps as { parse?: unknown }).parse;
    const { payload, headers } = real({ type: 'invoice.teleported', data: {} }, 'msg_future');

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 200, 'a 5xx here is an infinite retry loop');
    assert.equal(outcome.body.ignored, true);
    assert.deepEqual(handled, []);
  });

  test('a known event type with a body the schema rejects is acknowledged too', async () => {
    // Retrying cannot fix a payload we cannot read, and reconcile-on-read
    // picks the subscription up on the next request anyway.
    const { deps, handled } = spy();
    delete (deps as { parse?: unknown }).parse;
    const { payload, headers } = real({ type: 'subscription.updated', data: {} }, 'msg_shape');

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.ignored, true);
    assert.deepEqual(handled, []);
  });

  test('but a bad signature still wins over an unreadable payload', async () => {
    // Order matters: verify first, then parse. The other way round would leak
    // "is this a shape we know" to anybody who can post.
    const { deps } = spy();
    delete (deps as { parse?: unknown }).parse;
    const { payload, headers } = delivery(
      { type: 'invoice.teleported', data: {} },
      { id: 'msg_forged', secret: 'not-the-secret-at-all-000000000000' }
    );

    const outcome = await receiveWebhook(payload, headers, deps);
    assert.equal(outcome.status, 400);
    assert.equal(outcome.error?.code, 'bad_signature');
  });
});

describe('which events count', () => {
  test('the seven subscription events are the whole list', () => {
    // Pinned because the vocabulary already changed once, when billing moved
    // from Stripe to Polar. A status that quietly stops being recognised does
    // not throw — it just leaves a paying customer on Free.
    assert.deepEqual(
      [...SUBSCRIPTION_EVENTS].sort(),
      [
        'subscription.active',
        'subscription.canceled',
        'subscription.created',
        'subscription.past_due',
        'subscription.revoked',
        'subscription.uncanceled',
        'subscription.updated',
      ]
    );
  });
});
