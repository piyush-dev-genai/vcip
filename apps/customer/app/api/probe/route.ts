/**
 * Throughput probe for the preflight downlink measurement.
 *
 * `navigator.connection.downlink` exists only in Chromium. Without it the
 * choice is between inventing a number and measuring one, and D11 makes that an
 * easy call: this route returns a fixed block of bytes so the browser can time a
 * real transfer.
 *
 * It is same-origin, so it needs no CORS and carries no credential. It holds no
 * state, reads no database, and returns constant filler — there is nothing here
 * to leak and nothing to authorise.
 *
 * The transfer it enables is a *lower bound*, not a throughput measurement:
 * 128 KB is too small for TCP to leave slow start, so a fast connection
 * measures slower than it is. Under-reporting is the safe direction for a gate
 * whose thresholds are minimums.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Matches `THROUGHPUT_PROBE_BYTES` in `lib/measure.ts`. */
const DEFAULT_BYTES = 131072;
const MAX_BYTES = 1048576;

export function GET(request: Request): NextResponse {
  const requested = Number(new URL(request.url).searchParams.get('bytes'));
  const size =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.trunc(requested), MAX_BYTES)
      : DEFAULT_BYTES;

  // Zero-filled: the payload's content is irrelevant, only its size and the
  // time it takes to arrive. Note that a compressing proxy would shrink this
  // and make the measurement optimistic — `Content-Encoding: identity` asks
  // every hop to leave it alone.
  const body = new Uint8Array(size);

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Encoding': 'identity',
      'Cache-Control': 'no-store, no-transform',
    },
  });
}
