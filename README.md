# Mochi account service

Accounts, plans and billing for [Mochi Table](https://github.com/mochi-cli/table).

It knows **who is signed in, which plan they hold, and how many MCP calls they
have made.** It does not know what is in anybody's tables, and there is nowhere
here to put that if it did — table data never leaves the machine it lives on.

The other half of this contract is `docs/account-service.md` in the table
repository. If the two disagree, that document is the specification and this is
the bug.

## Why it exists separately

Mochi Table is one process on a loopback port. It cannot receive a Polar
webhook, it cannot own an OAuth redirect URI, and it has to keep working with
the network unplugged. So everything needing a public address lives here, and
the app holds only a cached, signed answer.

Money goes through **Polar**, a merchant of record. That is a deliberate choice
over a payment processor: Polar is the seller, so Polar owes the VAT wherever
somebody buys from. Digital goods sold to consumers in the EU have no
small-seller threshold to hide under — the obligation starts at the first euro,
and it is not one person's evening job to discharge in twenty jurisdictions. It
also means the seller can be established in a country Stripe does not support,
which is why this is not Stripe.

Everything about the app is fail-safe to the free tier: a missing file, a bad
signature, an expired claim, or this service being down all mean Free. An
outage here costs Pro features to people whose claim has run out. It never
costs anybody their data, and it never stops the app opening.

## Running it

```sh
npm install
cp .env.example .env.local     # then fill it in
npm run db:schema              # applies src/lib/schema.sql (needs DATABASE_URL)
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

## The three things you have to create by hand

**Google OAuth** — application type **Web application**, not Desktop. Mochi
never speaks to Google; it opens a browser at a URL this service builds, and
the whole exchange happens here. Desktop clients only accept loopback redirect
URIs and are public clients whose secret Google documents as not secret, so
neither half of what `src/lib/google.ts` does would work.

- Authorised redirect URI: `$SERVICE_ORIGIN/auth/google/callback`, plus
  `http://localhost:3000/auth/google/callback` for development
- Authorised JavaScript origins: none — no Google code runs in a browser here
- Scopes `openid email` are non-sensitive, so there is no Google review to pass

**Polar** — create an organization, then two products (monthly and yearly) and
copy their ids into `POLAR_PRODUCT_*`. The access token must be an
*organization* token from Settings, not a personal one; a personal token dies
with the person who made it. Register a webhook endpoint at
`$SERVICE_ORIGIN/webhooks/polar` subscribed to the `subscription.*` events, and
copy its secret into `POLAR_WEBHOOK_SECRET` — that secret comes from the
endpoint, not from the tokens page.

Build against `POLAR_SERVER=sandbox`, which is a wholly separate instance with
its own tokens and its own product ids. Pointing production at sandbox does not
error; it silently makes every paying customer free.

**The signing key** — created in Cloud KMS, where it stays:

```sh
gcloud kms keyrings create mochi --location=global
gcloud kms keys create claim-signing --location=global --keyring=mochi \
  --purpose=asymmetric-signing --default-algorithm=ec-sign-ed25519
gcloud kms keys versions list --location=global --keyring=mochi --key=claim-signing
```

`CLAIM_KMS_KEY` is the full resource name **of a version** — `.../cryptoKeyVersions/1`.
Naming the key instead of the version is the first mistake everybody makes, and
the error does not say so.

The public half goes into the desktop build, filed under `CLAIM_KID`:

```sh
gcloud kms keys versions get-public-key 1 --location=global \
  --keyring=mochi --key=claim-signing --output-file=claim-2026-09.pub
```

Then a service account holding `roles/cloudkms.signerVerifier` **on that key
only**, with its JSON in `GOOGLE_SERVICE_ACCOUNT_JSON`. Vercel has no metadata
server, so the Google libraries cannot find credentials on their own. Workload
Identity Federation against Vercel's OIDC token removes even this file, and is
the upgrade when someone has an afternoon.

## The endpoints

| Route | What it does |
| --- | --- |
| `POST /v1/session/start` | Begins sign-in. Takes a PKCE challenge, returns a code and a Google URL. |
| `GET /auth/google/callback` | Where Google sends the browser. Redirects to a page saying the tab can be closed. |
| `POST /v1/session/exchange` | Code **and verifier** → signed claim and a refresh token. `202` while waiting. |
| `GET /v1/entitlement` | A fresh claim. Also where reconciliation happens. |
| `DELETE /v1/entitlement` | Signs out one machine. The subscription is untouched. |
| `POST /v1/usage` | The week's running total of MCP calls. |
| `POST /v1/checkout` | A Polar Checkout URL. |
| `POST /v1/portal` | A Polar customer portal URL. `409` on the free plan. |
| `POST /webhooks/polar` | Polar's events. Not called by the app. |

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
`request.text()`, never `request.json()`. Polar follows the Standard Webhooks
spec, so the delivery id lives in the `webhook-id` header rather than in the
body — that header is the idempotency key, and there is nothing inside the
payload to use instead. Handling reconciles from Polar's current state rather
than applying the event's delta, so `subscription.updated` arriving before
`subscription.created` is a non-event.

**There is no customer id column.** Checkout hands Polar our account id as the
customer's `externalCustomerId`, so Polar creates the customer keyed by it. No
create-customer round trip, no id to store, no column to drift — and a webhook
carries the account id inside itself rather than needing a lookup table to
decode.

**Cloud KMS in production.** On Vercel there is no KMS, so left alone the
signing key would sit in an environment variable — one crash dump, one
over-broad log line, or one over-shared team secret away from being copied, and
a copied signing key mints Pro forever and silently. Signing through KMS from
the function trades that for a credential scoped to `asymmetricSign` on one key:
it cannot read the key out, revoking it is a click and breaks no installed
build, and every signature is logged.

## There is no cron

The obvious safety net for a lost webhook is a nightly sweep over every
subscription. It is the wrong shape. `GET /v1/entitlement` re-reads Polar when
the cached row is more than a day old, which does work proportional to use
rather than to the size of the customer table, corrects the record at the one
moment the answer is used, and is not a scheduled job that can quietly stop
running while everyone goes on believing there is a safety net.

Someone who lapses and never opens the app again needs nothing done: their claim
expires and they fall back to Free. The bounded worst case is one claim lifetime
of unpaid Pro — the same window the offline grace period hands out deliberately
— and no money is at risk either way, because Polar bills the customer, not
this database.

## Where the money and the secrets are

Nothing here ever sees a card. Checkout and the customer portal are Polar's own
pages; this service stores a subscription id and a status. Polar being the
merchant of record, the invoice the customer receives is Polar's — not a
document this service should be forging.

| Secret | Lives in |
| --- | --- |
| Google client secret | Vercel environment |
| Polar organization access token | Vercel environment |
| Polar webhook signing secret | Vercel environment |
| Claim signing key | Cloud KMS — generated there, never exported |
| The app's public key | Shipped in the desktop build. Public, and safe to be. |

Refresh tokens are stored as SHA-256 hashes, so a leaked database is a list of
hashes rather than a list of working tokens.

## What this costs to run

Google sign-in is free — no fee, no monthly-active-user ceiling for `openid
email`. The bill is entirely the infrastructure around it, and there is
deliberately not much of it:

| | |
| --- | --- |
| Neon Postgres | Free tier, scales to near zero |
| Cloud KMS | Cents: a key version plus per-signature charges, and signatures happen about once a day per install |
| Vercel | Invocations — which is why `GET /v1/entitlement` refreshes daily rather than hourly. The claim is valid for days by design, so an hourly poll buys nothing and multiplies the invoice by twenty-four |

Sign-in codes used to live in Upstash Redis for its TTL. They live in Postgres
now: expiry is enforced by `expires_at > now()` on every read, so a stale row is
already unusable and deleting it is housekeeping rather than correctness. That
removed a vendor, a dependency and two environment variables — and fixed a race,
because `DELETE ... RETURNING` spends a code in one statement where `get` then
`del` was two.

## Tests

```sh
npm test
```

The one that matters is `test/claim.test.ts`: it reimplements Mochi Table's own
verification and checks a claim signed here passes it. The two repositories
cannot drift on the wire format without that going red.
