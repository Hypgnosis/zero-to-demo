import { NextResponse } from 'next/server';
import { getVectorStore } from '@/lib/vectorStore';

/**
 * GET /api/context
 * Returns the full text of all uploaded documents from the in-memory vector store.
 * Does NOT expose the API key — the voice proxy handles authentication server-side.
 */
export async function GET() {
    try {
        const store = getVectorStore();

        if (!store || store.memoryVectors.length === 0) {
            return NextResponse.json(
                { error: 'No catalog data found. Upload a PDF first.' },
                { status: 400 }
            );
        }

        // Combine all chunks back into a single reference string
        const fullText = store.memoryVectors.map(v => v.content).join('\n\n');

        // Return ONLY the context. The API key is never sent to the client.
        return NextResponse.json({ context: fullText });
    } catch (error) {
        console.error('SERVER ERROR - /api/context:', error);
        return NextResponse.json(
            { error: 'Failed to retrieve context.' },
            { status: 500 }
        );
    }
}
