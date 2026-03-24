import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";

/** Gemini embedding model used for document vectorization. */
const EMBEDDING_MODEL = "gemini-embedding-001";

/**
 * Creates a fresh GoogleGenerativeAIEmbeddings instance.
 * Automatically reads the GOOGLE_API_KEY environment variable.
 */
function createEmbeddings() {
    return new GoogleGenerativeAIEmbeddings({ model: EMBEDDING_MODEL });
}

// In Next.js (especially development mode), API routes can be re-compiled, leading to state loss.
// By attaching the store to the global object, we ensure the MemoryVectorStore persists
// across different API requests (like /upload and /chat) and hot-reloads.
const globalForStore = globalThis;

/**
 * GETTER: Always fetches the most current global vector store.
 * Prevents stale references when the store is reset during uploads.
 * @returns {MemoryVectorStore} The current vector store instance.
 */
export const getVectorStore = () => {
    if (!globalForStore.vectorStore) {
        globalForStore.vectorStore = new MemoryVectorStore(createEmbeddings());
    }
    return globalForStore.vectorStore;
};

/**
 * Creates a fresh vector store, replacing the global singleton.
 * Call this when a new document is uploaded to clear previous session data.
 * @returns {MemoryVectorStore} The newly created vector store instance.
 */
export const resetVectorStore = () => {
    globalForStore.vectorStore = new MemoryVectorStore(createEmbeddings());
    return globalForStore.vectorStore;
};

