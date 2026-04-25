/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-G — Global Configuration Registry
 * ═══════════════════════════════════════════════════════════════════
 */

export const CONFIG = {
  /** 
   * Unified Base URL Resolution 
   * Priority: ENV > Vercel > Netlify > Localhost
   */
  get baseUrl() {
    if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
    if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
    // Netlify provides URL or DEPLOY_URL in certain contexts
    if (process.env.URL) return process.env.URL;
    return 'http://localhost:3000';
  },

  /** 
   * Vector Metadata Constraints 
   * Reduced from 30k to 3k to prevent 413 Payload Too Large and 
   * excessive network latency during upsert.
   */
  MAX_MACRO_TEXT_BYTES: 3000,
  
  /** QStash Configuration */
  QSTASH_TOKEN: process.env.QSTASH_TOKEN,
  
  /** GenAI Model Versions */
  MODELS: {
    EMBEDDING: 'gemini-embedding-001',
    EXTRACTOR: 'gemini-2.5-flash',
  }
};
