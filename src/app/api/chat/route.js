import { NextResponse } from 'next/server';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { PromptTemplate } from '@langchain/core/prompts';
import { HttpResponseOutputParser } from 'langchain/output_parsers';
import { getVectorStore } from '@/lib/vectorStore';
import { RunnableSequence } from '@langchain/core/runnables';

/** Number of top similar chunks to retrieve from the vector store. */
const TOP_K_RESULTS = 4;

export async function POST(req) {
    try {
        if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY.includes('your_google_api_key_here')) {
            return NextResponse.json(
                { error: 'CRITICAL: You must replace "your_google_api_key_here" in your .env.local file with a real Google Gemini API Key.' },
                { status: 401 }
            );
        }

        const { messages } = await req.json();

        if (!messages || messages.length === 0) {
            return NextResponse.json({ error: 'No messages provided.' }, { status: 400 });
        }

        // Extract the latest query from the user
        // We assume the messages array follows a standard format: [{ role: 'user' | 'ai', text: string }]
        const latestMessage = messages[messages.length - 1];
        const query = latestMessage.text;

        // 1. Validate Vector Store
        // Fetch the freshest instance to prevent stale references after uploads
        const currentVectorStore = getVectorStore();

        if (!currentVectorStore || currentVectorStore.memoryVectors.length === 0) {
            return NextResponse.json(
                { error: 'No catalog data found. Please return to Step 1 and upload a product catalog first.' },
                { status: 400 }
            );
        }

        // 2. Similarity Search (RAG)
        // Perform a similarity search against the in-memory vector store using the query
        // Retrieve the top K most relevant chunks
        const relevantChunks = await currentVectorStore.similaritySearch(query, TOP_K_RESULTS);


        // Combine the content of those chunks into a single context string
        const contextStr = relevantChunks.map((doc) => doc.pageContent).join('\n\n---\n\n');

        // 3. Construct Master Prompt — CRO-approved anti-hallucination guardrails
        const systemPromptTemplate = `
ROLE: You are the Reshapex Industrial Sales Engineer. Your purpose is to provide hyper-accurate technical assistance based solely on the provided industrial documentation (PDFs, BOMs, RFPs).

OPERATIONAL CONSTRAINTS:
1. SOURCE-ONLY TRUTH: If the information is not explicitly stated in the provided context, state: "That specific technical detail is not available in the current documentation." Do not guess or use general knowledge.
2. INDUSTRIAL PRECISION: Format all numerical data (measurements, tolerances, SKU numbers) exactly as they appear in the source.
3. CPQ ALIGNMENT: Prioritize answering questions related to configuration, pricing, and quantities to mirror Reshapex's core value proposition.
4. TONE: Professional, elite, and concise. No conversational filler.

RESPONSE STRUCTURE:
- Direct Answer (Bolded with **)
- Technical Reference (Page # or Section Name from the source)
- Immediate Next Step for the Procurement/Engineering team.

CONTEXT:
{context}

USER QUESTION:
{question}
    `;

        const prompt = PromptTemplate.fromTemplate(systemPromptTemplate);

        // 4. Initialize LLM Model
        const model = new ChatGoogleGenerativeAI({
            model: 'gemini-1.5-flash',
            temperature: 0.1, // Keep it deterministic for factual catalog queries
            streaming: true, // Crucial for streaming the response
        });

        // 5. Build Runnable Pipeline
        const outputParser = new HttpResponseOutputParser();

        // We form a LangChain conceptual chain (RunnableSequence)
        const chain = RunnableSequence.from([
            prompt,
            model,
            outputParser,
        ]);

        // 6. Stream the Response
        const stream = await chain.stream({
            context: contextStr,
            question: query,
        });

        // Next.js App Router streaming standard
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream"
            }
        });

    } catch (error) {
        console.error('SERVER ERROR - /api/chat:', error);
        return NextResponse.json(
            { error: error.message || 'An error occurred while generating the chat response.' },
            { status: 500 }
        );
    }
}
