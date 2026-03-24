import { NextResponse } from 'next/server';
import { getVectorStore } from '@/lib/vectorStore';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';

// WIDE-NET RAG: Large enough to catch broken tables, small enough to stay under the 1M token limit.
const TOP_K_RESULTS = 30; 

export async function POST(req) {
    try {
        const { messages } = await req.json();
        const latestMessage = messages[messages.length - 1].text;

        const currentVectorStore = getVectorStore();
        if (!currentVectorStore || currentVectorStore.memoryVectors.length === 0) {
            return NextResponse.json(
                { error: 'No catalog data found. Upload a PDF first.' },
                { status: 400 }
            );
        }

        // 1. HYBRID RAG: Retrieve the top 30 most relevant chunks based on the user's question
        const relevantDocs = await currentVectorStore.similaritySearch(latestMessage, TOP_K_RESULTS);
        
        // 2. Combine only the relevant chunks (Keeps us way under the 1M token limit)
        const contextStr = relevantDocs.map(doc => doc.pageContent).join('\n\n---\n\n');

        // 3. Initialize Gemini 2.0 Flash
        const model = new ChatGoogleGenerativeAI({
            model: 'gemini-2.0-flash',
            temperature: 0.1,
            streaming: true,
        });

        // 4. Build the strict System Prompt
        const systemPrompt = `ROLE: You are the Reshapex Industrial Sales Engineer. Your purpose is to provide hyper-accurate technical assistance based solely on the provided industrial documentation.

OPERATIONAL CONSTRAINTS:
1. SOURCE-ONLY TRUTH: If the specific technical data is not explicitly contained in the provided manual, state: "The provided documentation lists the part numbers for these components, but does not specify the exact performance differences between them. I recommend consulting the ABICOR BINZEL engineering specifications for deeper mechanical comparisons." Do not guess.
2. INDUSTRIAL PRECISION: Format all numerical data exactly as they appear in the source.

CONTEXT:
${contextStr}`;

        // 5. Stream using the crash-proof StringOutputParser
        const stream = await model.pipe(new StringOutputParser()).stream([
            new SystemMessage(systemPrompt),
            new HumanMessage(latestMessage)
        ]);

        const encoder = new TextEncoder();
        const readableStream = new ReadableStream({
            async start(controller) {
                for await (const chunk of stream) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            }
        });

        return new Response(readableStream, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-cache'
            }
        });

    } catch (error) {
        console.error('SERVER ERROR - /api/chat:', error);
        return NextResponse.json(
            { error: `API Error: ${error.message}` },
            { status: 500 }
        );
    }
}
