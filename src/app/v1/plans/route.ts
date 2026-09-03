import { NextResponse } from 'next/server';
import { env } from '@/lib/env.ts';
import { polar } from '@/lib/billing.ts';
import { fail } from '@/lib/http.ts';

export const runtime = 'nodejs';

/**
 * What Pro costs, read from Polar rather than written down twice.
 *
 * The alternative is a number in the app, and a number in the app drifts: the
 * feature table said $5 a month for weeks after the real product was set to
 * something else, and nobody noticed because nothing compares them. A price
 * shown to somebody about to pay has to be the price they will be charged, so
 * it comes from the same place that charges them.
 *
 * No authentication: this is a price list. It is on the checkout page anyway.
 */
export async function GET() {
  try {
    const client = polar();
    const [monthly, yearly] = await Promise.all([
      client.products.get({ id: env.polar.productMonthly }),
      client.products.get({ id: env.polar.productYearly }),
    ]);

    // Polar quotes money in minor units — cents — and a price rendered a
    // hundred times too large is the kind of bug that stops a sale outright.
    const price = (product: typeof monthly) => {
      const fixed = product.prices.find(
        (candidate) => 'priceAmount' in candidate && candidate.amountType === 'fixed'
      );
      if (!fixed || !('priceAmount' in fixed)) return null;
      return {
        amount: fixed.priceAmount / 100,
        currency: fixed.priceCurrency.toUpperCase(),
        interval: product.recurringInterval,
      };
    };

    return NextResponse.json({ monthly: price(monthly), yearly: price(yearly) });
  } catch (error) {
    /**
     * Not the usual opaque 500. A price list has no secret in it, and the two
     * ways this fails are worth telling apart from outside: a 404 means a
     * product id is wrong, a 401 or 403 means the token cannot read products.
     * Both are configuration, and both look identical behind a generic error.
     *
     * The upstream status only — never the exception text, which is where a
     * client library likes to quote the request it made.
     */
    const status = (error as { statusCode?: number; status?: number }).statusCode ??
      (error as { status?: number }).status ?? null;
    console.error('[service] could not read plans from Polar', status, error);
    return fail(
      502,
      'plans_unavailable',
      status === 404
        ? 'Polar does not know one of POLAR_PRODUCT_MONTHLY or POLAR_PRODUCT_YEARLY'
        : status === 401 || status === 403
          ? 'POLAR_ACCESS_TOKEN cannot read products — check its scopes'
          : `could not reach Polar${status ? ` (${status})` : ''}`
    );
  }
}
