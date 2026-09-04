import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { validateEvent } from '@polar-sh/sdk/webhooks.js';

/**
 * What happens to an incoming webhook, decided apart from HTTP.
 *
 * Split out of the route because none of this could be tested where it was. It
 * is the one endpoint strangers can reach that changes billing state, and the
 * failures it guards against — a replay that upgrades twice, an event acted on
 * despite a bad signature, an error swallowed as 200 so Polar stops retrying —
 * are all invisible in production until somebody is charged wrong or a payer
 * sees Free. "We believe it is idempotent" is not the same as a test that
 * fails when it stops being.
 *
 * Dependencies arrive as arguments: `claim` writes the delivery id, `handle`
 * does the work. The route supplies the real ones; a test supplies counters.
 */

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
  /** Set when the request was rejected, matching the app's error shape. */
  error?: { code: string; message: string };
}

export interface WebhookDeps {
  secret: string;
  /** Records the delivery id, returning false when it was already there. */
  claim: (deliveryId: string) => Promise<boolean>;
  handle: (event: { type: string; data: unknown }) => Promise<void>;
  /**
   * Turns a verified payload into an event.
   *
   * A seam, because the real one is Polar's `validateEvent`, which parses
   * against generated zod schemas — building a payload those accept takes
   * several hundred lines of fixture and pins this service's tests to the
   * shape of somebody else's API.
   */
  parse?: (payload: string, headers: Record<string, string>, secret: string) => unknown;
}

const ok = (body: Record<string, unknown>): WebhookOutcome => ({ status: 200, body });

const refuse = (status: number, code: string, message: string): WebhookOutcome => ({
  status,
  body: { error: { code, message } },
  error: { code, message },
});

/**
 * The signature, checked ourselves.
 *
 * Polar's `validateEvent` verifies *and* parses in one call, which makes "the
 * signature was wrong" and "this build does not recognise the payload"
 * indistinguishable to the caller — and those two need opposite answers.
 * Same scheme and same secret handling as the SDK: Standard Webhooks over the
 * raw bytes, with the secret base64'd first.
 */
function verify(payload: string, headers: Record<string, string>, secret: string): void {
  new Webhook(Buffer.from(secret, 'utf-8').toString('base64')).verify(payload, headers);
}

export async function receiveWebhook(
  payload: string,
  headers: Record<string, string>,
  deps: WebhookDeps
): Promise<WebhookOutcome> {
  // Standard Webhooks puts the delivery's identity in a header, not in the
  // body — unlike Stripe, there is no event id inside to key on. Without it
  // there is nothing to be idempotent about, so it is refused rather than
  // processed once and hoped about.
  const deliveryId = headers['webhook-id'];
  if (!deliveryId) return refuse(400, 'unsigned', 'no webhook-id on this request');

  try {
    // The raw bytes, before anything parses them: signing covers the exact
    // string, and a framework that hands you parsed JSON has already destroyed
    // it. Verified *before* the claim, so a forged delivery id cannot burn a
    // real event's id and leave the real one looking like a duplicate.
    verify(payload, headers, deps.secret);
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      console.error('[service] webhook signature rejected');
      return refuse(400, 'bad_signature', 'that signature does not check out');
    }
    throw error;
  }

  let event: { type: string; data: unknown };
  try {
    event = (deps.parse ?? validateEvent)(payload, headers, deps.secret) as {
      type: string;
      data: unknown;
    };
  } catch (error) {
    /**
     * Signed by Polar, and not something this build understands.
     *
     * This used to be a 500. The old code had a `default:` branch commented
     * "acknowledged so Polar stops retrying it" — which never ran, because the
     * SDK throws on an unknown event type before the switch is reached. Polar
     * sends new event types, and adds fields to existing ones; either would
     * have turned this endpoint into a permanent retry loop with no symptom
     * except error noise nobody was reading.
     *
     * Acknowledged instead. Retrying cannot fix a payload we cannot read, and
     * reconcile-on-read picks the subscription up on the next request anyway.
     */
    console.error('[service] webhook payload not recognised', error);
    return ok({ received: true, ignored: true });
  }

  try {
    if (!(await deps.claim(deliveryId))) {
      // Seen before. Acknowledged so Polar stops retrying, and emphatically
      // not handled again.
      return ok({ received: true, duplicate: true });
    }
    await deps.handle(event);
    return ok({ received: true });
  } catch (error) {
    // Polar treats any 2xx as delivered, so a failure has to leave as a
    // non-2xx or the event is gone for good.
    console.error('[service] webhook handling failed', event.type, error);
    return refuse(500, 'handler_failed', 'could not handle that event — please retry');
  }
}

/** The subscription events this service acts on. Everything else is noise. */
export const SUBSCRIPTION_EVENTS = new Set([
  'subscription.created',
  'subscription.updated',
  'subscription.active',
  'subscription.canceled',
  'subscription.uncanceled',
  'subscription.past_due',
  'subscription.revoked',
]);
