/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/voice
 *
 * Phase 5 — Voice Proxy Handshake (Phase 1 Hardened)
 * 1. AUTHENTICATES via JWT PEP (Finding 1 Remedy).
 * 2. Validates session ownership.
 * 3. Signs a short-lived (5m) JWT ticket for the Cloud Run proxy.
 * 4. Returns the WebSocket proxy URL with embedded ticket.
 *
 * Finding 7 Remedy: VOICE_PROXY_SECRET is now REQUIRED.
 * No fallback to UPSTASH_REDIS_REST_TOKEN — fail closed.
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { SignJWT } from 'jose';

import { withErrorHandler, Errors } from '@/lib/errors';
import { authenticateRequest } from '@/lib/auth';
import { VoiceHandshakeSchema } from '@/lib/validation';
import { validateSessionOwnership } from '@/lib/redis';
import { namespaceHasVectors } from '@/lib/vectorClient';

export const POST = withErrorHandler(async (req: Request) => {
  // 1. AUTHENTICATE — Implicit Deny (Finding 1)
  const claims = await authenticateRequest(req);

  // 2. Validate request
  const body = await req.json();
  const parseResult = VoiceHandshakeSchema.safeParse(body);

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid request.');
  }

  const { sessionId, lang } = parseResult.data;

  // 3. Validate session ownership — returns session with mode
  const session = await validateSessionOwnership(sessionId, claims.userId);

  // 4. Verify namespace has vectors (on the correct physical index)
  const hasVectors = await namespaceHasVectors(sessionId, session.mode);
  if (!hasVectors) {
    throw Errors.noVectorData();
  }

  // 5. Get voice proxy URL
  const proxyUrl = process.env.VOICE_PROXY_URL;
  if (!proxyUrl) {
    throw Errors.configMissing('VOICE_PROXY_URL');
  }

  // 6. Sign a short-lived (5m) JWT ticket for the Cloud Run proxy.
  //    Finding 7 Remedy: VOICE_PROXY_SECRET is REQUIRED.
  //    NO FALLBACK to UPSTASH_REDIS_REST_TOKEN — separate trust boundaries.
  const secret = process.env.VOICE_PROXY_SECRET;
  if (!secret) {
    throw Errors.configMissing(
      'VOICE_PROXY_SECRET (dedicated secret required — cannot reuse Redis credentials)'
    );
  }
  const secretKey = new TextEncoder().encode(secret);
  
  const token = await new SignJWT({ sessionId, lang })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secretKey);

  const wsUrl = `${proxyUrl}/ws?token=${token}`;

  return NextResponse.json({
    wsUrl,
    sessionId,
    lang,
  });
});
