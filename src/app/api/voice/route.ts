/**
 * ═══════════════════════════════════════════════════════════════════
 * POST /api/voice
 *
 * Phase 5 — Voice Proxy Handshake
 * Returns the WebSocket proxy URL with session context.
 * The actual WebSocket runs on Cloud Run (not Vercel).
 * ═══════════════════════════════════════════════════════════════════
 */

import { NextResponse } from 'next/server';
import { SignJWT } from 'jose';

import { withErrorHandler, Errors } from '@/lib/errors';
import { VoiceHandshakeSchema } from '@/lib/validation';
import { getSession } from '@/lib/redis';
import { namespaceHasVectors } from '@/lib/vectorClient';

export const POST = withErrorHandler(async (req: Request) => {
  // 1. Validate request
  const body = await req.json();
  const parseResult = VoiceHandshakeSchema.safeParse(body);

  if (!parseResult.success) {
    throw Errors.validation(parseResult.error.issues[0]?.message ?? 'Invalid request.');
  }

  const { sessionId, lang } = parseResult.data;

  // 2. Verify session exists
  const session = await getSession(sessionId);
  if (!session) {
    throw Errors.notFound('Session');
  }

  // 3. Verify namespace has vectors
  const hasVectors = await namespaceHasVectors(sessionId);
  if (!hasVectors) {
    throw Errors.noVectorData();
  }

  // 4. Get voice proxy URL
  const proxyUrl = process.env.VOICE_PROXY_URL;
  if (!proxyUrl) {
    throw Errors.configMissing('VOICE_PROXY_URL');
  }

  // 5. Sign a short-lived (5m) JWT ticket for the Cloud Run proxy
  const secret = process.env.VOICE_PROXY_SECRET || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!secret) {
    throw Errors.configMissing('VOICE_PROXY_SECRET');
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
