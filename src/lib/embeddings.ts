/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Embedding Generation
 * Uses @google/genai SDK directly (no LangChain wrappers).
 * Generates vector embeddings via gemini-embedding-001.
 * ═══════════════════════════════════════════════════════════════════
 */

import { GoogleGenAI } from '@google/genai';

const EMBEDDING_MODEL = 'gemini-embedding-001';

/** Concurrency limit for parallel embedding calls. */
const CONCURRENCY_LIMIT = 5;

/* ─── Singleton Client ────────────────────────────────────────── */

let aiClient: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY must be set.');
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

/* ─── Single Embedding ────────────────────────────────────────── */

/**
 * Generates an embedding for a single text string.
 */
export async function embedText(text: string): Promise<number[]> {
  const ai = getAI();
  const result = await ai.models.embedContent({
    model: EMBEDDING_MODEL,
    contents: text,
  });

  if (!result.embeddings || result.embeddings.length === 0) {
    throw new Error('Embedding generation returned no results.');
  }

  const values = result.embeddings[0]?.values;
  if (!values) {
    throw new Error('Embedding values are undefined.');
  }

  return values;
}

/* ─── Batch Embeddings ────────────────────────────────────────── */

/**
 * Generates embeddings for multiple texts with controlled concurrency.
 * Does NOT use inlineData for large payloads — processes text-only.
 *
 * @param texts - Array of text strings to embed.
 * @returns Array of embedding vectors in the same order as input.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);

  // Process in batches with concurrency limit
  for (let i = 0; i < texts.length; i += CONCURRENCY_LIMIT) {
    const batch = texts.slice(i, i + CONCURRENCY_LIMIT);
    const batchPromises = batch.map((text, batchIndex) =>
      embedText(text).then((embedding) => {
        results[i + batchIndex] = embedding;
      })
    );
    await Promise.all(batchPromises);
  }

  return results;
}

/* ─── Google GenAI Client Export (for File API usage) ──────────── */

/**
 * Returns the singleton GoogleGenAI client for use with the File API.
 * Used by the document processing webhook.
 */
export function getGenAIClient(): GoogleGenAI {
  return getAI();
}
