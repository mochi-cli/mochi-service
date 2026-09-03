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

  get redis() {
    return {
      url: required('UPSTASH_REDIS_REST_URL'),
      token: required('UPSTASH_REDIS_REST_TOKEN'),
    };
  },

  get google() {
    return {
      clientId: required('GOOGLE_CLIENT_ID'),
      clientSecret: required('GOOGLE_CLIENT_SECRET'),
    };
  },

  get stripe() {
    return {
      secretKey: required('STRIPE_SECRET_KEY'),
      webhookSecret: required('STRIPE_WEBHOOK_SECRET'),
      /** The recurring price people are sent to Checkout for. */
      priceMonthly: required('STRIPE_PRICE_MONTHLY'),
      priceYearly: required('STRIPE_PRICE_YEARLY'),
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
    };
  },

  /** How long a claim is believed. Days, not hours — see the README. */
  get claimLifetimeDays() {
    return Number(optional('CLAIM_LIFETIME_DAYS') ?? 7);
  },

  get isProduction() {
    return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  },
};
