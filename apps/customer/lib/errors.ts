/**
 * Turning an API failure into something a customer can act on.
 *
 * The Control API envelope (§6) carries a `code`, a `message`, and a
 * `request_id`. This module decides what the person in front of the screen
 * sees, and the rule it enforces is one-directional: a message is shown because
 * this file chose it, never because the server happened to send a string.
 *
 * That is stricter than T14 requires — the brief permits displaying a backend
 * message that is already customer-appropriate — and deliberately so. "Already
 * appropriate" would have to be re-decided every time the API grows an error,
 * and the cost of getting it wrong once is an internal detail in front of an end
 * user. A fixed table cannot leak anything, and the `request_id` is what
 * actually makes a support report actionable.
 */

import { ErrorCode } from '@vcip/shared';

/** A failure that arrived as an HTTP response, with or without the envelope. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** A request that never produced a response: offline, DNS, refused, CORS. */
export class NetworkError extends Error {
  constructor(message = 'network request failed') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface CustomerMessage {
  /** Short heading. */
  readonly title: string;
  /** One or two sentences the customer can act on. */
  readonly detail: string;
  /** Whether repeating the same action could plausibly succeed. */
  readonly retryable: boolean;
  /** Shown small, for support. Never a token, never a payload. */
  readonly requestId: string | null;
}

interface MessageTemplate {
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
}

const MOVED_ON: MessageTemplate = {
  title: 'This step is no longer available',
  detail: 'The verification moved on while you were working. Refresh to see where it stands.',
  retryable: false,
};

const BY_CODE: Readonly<Record<string, MessageTemplate>> = Object.freeze({
  [ErrorCode.SESSION_INVALID_STATE]: MOVED_ON,
  [ErrorCode.SESSION_ALREADY_ASSIGNED]: MOVED_ON,
  [ErrorCode.CONFLICT]: MOVED_ON,
  [ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE]: {
    title: 'Checks not complete',
    detail: 'One of the earlier checks has not passed yet.',
    retryable: false,
  },
  [ErrorCode.VALIDATION_ERROR]: {
    title: 'That was not accepted',
    detail: 'The information submitted was not in the expected form. Please try again.',
    retryable: true,
  },
  [ErrorCode.UNAUTHENTICATED]: {
    title: 'Your session has expired',
    detail:
      'Verification links are valid for a limited time. Please start again from your bank or provider.',
    retryable: false,
  },
  [ErrorCode.FORBIDDEN]: {
    title: 'Not authorised',
    detail: 'This link does not grant access to that verification.',
    retryable: false,
  },
  [ErrorCode.NOT_FOUND]: {
    title: 'Verification not found',
    detail: 'This verification no longer exists. Please start again from your bank or provider.',
    retryable: false,
  },
  [ErrorCode.UNPROCESSABLE]: {
    title: 'We could not use that',
    detail: 'The information submitted could not be accepted. Please try again.',
    retryable: true,
  },
  [ErrorCode.RATE_LIMITED]: {
    title: 'Too many attempts',
    detail: 'Please wait a moment and try again.',
    retryable: true,
  },
  [ErrorCode.INTERNAL_ERROR]: {
    title: 'Something went wrong on our side',
    detail: 'This is temporary. Please try again in a moment.',
    retryable: true,
  },
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    title: 'Service temporarily unavailable',
    detail: 'We could not reach the verification service. Please try again shortly.',
    retryable: true,
  },
});

/** Used when the status is recognised but the code is not one we know. */
const CODE_BY_STATUS: Readonly<Record<number, string>> = Object.freeze({
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  422: ErrorCode.UNPROCESSABLE,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL_ERROR,
  503: ErrorCode.SERVICE_UNAVAILABLE,
});

const UNKNOWN: MessageTemplate = {
  title: 'Something went wrong',
  detail: 'Please try again in a moment.',
  retryable: true,
};

const OFFLINE: MessageTemplate = {
  title: 'No connection',
  detail: 'We could not reach the verification service. Check your connection and try again.',
  retryable: true,
};

/**
 * Map any thrown value onto something displayable.
 *
 * Total by construction: an unrecognised throw becomes the generic message
 * rather than reaching a screen as `String(error)`, which is how stack traces
 * and driver messages end up in front of customers.
 */
export function toCustomerMessage(error: unknown): CustomerMessage {
  if (error instanceof NetworkError) {
    return { ...OFFLINE, requestId: null };
  }

  if (error instanceof ApiError) {
    const byCode = BY_CODE[error.code];
    if (byCode !== undefined) return { ...byCode, requestId: error.requestId };

    const fallbackCode = CODE_BY_STATUS[error.status];
    const byStatus = fallbackCode === undefined ? undefined : BY_CODE[fallbackCode];
    if (byStatus !== undefined) return { ...byStatus, requestId: error.requestId };

    // A 5xx we have no code for is still a server fault, and still worth a retry.
    if (error.status >= 500) return { ...UNKNOWN, retryable: true, requestId: error.requestId };

    return { ...UNKNOWN, requestId: error.requestId };
  }

  return { ...UNKNOWN, requestId: null };
}
