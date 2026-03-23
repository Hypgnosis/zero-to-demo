import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

/** Gemini embedding model used for document vectorization. */
const EMBEDDING_MODEL = "text-embedding-004";

/**
 * Creates a fresh GoogleGenerativeAIEmbeddings instance.
 * Automatically reads the GOOGLE_API_KEY environment variable.
 */
function createEmbeddings() {
    return new GoogleGenerativeAIEmbeddings({ modelName: EMBEDDING_MODEL });
}

// In Next.js (especially development mode), API routes can be re-compiled, leading to state loss.
// By attaching the store to the global object, we ensure the MemoryVectorStore persists
// across different API requests (like /upload and /chat) and hot-reloads.
const globalForStore = globalThis;

if (!globalForStore.vectorStore) {
    globalForStore.vectorStore = new MemoryVectorStore(createEmbeddings());
}

/** The persistent in-memory vector store singleton. */
export const vectorStore = globalForStore.vectorStore;

/**
 * Creates a fresh vector store, replacing the global singleton.
 * Call this when a new document is uploaded to clear previous session data.
 * @returns {MemoryVectorStore} The newly created vector store instance.
 */
export const resetVectorStore = () => {
    globalForStore.vectorStore = new MemoryVectorStore(createEmbeddings());
    return globalForStore.vectorStore;
};
