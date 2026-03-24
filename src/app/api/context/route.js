import { NextResponse } from 'next/server';
import { getVectorStore } from '@/lib/vectorStore';

/**
 * GET /api/context
 * Returns the full text of all uploaded documents from the in-memory vector store,
 * plus the API key needed for the client-side Gemini WebSocket connection.
 */
export async function GET() {
    try {
        if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY.includes('your_google_api_key_here')) {
            return NextResponse.json(
                { error: 'API key not configured.' },
                { status: 401 }
            );
        }

        const store = getVectorStore();

        if (!store || store.memoryVectors.length === 0) {
            return NextResponse.json(
                { error: 'No catalog data found. Upload a PDF first.' },
                { status: 400 }
            );
        }

        // Combine all chunks back into a single reference string
        const fullText = store.memoryVectors.map(v => v.content).join('\n\n');

        return NextResponse.json({
            context: fullText,
            apiKey: process.env.GOOGLE_API_KEY,
        });
    } catch (error) {
        console.error('SERVER ERROR - /api/context:', error);
        return NextResponse.json(
            { error: error.message || 'Failed to retrieve context.' },
            { status: 500 }
        );
    }
}
