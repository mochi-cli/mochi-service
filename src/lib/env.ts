/**
 * Configuration, read once and complained about loudly.
 *
 * Every one of these is a secret or an address that differs per environment,
 * and a service that starts with half of them missing fails later, further
 * from the cause, usually in front of somebody trying to pay.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set — see .env.example`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export const env = {
  /** Public origin of this service, e.g. https://account.mochi.example. */
  get origin() {
    return required('SERVICE_ORIGIN').replace(/\/$/, '');
  },

  get databaseUrl() {
    return required('DATABASE_URL');
  },

  get google() {
    return {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
    };
  },

  get polar() {
    const servers = ['production', 'sandbox'] as const;
    const named = optional('POLAR_SERVER') ?? 'production';
    const server = servers.find((candidate) => candidate === named);
    if (!server) {
      throw new Error(`POLAR_SERVER must be "production" or "sandbox", not "${named}"`);
    }
    return {
      accessToken: required('POLAR_ACCESS_TOKEN'),
      webhookSecret: required('POLAR_WEBHOOK_SECRET'),
      /** Polar sells *products*, not prices — one per billing cadence. */
      productMonthly: required('POLAR_PRODUCT_MONTHLY'),
      productYearly: required('POLAR_PRODUCT_YEARLY'),
      /**
       * Sandbox is a wholly separate Polar instance with its own tokens and
       * its own product ids, so this is not a flag to flip casually — pointing
       * production at sandbox silently makes every paying customer free.
       */
      server,
    };
  },

  /**
   * How the entitlement claim is signed.
   *
   * `CLAIM_KMS_KEY` is the production answer: the private key is generated
   * inside Cloud KMS and never exists anywhere else, so there is no
   * environment variable to leak. `CLAIM_SIGNING_KEY` is a PKCS#8 PEM for
   * local development only — see claim.ts, which refuses to use it outside it.
   */
  get signing() {
    return {
      kid: required('CLAIM_KID'),
      kmsKey: optional('CLAIM_KMS_KEY'),
      localKey: optional('CLAIM_SIGNING_KEY'),
      /**
       * Credentials for reaching KMS. The Google libraries normally find these
       * by themselves, but only on Google's own infrastructure, where there is
       * a metadata server to ask. On Vercel there is not, so the service
       * account travels as JSON in an environment variable.
       *
       * This is not the thing the KMS argument was avoiding. What leaks here is
       * permission to *ask that one key for signatures* until it is revoked —
       * scoped to roles/cloudkms.signerVerifier on a single key, revocable in a
       * click, and it breaks no installed build. The private key itself still
       * cannot be carried away.
       */
      serviceAccount: optional('GOOGLE_SERVICE_ACCOUNT_JSON'),
    };
  },

  /**
   * How long a claim is believed. Days, not hours — see the README.
   *
   * Checked rather than trusted, because both ways of getting it wrong are
   * nasty. A non-numeric value makes `new Date(NaN).toISOString()` throw, at
   * signing time, in production, on the request of somebody who has just paid.
   * A zero or negative one is worse: every claim is born already expired, so
   * every customer is silently Free and it looks exactly like a working free
   * tier. The upper bound is there because a fat-fingered 3650 is far likelier
   * than a deliberate ten years, and this number is how long a cancelled
   * subscription keeps working.
   */
  get claimLifetimeDays() {
    const raw = optional('CLAIM_LIFETIME_DAYS');
    if (raw === undefined) return 7;
    const days = Number(raw);
    if (!Number.isFinite(days) || days <= 0) {
      throw new Error(`CLAIM_LIFETIME_DAYS must be a positive number of days, not "${raw}"`);
    }
    if (days > 90) {
      throw new Error(
        `CLAIM_LIFETIME_DAYS of ${days} is longer than any grace period should be — ` +
          'it is also how long a cancelled subscription keeps Pro'
      );
    }
    return days;
  },

  get isProduction() {
    return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  },
};
