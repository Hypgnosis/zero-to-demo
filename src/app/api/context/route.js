import { NextResponse } from 'next/server';
import { getVectorStore } from '@/lib/vectorStore';

/**
 * GET /api/context
 * Returns the full catalog text and the API key for the voice agent.
 * The API key is needed because Next.js cannot proxy WebSockets natively.
 */
export async function GET() {
    try {
        const apiKey = process.env.GOOGLE_API_KEY;
        if (!apiKey || apiKey.includes('your_google_api_key_here')) {
            return NextResponse.json(
                { error: 'GOOGLE_API_KEY is not configured.' },
                { status: 500 }
            );
        }

        const store = getVectorStore();

        if (!store || store.memoryVectors.length === 0) {
            return NextResponse.json(
                { error: 'No catalog data found. Upload a PDF first.' },
                { status: 400 }
            );
        }

        const fullText = store.memoryVectors.map(v => v.content).join('\n\n');

        return NextResponse.json({ context: fullText, apiKey });
    } catch (error) {
        console.error('SERVER ERROR - /api/context:', error);
        return NextResponse.json(
            { error: 'Failed to retrieve context.' },
            { status: 500 }
        );
    }
}
