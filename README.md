# Mochi account service

Accounts, plans and billing for [Mochi Table](https://github.com/mochi-cli/table).

It knows **who is signed in, which plan they hold, and how many MCP calls they
have made.** It does not know what is in anybody's tables, and there is nowhere
here to put that if it did — table data never leaves the machine it lives on.

The other half of this contract is `docs/account-service.md` in the table
repository. If the two disagree, that document is the specification and this is
the bug.

## Why it exists separately

Mochi Table is one process on a loopback port. It cannot receive a Stripe
webhook, it cannot own an OAuth redirect URI, and it has to keep working with
the network unplugged. So everything needing a public address lives here, and
the app holds only a cached, signed answer.

Everything about the app is fail-safe to the free tier: a missing file, a bad
signature, an expired claim, or this service being down all mean Free. An
outage here costs Pro features to people whose claim has run out. It never
costs anybody their data, and it never stops the app opening.

## Running it

```sh
npm install
cp .env.example .env.local     # then fill it in
npm run db:schema              # applies src/lib/schema.sql
npm run dev
```

For local development, generate a signing key and put the PEM in
`CLAIM_SIGNING_KEY`:

```sh
openssl genpkey -algorithm ed25519
openssl pkey -pubout            # the public half goes in the app's key map
```

That path is refused in production on purpose. There, set `CLAIM_KMS_KEY`
instead and let Cloud KMS hold the key — see below.

## The endpoints

| Route | What it does |
| --- | --- |
| `POST /v1/session/start` | Begins sign-in. Takes a PKCE challenge, returns a code and a Google URL. |
| `GET /auth/google/callback` | Where Google sends the browser. Redirects to a page saying the tab can be closed. |
| `POST /v1/session/exchange` | Code **and verifier** → signed claim and a refresh token. `202` while waiting. |
| `GET /v1/entitlement` | A fresh claim. Also where reconciliation happens. |
| `DELETE /v1/entitlement` | Signs out one machine. The subscription is untouched. |
| `POST /v1/usage` | The week's running total of MCP calls. |
| `POST /v1/checkout` | A Stripe Checkout URL. |
| `POST /v1/portal` | A Stripe billing portal URL. |
| `POST /webhooks/stripe` | Stripe's events. Not called by the app. |

## Four things that are load-bearing

**The verifier, not the code.** A bare sign-in code lands in browser history, in
proxy logs, and in screenshots of an address bar. The exchange also requires the
verifier it was derived from, which only ever existed in the app's memory and
never crossed the browser. Holding the code is not enough.

**`openid email` and nothing wider.** It is why a breach here is cheap: a stolen
Google token proves an email address and can do nothing else with the account it
belongs to. Any wider scope makes this service worth attacking for something
other than its own data.

**The webhook verifies against the raw body.** Signing covers the exact bytes,
and any framework handing you parsed JSON has already destroyed them —
`request.text()`, never `request.json()`. Handling is idempotent by event id,
and reconciles from Stripe's current state rather than applying the event's
delta, so `subscription.updated` arriving before `checkout.completed` is a
non-event.

**Cloud KMS in production.** On Vercel there is no KMS, so left alone the
signing key would sit in an environment variable — one crash dump, one
over-broad log line, or one over-shared team secret away from being copied, and
a copied signing key mints Pro forever and silently. Signing through KMS from
the function trades that for a credential scoped to `asymmetricSign` on one key:
it cannot read the key out, revoking it is a click and breaks no installed
build, and every signature is logged.

## There is no cron

The obvious safety net for a lost webhook is a nightly sweep over every
subscription. It is the wrong shape. `GET /v1/entitlement` re-reads Stripe when
the cached row is more than a day old, which does work proportional to use
rather than to the size of the customer table, corrects the record at the one
moment the answer is used, and is not a scheduled job that can quietly stop
running while everyone goes on believing there is a safety net.

Someone who lapses and never opens the app again needs nothing done: their claim
expires and they fall back to Free. The bounded worst case is one claim lifetime
of unpaid Pro — the same window the offline grace period hands out deliberately
— and no money is at risk either way, because Stripe bills the customer, not
this database.

## Where the money and the secrets are

Nothing here ever sees a card. Checkout and the billing portal are Stripe's own
pages; this service stores a customer id and a subscription status.

| Secret | Lives in |
| --- | --- |
| Google client secret | Vercel environment |
| Stripe secret key | Vercel environment |
| Stripe webhook signing secret | Vercel environment |
| Claim signing key | Cloud KMS — generated there, never exported |
| The app's public key | Shipped in the desktop build. Public, and safe to be. |

Refresh tokens are stored as SHA-256 hashes, so a leaked database is a list of
hashes rather than a list of working tokens.

## Tests

```sh
npm test
```

The one that matters is `test/claim.test.ts`: it reimplements Mochi Table's own
verification and checks a claim signed here passes it. The two repositories
cannot drift on the wire format without that going red.
