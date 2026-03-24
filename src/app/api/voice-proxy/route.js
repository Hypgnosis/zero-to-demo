import { NextResponse } from 'next/server';

export const runtime = 'edge';

/**
 * GET /api/voice-proxy
 * Secure WebSocket proxy that upgrades the incoming HTTP request to a WebSocket,
 * connects to the Gemini Live API with the server-side API key, and pipes data
 * bidirectionally. The browser never sees GOOGLE_API_KEY.
 */
export async function GET(request) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        return new Response("API key missing", { status: 500 });
    }

    // Upgrade the incoming HTTP request to a WebSocket
    if (request.headers.get("upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    const targetUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    // Connect to Google securely on the server side
    const targetWs = new WebSocket(targetUrl);

    // Pipe client messages to Google
    server.accept();
    server.addEventListener("message", (event) => {
        if (targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(event.data);
        }
    });

    // Pipe Google messages to client
    targetWs.addEventListener("message", (event) => {
        if (server.readyState === WebSocket.OPEN) {
            server.send(event.data);
        }
    });

    targetWs.addEventListener("close", () => server.close());
    server.addEventListener("close", () => targetWs.close());

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
