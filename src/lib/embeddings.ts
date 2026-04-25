/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — AI Client + Embedding Generation + File Upload
 *
 * Uses the unified @google/genai SDK for embeddings & generation,
 * plus a direct REST upload for the File API (bypasses SDK upload
 * bug with new AQ-prefix API keys).
 * ═══════════════════════════════════════════════════════════════════
 */


import { CONFIG } from './config';
import { createLimiter } from './concurrency';

export type { Content } from '@google/genai';

const EMBEDDING_MODEL = CONFIG.MODELS.EMBEDDING;

/* ─── API Key ─────────────────────────────────────────────────── */

export function getApiKey(): string {
  const key = process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error('Neither GOOGLE_GENAI_API_KEY nor GOOGLE_API_KEY is set.');
  }
  return key;
}

/* ─── Singleton Client ────────────────────────────────────────── */

// SDK decoupled in favor of direct REST

/* ─── Single Embedding ────────────────────────────────────────── */

export async function embedText(text: string): Promise<number[]> {
  const apiKey = getApiKey();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Embedding generation failed (${res.status}): ${errText}`);
  }

  const result = await res.json();
  const values = result.embedding?.values;
  if (!values || values.length === 0) {
    throw new Error('Embedding generation returned no results.');
  }

  return values;
}

/* ─── Batch Embeddings (Single REST Call) ─────────────────────── */

const BATCH_LIMIT = 100; // Max texts per batchEmbedContents call

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = getApiKey();
  const batches = [];
  for (let i = 0; i < texts.length; i += BATCH_LIMIT) {
    batches.push(texts.slice(i, i + BATCH_LIMIT));
  }

  // Bounded concurrency: max 5 simultaneous GenAI API calls to prevent
  // 429 rate-limit storms during large document ingestion.
  const limit = createLimiter(5);
  const batchPromises = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    batchPromises.push(limit(async () => {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: batch.map((text: string) => ({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
          })),
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Batch embedding failed (${res.status}): ${errText}`);
      }
      const data = await res.json();
      return data.embeddings.map((e: any) => e.values);
    }));
  }

  console.log(`[Embeddings] Embedding ${texts.length} texts in ${batches.length} batches (concurrency=5)`);
  const results = await Promise.all(batchPromises);

  return results.flat();
}

/* ─── GenAI Client Export (for Chat / Processing) ─────────────── */


/* ═══════════════════════════════════════════════════════════════════
 * DIRECT REST FILE UPLOAD
 *
 * The @google/genai SDK's files.upload() sends a malformed auth
 * header with AQ-prefix keys, resulting in a 401. We bypass the SDK
 * entirely and call the resumable upload REST endpoint directly.
 *
 * Protocol: Google's resumable upload (two-step):
 *   Step 1: POST metadata → get upload URI
 *   Step 2: PUT binary data to the upload URI
 * ═══════════════════════════════════════════════════════════════════ */

interface UploadedFileRef {
  name: string;        // e.g. "files/abc123def"
  uri: string;         // Full URI for use with generateContent
  displayName: string;
  mimeType: string;
  state: string;
}

/**
 * Uploads a file to the Google GenAI File API using direct REST.
 * Bypasses the SDK's broken upload auth for AQ-prefix keys.
 */
export async function uploadFileToGenAI(
  fileBuffer: Buffer,
  mimeType: string,
  displayName: string,
): Promise<UploadedFileRef> {
  const apiKey = getApiKey();
  const baseUrl = 'https://generativelanguage.googleapis.com';

  // Step 1: Initiate resumable upload — get the upload URI
  const initiateRes = await fetch(
    `${baseUrl}/upload/v1beta/files?key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(fileBuffer.byteLength),
        'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({
        file: { displayName },
      }),
    }
  );

  if (!initiateRes.ok) {
    const errText = await initiateRes.text();
    throw new Error(
      `GenAI File upload initiation failed (${initiateRes.status}): ${errText}`
    );
  }

  const uploadUrl = initiateRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('GenAI File upload initiation did not return an upload URL.');
  }

  // Step 2: Upload the actual bytes
  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Length': String(fileBuffer.byteLength),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: new Uint8Array(fileBuffer),
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    throw new Error(
      `GenAI File upload failed (${uploadRes.status}): ${errText}`
    );
  }

  const result = await uploadRes.json();

  return {
    name: result.file.name,
    uri: result.file.uri,
    displayName: result.file.displayName,
    mimeType: result.file.mimeType,
    state: result.file.state,
  };
}

/**
 * Deletes a file from the Google GenAI File API.
 */
export async function deleteGenAIFile(fileName: string): Promise<void> {
  const apiKey = getApiKey();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
    { method: 'DELETE' }
  );
  if (!res.ok) {
    console.warn(`[AI] File deletion failed for ${fileName}: ${res.status}`);
  }
}

/**
 * Gets file metadata from the Google GenAI File API.
 */
export async function getGenAIFile(fileName: string): Promise<UploadedFileRef> {
  const apiKey = getApiKey();
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GenAI getFile failed (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return {
    name: data.name,
    uri: data.uri,
    displayName: data.displayName,
    mimeType: data.mimeType,
    state: data.state,
  };
}
