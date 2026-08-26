import { NextResponse } from 'next/server';
import { healthPayload } from '@/lib/health';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json(healthPayload());
}
