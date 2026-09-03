/**
 * Where Google sends people back to. Nothing of value is in this page — no
 * token, no claim — because the app is polling for those over its own
 * connection. That is what makes the browser half of this flow uninteresting
 * to steal from.
 */
export default async function SignedIn({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;

  if (status === 'expired') {
    return (
      <>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>That took a little too long</h1>
        <p style={{ color: '#57534e', lineHeight: 1.6 }}>
          The sign-in expired while this tab was open. Go back to Mochi Table and start again —
          nothing was changed.
        </p>
      </>
    );
  }

  if (status === 'failed') {
    return (
      <>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>That didn&rsquo;t work</h1>
        <p style={{ color: '#57534e', lineHeight: 1.6 }}>
          Google didn&rsquo;t confirm the sign-in. Go back to Mochi Table and try once more.
        </p>
      </>
    );
  }

  return (
    <>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Signed in</h1>
      <p style={{ color: '#57534e', lineHeight: 1.6 }}>
        You can close this tab. Mochi Table has already picked it up.
      </p>
    </>
  );
}
