import type { CustomerMessage } from '@/lib/errors';

/**
 * A failure, as the customer sees it.
 *
 * Renders only what `toCustomerMessage` produced — a title, a sentence, and a
 * request id. It never receives an `Error`, so there is no path by which a
 * server message or a stack trace could reach the screen.
 */
export function ErrorNotice({ message }: { message: CustomerMessage }) {
  return (
    <div className="notice bad" role="alert">
      <h3>{message.title}</h3>
      <p className="muted">{message.detail}</p>
      {message.requestId === null ? null : <p className="ref">Reference: {message.requestId}</p>}
    </div>
  );
}
