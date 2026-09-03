import type { ReactNode } from 'react';

export const metadata = {
  title: 'Mochi account',
  description: 'Accounts and billing for Mochi Table.',
};

/**
 * The whole visual surface of this service is three short pages that people
 * read for four seconds and close, so the styling is inline and there is no
 * stylesheet to load. Anything more would be design work for a tab nobody
 * stays in.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
          background: '#fafaf9',
          color: '#1c1917',
        }}
      >
        <main style={{ maxWidth: '28rem', padding: '2rem', textAlign: 'center' }}>{children}</main>
      </body>
    </html>
  );
}
