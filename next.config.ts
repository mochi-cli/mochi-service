import type { NextConfig } from 'next';

const config: NextConfig = {
  // Nothing here is a static page worth caching at the edge, and every route
  // handler needs the Node runtime for Ed25519 and the Stripe SDK.
  poweredByHeader: false,
};

export default config;
