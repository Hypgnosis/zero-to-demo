/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Recursive Character Text Splitter
 * Zero-dependency replacement for LangChain's RecursiveCharacterTextSplitter.
 * Chunk size: 1000 chars, Overlap: 200 chars (per mandate).
 * ═══════════════════════════════════════════════════════════════════
 */

export interface TextChunk {
  text: string;
  index: number;
  metadata: {
    source: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

export interface SplitterConfig {
  chunkSize: number;
  chunkOverlap: number;
  separators?: string[];
}

const DEFAULT_CONFIG: SplitterConfig = {
  chunkSize: 1000,
  chunkOverlap: 200,
  separators: ['\n\n', '\n', '. ', ' ', ''],
};

/**
 * Recursively splits text using a hierarchy of separators.
 * Attempts to split on paragraph breaks first, then sentences, then words.
 */
function splitTextRecursive(
  text: string,
  separators: string[],
  chunkSize: number
): string[] {
  const finalChunks: string[] = [];

  // Find the best separator for this level
  let separator = separators[separators.length - 1] ?? '';
  let nextSeparators = separators;

  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i] ?? '';
    if (sep === '') {
      separator = sep;
      nextSeparators = separators.slice(i + 1);
      break;
    }
    if (text.includes(sep)) {
      separator = sep;
      nextSeparators = separators.slice(i + 1);
      break;
    }
  }

  // Split the text
  const splits = separator
    ? text.split(separator).filter(s => s.length > 0)
    : Array.from(text);

  // Merge small splits, recurse on large ones
  let currentChunk = '';

  for (const split of splits) {
    const candidate = currentChunk
      ? currentChunk + separator + split
      : split;

    if (candidate.length <= chunkSize) {
      currentChunk = candidate;
    } else {
      // Flush current chunk if it has content
      if (currentChunk.length > 0) {
        finalChunks.push(currentChunk);
      }

      // If individual split is still too large, recurse deeper
      if (split.length > chunkSize && nextSeparators.length > 0) {
        const subChunks = splitTextRecursive(split, nextSeparators, chunkSize);
        finalChunks.push(...subChunks);
        currentChunk = '';
      } else {
        currentChunk = split;
      }
    }
  }

  // Flush remaining
  if (currentChunk.length > 0) {
    finalChunks.push(currentChunk);
  }

  return finalChunks;
}

/**
 * Splits text into overlapping chunks with metadata.
 *
 * @param text - The raw text to split.
 * @param source - The source filename for metadata tagging.
 * @param config - Optional splitter configuration overrides.
 * @returns Array of TextChunk objects with metadata.
 */
export function splitText(
  text: string,
  source: string,
  config: Partial<SplitterConfig> = {}
): TextChunk[] {
  const { chunkSize, chunkOverlap, separators } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  // Initial recursive split (no overlap yet)
  const rawChunks = splitTextRecursive(
    text.trim(),
    separators ?? DEFAULT_CONFIG.separators!,
    chunkSize
  );

  // Apply overlap: each chunk includes the tail of the previous chunk
  const overlappedChunks: string[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i]!;

    if (i === 0) {
      overlappedChunks.push(chunk);
      continue;
    }

    // Grab overlap from end of previous raw chunk
    const prevChunk = rawChunks[i - 1]!;
    const overlapText = prevChunk.slice(-chunkOverlap);
    const withOverlap = overlapText + ' ' + chunk;

    // Only add overlap if it doesn't make the chunk unreasonably large
    if (withOverlap.length <= chunkSize * 1.5) {
      overlappedChunks.push(withOverlap);
    } else {
      overlappedChunks.push(chunk);
    }
  }

  const totalChunks = overlappedChunks.length;

  return overlappedChunks.map((text, index) => ({
    text,
    index,
    metadata: {
      source,
      chunkIndex: index,
      totalChunks,
    },
  }));
}
