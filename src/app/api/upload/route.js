import { NextResponse } from 'next/server';
import pdfParse from 'pdf-parse';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import { resetVectorStore } from '@/lib/vectorStore';

/** Maximum characters per text chunk for vectorization. */
const CHUNK_SIZE = 50000;
/** Number of overlapping characters between adjacent chunks to preserve context. */
const CHUNK_OVERLAP = 10000;


export async function POST(request) {
    try {
        // 1. Parse Multipart Form Data
        const formData = await request.formData();
        const file = formData.get('file');

        if (!process.env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY.includes('your_google_api_key_here')) {
            return NextResponse.json(
                { error: 'CRITICAL: You must replace "your_google_api_key_here" in your .env.local file with a real Google Gemini API Key before uploading.' },
                { status: 401 }
            );
        }

        if (!file) {
            return NextResponse.json(
                { error: 'No PDF file found in upload.' },
                { status: 400 }
            );
        }

        // 2. Buffer Conversion
        // We convert the file's binary stream (Web Blob format) into a Node.js Buffer
        // so that the `pdf-parse` library can natively process it.
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        // 3. Document Parsing
        const pdfData = await pdfParse(buffer);
        const rawText = pdfData.text;

        if (!rawText || !rawText.trim()) {
            return NextResponse.json(
                { error: 'Could not extract textual content from the uploaded PDF.' },
                { status: 400 }
            );
        }

        // 4. Text Chunking
        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: CHUNK_SIZE,
            chunkOverlap: CHUNK_OVERLAP,
        });


        // Create LangChain Document objects with metadata
        const chunks = await textSplitter.createDocuments(
            [rawText],
            [{ source: file.name }]
        );

        // 5. In-Memory Vector Store Insertion
        // Reset the global vector store to clear data from previous demo sessions
        const vectorStore = resetVectorStore();

        // Add documents. This will automatically execute the OpenAI Embeddings API request.
        await vectorStore.addDocuments(chunks);

        return NextResponse.json({
            success: true,
            message: 'PDF successfully vectorized and deployed to memory.',
            chunksProcessed: chunks.length,
        });
    } catch (error) {
        console.error('SERVER ERROR - /api/upload:', error);
        return NextResponse.json(
            { error: error.message || 'An error occurred while parsing the document.' },
            { status: 500 }
        );
    }
}
