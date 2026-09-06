import { SessionFlow } from '@/components/SessionFlow';

/**
 * The verification page.
 *
 * A server component that does one thing: read the session id from the path and
 * hand it to the client flow. It deliberately fetches nothing — the customer
 * token lives in a URL fragment the server never receives, so any server-side
 * read would be an unauthenticated one.
 */
export default async function SessionPage({ params }: { params: Promise<{ session_id: string }> }) {
  const { session_id: sessionId } = await params;

  return (
    <main className="shell">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          VC
        </span>
        <span className="brand-name">Secure verification</span>
      </div>
      <SessionFlow sessionId={sessionId} />
    </main>
  );
}
