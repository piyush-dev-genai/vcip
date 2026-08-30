/**
 * Turning an API failure into something an agent can act on.
 *
 * Same rule as the customer app: a message is shown because this file chose it,
 * never because the server happened to send a string. A fixed table cannot leak
 * an internal detail, and the `request_id` is what actually makes a support
 * report actionable.
 *
 * The agent's table differs from the customer's in one way that matters. A
 * failed login must say the same thing whatever went wrong, because the API
 * deliberately answers the same way for a wrong password, an unknown email, an
 * unknown tenant, and a disabled account. A helpful "no such user" here would
 * reintroduce, in the browser, the enumeration oracle the server refuses to be.
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

export interface AgentMessage {
  readonly title: string;
  readonly detail: string;
  /** Whether repeating the same action could plausibly succeed. */
  readonly retryable: boolean;
  /** True when the agent must log in again. Drives the portal's state. */
  readonly reauthenticate: boolean;
  /** Shown small, for support. Never a token, never a payload. */
  readonly requestId: string | null;
}

interface MessageTemplate {
  readonly title: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly reauthenticate: boolean;
}

const UNKNOWN: MessageTemplate = {
  title: 'Something went wrong',
  detail: 'Please try again in a moment.',
  retryable: true,
  reauthenticate: false,
};

const OFFLINE: MessageTemplate = {
  title: 'No connection',
  detail: 'We could not reach the verification service. Check your connection and try again.',
  retryable: true,
  reauthenticate: false,
};

const SIGNED_OUT: MessageTemplate = {
  title: 'Your session has ended',
  detail: 'Please sign in again.',
  retryable: false,
  reauthenticate: true,
};

const BY_CODE: Readonly<Record<string, MessageTemplate>> = Object.freeze({
  [ErrorCode.UNAUTHENTICATED]: SIGNED_OUT,
  [ErrorCode.FORBIDDEN]: {
    title: 'Not permitted',
    detail: 'This account is not set up to take verifications.',
    retryable: false,
    reauthenticate: false,
  },
  [ErrorCode.VALIDATION_ERROR]: {
    title: 'That was not accepted',
    detail: 'The request was not in the expected form. Please try again.',
    retryable: true,
    reauthenticate: false,
  },
  [ErrorCode.NOT_FOUND]: {
    title: 'Not found',
    detail: 'That is no longer available.',
    retryable: false,
    reauthenticate: false,
  },
  [ErrorCode.CONFLICT]: {
    title: 'Something changed',
    detail: 'The state moved on while you were working. Refresh to see where it stands.',
    retryable: false,
    reauthenticate: false,
  },
  [ErrorCode.RATE_LIMITED]: {
    title: 'Too many attempts',
    detail: 'Please wait a moment and try again.',
    retryable: true,
    reauthenticate: false,
  },
  [ErrorCode.INTERNAL_ERROR]: UNKNOWN,
  [ErrorCode.SERVICE_UNAVAILABLE]: {
    title: 'Service temporarily unavailable',
    detail: 'We could not reach the verification service. Please try again shortly.',
    retryable: true,
    reauthenticate: false,
  },
});

const CODE_BY_STATUS: Readonly<Record<number, string>> = Object.freeze({
  400: ErrorCode.VALIDATION_ERROR,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL_ERROR,
  503: ErrorCode.SERVICE_UNAVAILABLE,
});

/**
 * Map any thrown value onto something displayable.
 *
 * Total by construction: an unrecognised throw becomes the generic message
 * rather than reaching a screen as `String(error)`.
 */
export function toAgentMessage(error: unknown): AgentMessage {
  if (error instanceof NetworkError) return { ...OFFLINE, requestId: null };

  if (error instanceof ApiError) {
    const byCode = BY_CODE[error.code];
    if (byCode !== undefined) return { ...byCode, requestId: error.requestId };

    const fallbackCode = CODE_BY_STATUS[error.status];
    const byStatus = fallbackCode === undefined ? undefined : BY_CODE[fallbackCode];
    if (byStatus !== undefined) return { ...byStatus, requestId: error.requestId };

    return { ...UNKNOWN, requestId: error.requestId };
  }

  return { ...UNKNOWN, requestId: null };
}

/**
 * The message shown when a sign-in attempt fails.
 *
 * Deliberately not `toAgentMessage`. A 401 during a session means "you were
 * signed out"; a 401 at the login form means "those credentials did not work",
 * and it must say exactly that for every cause — wrong password, unknown
 * address, unknown organisation, disabled account. A network failure is still
 * reported honestly, because it says nothing about whether an account exists.
 */
export function toLoginMessage(error: unknown): AgentMessage {
  if (error instanceof NetworkError) return { ...OFFLINE, requestId: null };

  if (error instanceof ApiError && error.status === 400) {
    return {
      title: 'Check the form',
      detail: 'Enter your organisation, email address, and password.',
      retryable: true,
      reauthenticate: false,
      requestId: error.requestId,
    };
  }

  if (error instanceof ApiError && error.status === 401) {
    return {
      title: 'Sign-in failed',
      detail: 'Those credentials were not accepted. Check them and try again.',
      retryable: true,
      reauthenticate: false,
      requestId: error.requestId,
    };
  }

  return toAgentMessage(error);
}
