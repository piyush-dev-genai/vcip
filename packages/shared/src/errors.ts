/**
 * Domain and API error codes, and the error envelope from
 * `docs/05-api-contract.md` §6.
 *
 * Pure: this module defines the vocabulary and the shape. Mapping a thrown
 * `DomainError` onto an HTTP response is the Control API's exception filter,
 * which does not live here.
 */

/**
 * Codes carried in the `error.code` field of every API error response.
 *
 * The three `SESSION_*` codes are named in the API contract. The rest are the
 * generic codes for the HTTP statuses the contract's §6 table documents; the
 * envelope requires a `code` for those responses too.
 */
export const ErrorCode = {
  // --- documented domain codes -------------------------------------------
  /** The session cannot make the requested transition from its current status. */
  SESSION_INVALID_STATE: 'SESSION_INVALID_STATE',
  /** Consent, preflight, or location has not passed, so the session cannot queue. */
  SESSION_NOT_ELIGIBLE_FOR_QUEUE: 'SESSION_NOT_ELIGIBLE_FOR_QUEUE',
  /** Another agent won the claim. The conditional UPDATE affected zero rows. See D5. */
  SESSION_ALREADY_ASSIGNED: 'SESSION_ALREADY_ASSIGNED',

  // --- generic codes for the documented statuses -------------------------
  /** 400 — the request did not parse or failed schema validation. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** 401 — authentication is missing or invalid. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** 403 — authenticated, but not permitted. Includes cross-tenant access. */
  FORBIDDEN: 'FORBIDDEN',
  /** 404 — no such resource within this tenant. */
  NOT_FOUND: 'NOT_FOUND',
  /** 409 — state conflict or duplicate operation. */
  CONFLICT: 'CONFLICT',
  /** 422 — well-formed, but a business rule rejected it. */
  UNPROCESSABLE: 'UNPROCESSABLE',
  /** 429 — rate limited. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 500 — unexpected server fault. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** 503 — a dependency is temporarily unavailable. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODES: readonly ErrorCode[] = Object.freeze(Object.values(ErrorCode));

/**
 * The HTTP status each code is served with. Statuses come from the §6 table.
 *
 * `SESSION_NOT_ELIGIBLE_FOR_QUEUE` is 422 rather than 409: the request is
 * well-formed and the session exists, but a business precondition is unmet.
 */
export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  [ErrorCode.SESSION_INVALID_STATE]: 409,
  [ErrorCode.SESSION_NOT_ELIGIBLE_FOR_QUEUE]: 422,
  [ErrorCode.SESSION_ALREADY_ASSIGNED]: 409,

  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.UNPROCESSABLE]: 422,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.SERVICE_UNAVAILABLE]: 503,
});

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export function httpStatusForErrorCode(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}

/**
 * The wire shape of an API error, exactly as `docs/05-api-contract.md` §6
 * specifies. Snake case here is deliberate — it is the JSON contract, not
 * internal TypeScript style.
 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly request_id: string;
  };
}

/**
 * A business-rule failure raised by domain code.
 *
 * Carries only the code, a safe message, and optional non-sensitive details.
 * It never carries the offending payload: these errors are logged, and the
 * sensitive-data boundary says request bodies do not reach the log.
 */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Readonly<Record<string, string | number | boolean>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.httpStatus = ERROR_HTTP_STATUS[code];
    this.details = details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/** Build the documented envelope. Pure — the caller supplies the request id. */
export function toApiErrorBody(code: ErrorCode, message: string, requestId: string): ApiErrorBody {
  return { error: { code, message, request_id: requestId } };
}
