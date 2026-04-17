/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Embedding Generation
 * Uses the stable @google/generative-ai SDK.
 * ═══════════════════════════════════════════════════════════════════
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

const EMBEDDING_MODEL = 'text-embedding-004';

let aiClient: GoogleGenerativeAI | null = null;

function getAI(): GoogleGenerativeAI {
  if (!aiClient) {
    const apiKey = process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('Neither GOOGLE_GENAI_API_KEY nor GOOGLE_API_KEY is set in environment.');
    }
    console.log(`[AI] Initializing Stable Client with key prefix: ${apiKey.substring(0, 4)}...`);
    aiClient = new GoogleGenerativeAI(apiKey);
  }
  return aiClient;
}

export async function embedText(text: string): Promise<number[]> {
  const ai = getAI();
  const model = ai.getGenerativeModel({ model: EMBEDDING_MODEL });
  const result = await model.embedContent(text);

  if (!result.embedding || !result.embedding.values) {
    throw new Error('Embedding generation failed.');
  }

  return result.embedding.values;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  // Simple map for now, the SDK handles some batching internally
  return Promise.all(texts.map(t => embedText(t)));
}

export function getGenAIClient(): GoogleGenerativeAI {
  return getAI();
}
