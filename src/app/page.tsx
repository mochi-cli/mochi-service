export default function Home() {
  return (
    <>
      <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Mochi account service</h1>
      <p style={{ color: '#57534e', lineHeight: 1.6 }}>
        This handles sign-in and billing for Mochi Table. It knows who is signed in and what they
        pay for. It never sees what is in anybody&rsquo;s tables — those stay on their own machine.
      </p>
    </>
  );
}
