/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Voice Proxy Server (Cloud Run)
 *
 * Fastify WebSocket server that:
 * 1. Accepts client WS connections from the frontend.
 * 2. Fetches session context from Upstash Vector.
 * 3. Opens a WS connection to Gemini Live API.
 * 4. Bridges audio bidirectionally.
 *
 * The API key NEVER leaves this server.
 * ═══════════════════════════════════════════════════════════════════
 */

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { Index } from '@upstash/vector';
import { jwtVerify } from 'jose';

/* ─── Types ───────────────────────────────────────────────────── */

interface VectorMetadata {
  source: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  [key: string]: unknown;
}

/* ─── Environment ─────────────────────────────────────────────── */

const PORT = parseInt(process.env.PORT || '8080', 10);
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const VOICE_MODEL = process.env.VOICE_MODEL || 'models/gemini-2.5-flash-native-audio-latest';
const UPSTASH_VECTOR_REST_URL = process.env.UPSTASH_VECTOR_REST_URL;
const UPSTASH_VECTOR_REST_TOKEN = process.env.UPSTASH_VECTOR_REST_TOKEN;
const VOICE_PROXY_SECRET = process.env.VOICE_PROXY_SECRET || process.env.UPSTASH_REDIS_REST_TOKEN;
const MAX_CONTEXT_CHUNKS = 30;

/* ─── Validation ──────────────────────────────────────────────── */

if (!GOOGLE_API_KEY) {
  console.error('FATAL: GOOGLE_API_KEY is not set.');
  process.exit(1);
}

if (!UPSTASH_VECTOR_REST_URL || !UPSTASH_VECTOR_REST_TOKEN) {
  console.error('FATAL: UPSTASH_VECTOR_REST_URL and UPSTASH_VECTOR_REST_TOKEN must be set.');
  process.exit(1);
}

if (!VOICE_PROXY_SECRET) {
  console.error('FATAL: VOICE_PROXY_SECRET or UPSTASH_REDIS_REST_TOKEN must be set for JWT verification.');
  process.exit(1);
}

/* ─── Upstash Vector Client ──────────────────────────────────── */

const vectorIndex = new Index({
  url: UPSTASH_VECTOR_REST_URL,
  token: UPSTASH_VECTOR_REST_TOKEN,
});

async function getSessionContext(sessionId: string): Promise<string> {
  try {
    const info = await vectorIndex.info();
    const hasNamespace = info.namespaces && info.namespaces[sessionId] && info.namespaces[sessionId].vectorCount > 0;
    
    if (!hasNamespace) return '';

    const ns = vectorIndex.namespace(sessionId);
    const results = await ns.range<VectorMetadata>({
      cursor: 0,
      limit: MAX_CONTEXT_CHUNKS,
      includeMetadata: true,
    });

    return results.vectors
      .filter((v) => v.metadata?.text)
      .map((v) => v.metadata!.text)
      .join('\n\n---\n\n');
  } catch (err) {
    console.error(`[VoiceProxy] Failed to fetch context for session ${sessionId}:`, err);
    return '';
  }
}

/* ─── Gemini Live API URL ─────────────────────────────────────── */

function getGeminiWsUrl(): string {
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GOOGLE_API_KEY}`;
}

/* ─── Fastify Server ──────────────────────────────────────────── */

const app = Fastify({ logger: true });

app.register(websocket);

/* ─── Health Check ────────────────────────────────────────────── */

app.get('/health', async () => {
  return { status: 'ok', model: VOICE_MODEL };
});

/* ─── WebSocket Endpoint ──────────────────────────────────────── */

app.register(async (fastify) => {
  fastify.get('/ws', { websocket: true }, async (socket, req) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      socket.send(JSON.stringify({ error: 'Missing token' }));
      socket.close(1008, 'Missing token');
      return;
    }

    let sessionId: string;
    let lang: string;

    try {
      const secretKey = new TextEncoder().encode(VOICE_PROXY_SECRET);
      const { payload } = await jwtVerify(token, secretKey);
      sessionId = payload.sessionId as string;
      lang = (payload.lang as string) || 'en';
    } catch (err) {
      console.error('[VoiceProxy] Invalid or expired JWT token:', err);
      socket.send(JSON.stringify({ error: 'Invalid or expired token' }));
      socket.close(1008, 'Unauthorized');
      return;
    }

    console.log(`[VoiceProxy] Client connected: session=${sessionId}, lang=${lang}`);

    // Fetch context from Upstash Vector
    const context = await getSessionContext(sessionId);

    const systemInstruction = context
      ? `You are Axiom-0, an enterprise AI assistant by High Archytech. Answer using ONLY the following catalog data. Respond in ${lang === 'es' ? 'Spanish' : 'English'}.\n\nCATALOG DATA:\n${context}`
      : `You are Axiom-0, an enterprise AI assistant by High Archytech. The user hasn't uploaded any documents yet. Let them know they should upload a PDF first. Respond in ${lang === 'es' ? 'Spanish' : 'English'}.`;

    // Open connection to Gemini Live API
    let geminiWs: WebSocket | null = null;

    try {
      geminiWs = new WebSocket(getGeminiWsUrl());
    } catch (err) {
      console.error('[VoiceProxy] Failed to connect to Gemini:', err);
      socket.send(JSON.stringify({ error: 'Failed to connect to voice service' }));
      socket.close(1011, 'Upstream connection failed');
      return;
    }

    let setupSent = false;

    geminiWs.onopen = () => {
      console.log('[VoiceProxy] Gemini WS connected');

      // Send setup message
      const setupMsg = {
        setup: {
          model: VOICE_MODEL,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: lang === 'es' ? 'Orus' : 'Puck',
                },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
        },
      };

      geminiWs!.send(JSON.stringify(setupMsg));
      setupSent = true;
    };

    geminiWs.onmessage = async (event) => {
      try {
        // Handle Blob/ArrayBuffer responses
        let rawText: string;
        if (event.data instanceof Blob) {
          rawText = await event.data.text();
        } else if (event.data instanceof ArrayBuffer) {
          rawText = new TextDecoder().decode(event.data);
        } else {
          rawText = String(event.data);
        }

        // Forward to client
        socket.send(rawText);
      } catch (err) {
        console.error('[VoiceProxy] Error forwarding Gemini message:', err);
      }
    };

    geminiWs.onerror = (err) => {
      console.error('[VoiceProxy] Gemini WS error:', err);
      socket.send(JSON.stringify({ error: 'Voice service error' }));
    };

    geminiWs.onclose = (event) => {
      console.log(`[VoiceProxy] Gemini WS closed: code=${event.code}, reason=${event.reason}`);
      if (socket.readyState === 1) {
        socket.close(1000, 'Upstream closed');
      }
    };

    // Forward client messages to Gemini
    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (geminiWs && geminiWs.readyState === 1) {
        geminiWs.send(data.toString());
      }
    });

    // Handle client disconnect
    socket.on('close', () => {
      console.log(`[VoiceProxy] Client disconnected: session=${sessionId}`);
      if (geminiWs && geminiWs.readyState <= 1) {
        geminiWs.close(1000, 'Client disconnected');
      }
    });

    socket.on('error', (err: unknown) => {
      console.error(`[VoiceProxy] Client socket error: session=${sessionId}`, err);
      if (geminiWs && geminiWs.readyState <= 1) {
        geminiWs.close(1011, 'Client error');
      }
    });
  });
});

/* ─── Start ───────────────────────────────────────────────────── */

app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`[VoiceProxy] Listening on ${address}`);
});
