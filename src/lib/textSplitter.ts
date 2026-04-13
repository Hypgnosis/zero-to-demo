/**
 * ═══════════════════════════════════════════════════════════════════
 * AXIOM-0 — Hierarchical Text Splitter (Phase 4: Industrial RAG)
 *
 * SMALL-TO-BIG RETRIEVAL ARCHITECTURE:
 * Generates two tiers of chunks from extracted document text:
 *
 * MACRO-CHUNKS (~10,000–20,000 chars):
 *   Structural blocks representing full sections, complete tables,
 *   or logical document regions. These provide CONTEXT to Gemini.
 *
 * MICRO-CHUNKS (~500 chars):
 *   High-density search fragments for precise vector matching.
 *   Each micro-chunk carries its parentMacroId and the full macro
 *   text in metadata — enabling one-shot retrieval without extra
 *   Redis/DB lookups.
 *
 * TABLE-AWARE SPLITTING:
 *   Detects markdown table blocks (lines starting with |) and
 *   attempts to keep tables whole within macro chunks. If a table
 *   exceeds the macro limit, headers are repeated in every chunk.
 *
 * Finding 6 Remedy: BOM tables are never decapitated.
 * ═══════════════════════════════════════════════════════════════════
 */

/* ─── Types ───────────────────────────────────────────────────── */

export interface MacroChunk {
  macroId: string;
  text: string;
  index: number;
}

export interface MicroChunk {
  text: string;
  index: number;
  parentMacroId: string;
  parentMacroText: string;
  metadata: {
    source: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

export interface HierarchicalResult {
  macroChunks: MacroChunk[];
  microChunks: MicroChunk[];
}

export interface SplitterConfig {
  chunkSize: number;
  chunkOverlap: number;
  separators?: string[];
}

/** Legacy TextChunk for backward compatibility. */
export interface TextChunk {
  text: string;
  index: number;
  metadata: {
    source: string;
    chunkIndex: number;
    totalChunks: number;
  };
}

/* ─── Constants ───────────────────────────────────────────────── */

const MACRO_CHUNK_SIZE = 15000;     // ~15k chars per macro block
const MICRO_CHUNK_SIZE = 500;       // 500 chars for precise search
const MICRO_CHUNK_OVERLAP = 100;    // 100 char overlap for continuity
const DEFAULT_SEPARATORS = ['\n\n', '\n', '. ', ' ', ''];

/* ─── Table Detection ─────────────────────────────────────────── */

/**
 * Detects if a line is part of a markdown table.
 * Tables start with | and contain at least one | separator.
 */
function isTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.includes('|', 1);
}

/**
 * Detects if a line is a markdown table separator (e.g., |---|---|).
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  return /^\|[\s\-:|]+\|$/.test(trimmed);
}

/**
 * Extracts the header row from a table block (first non-separator row).
 */
function extractTableHeader(tableLines: string[]): string[] {
  const headerLines: string[] = [];
  for (const line of tableLines) {
    headerLines.push(line);
    if (isTableSeparator(line)) break;
    // If we've added 2 lines (header + separator), stop
    if (headerLines.length >= 2) break;
  }
  return headerLines;
}

/* ─── Structural Block Detection ──────────────────────────────── */

/**
 * Splits text into structural blocks that respect document boundaries.
 * Detects: section headers, table blocks, paragraph boundaries.
 * 
 * Returns blocks that can then be assembled into macro chunks.
 */
function detectStructuralBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  let currentBlock: string[] = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (isTableLine(line)) {
      // Starting a table — flush current non-table block
      if (!inTable && currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
      }
      inTable = true;
      currentBlock.push(line);
    } else if (inTable) {
      // End of table — flush the table block
      if (line.trim() === '' || !isTableLine(line)) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
        inTable = false;
        if (line.trim() !== '') {
          currentBlock.push(line);
        }
      }
    } else {
      // Regular text — split on double newlines (paragraph breaks)
      if (line.trim() === '' && currentBlock.length > 0) {
        blocks.push(currentBlock.join('\n'));
        currentBlock = [];
      } else {
        currentBlock.push(line);
      }
    }
  }

  // Flush remaining
  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join('\n'));
  }

  return blocks.filter((b) => b.trim().length > 0);
}

/* ─── Macro Chunking (Table-Aware) ────────────────────────────── */

/**
 * Assembles structural blocks into macro chunks of ~MACRO_CHUNK_SIZE.
 * Tables are kept whole whenever possible. If a single table exceeds
 * the macro limit, it's split with header repetition.
 */
function buildMacroChunks(
  blocks: string[],
  source: string,
  maxSize: number = MACRO_CHUNK_SIZE
): MacroChunk[] {
  const macros: MacroChunk[] = [];
  let currentMacro: string[] = [];
  let currentLength = 0;

  for (const block of blocks) {
    const blockLength = block.length;

    // Case 1: Block fits in current macro
    if (currentLength + blockLength + 2 <= maxSize) {
      currentMacro.push(block);
      currentLength += blockLength + 2; // +2 for \n\n separator
      continue;
    }

    // Case 2: Current macro has content — flush it
    if (currentMacro.length > 0) {
      const macroId = `macro-${source}-${macros.length}`;
      macros.push({
        macroId,
        text: currentMacro.join('\n\n'),
        index: macros.length,
      });
      currentMacro = [];
      currentLength = 0;
    }

    // Case 3: Block itself exceeds max — split it
    if (blockLength > maxSize) {
      const isTable = block.split('\n').some(isTableLine);

      if (isTable) {
        // Table-aware split: repeat headers in every chunk
        const tableLines = block.split('\n');
        const headerLines = extractTableHeader(tableLines);
        const headerText = headerLines.join('\n');
        const dataLines = tableLines.slice(headerLines.length);

        let tableChunk = headerText;
        for (const dataLine of dataLines) {
          if (tableChunk.length + dataLine.length + 1 > maxSize) {
            const macroId = `macro-${source}-${macros.length}`;
            macros.push({
              macroId,
              text: tableChunk,
              index: macros.length,
            });
            // Start new chunk WITH header repetition
            tableChunk = headerText + '\n' + dataLine;
          } else {
            tableChunk += '\n' + dataLine;
          }
        }
        // Flush remaining table rows
        if (tableChunk.length > headerText.length) {
          const macroId = `macro-${source}-${macros.length}`;
          macros.push({
            macroId,
            text: tableChunk,
            index: macros.length,
          });
        }
      } else {
        // Non-table oversized block: split on paragraphs/sentences
        const subChunks = splitTextRecursive(block, DEFAULT_SEPARATORS, maxSize);
        for (const sub of subChunks) {
          const macroId = `macro-${source}-${macros.length}`;
          macros.push({
            macroId,
            text: sub,
            index: macros.length,
          });
        }
      }
    } else {
      // Case 4: Block fits as a new macro start
      currentMacro.push(block);
      currentLength = blockLength;
    }
  }

  // Flush final macro
  if (currentMacro.length > 0) {
    const macroId = `macro-${source}-${macros.length}`;
    macros.push({
      macroId,
      text: currentMacro.join('\n\n'),
      index: macros.length,
    });
  }

  return macros;
}

/* ─── Micro Chunking ──────────────────────────────────────────── */

/**
 * Splits a macro chunk into overlapping micro chunks for vector search.
 * Each micro chunk carries the parentMacroId and full macro text.
 */
function buildMicroChunks(
  macro: MacroChunk,
  source: string,
  globalOffset: number,
  microSize: number = MICRO_CHUNK_SIZE,
  microOverlap: number = MICRO_CHUNK_OVERLAP
): MicroChunk[] {
  const rawMicros = splitTextRecursive(macro.text, DEFAULT_SEPARATORS, microSize);
  const micros: MicroChunk[] = [];

  for (let i = 0; i < rawMicros.length; i++) {
    let microText = rawMicros[i]!;

    // Apply overlap from previous micro
    if (i > 0 && microOverlap > 0) {
      const prevText = rawMicros[i - 1]!;
      const overlap = prevText.slice(-microOverlap);
      const withOverlap = overlap + ' ' + microText;
      if (withOverlap.length <= microSize * 1.5) {
        microText = withOverlap;
      }
    }

    micros.push({
      text: microText,
      index: globalOffset + i,
      parentMacroId: macro.macroId,
      parentMacroText: macro.text,
      metadata: {
        source,
        chunkIndex: globalOffset + i,
        totalChunks: 0, // Will be set after all micros are generated
      },
    });
  }

  return micros;
}

/* ─── Recursive Text Splitter (Base Utility) ──────────────────── */

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

  const splits = separator
    ? text.split(separator).filter((s) => s.length > 0)
    : Array.from(text);

  let currentChunk = '';

  for (const split of splits) {
    const candidate = currentChunk
      ? currentChunk + separator + split
      : split;

    if (candidate.length <= chunkSize) {
      currentChunk = candidate;
    } else {
      if (currentChunk.length > 0) {
        finalChunks.push(currentChunk);
      }

      if (split.length > chunkSize && nextSeparators.length > 0) {
        const subChunks = splitTextRecursive(split, nextSeparators, chunkSize);
        finalChunks.push(...subChunks);
        currentChunk = '';
      } else {
        currentChunk = split;
      }
    }
  }

  if (currentChunk.length > 0) {
    finalChunks.push(currentChunk);
  }

  return finalChunks;
}

/* ─── Public API ──────────────────────────────────────────────── */

/**
 * PHASE 4 — Hierarchical Small-to-Big Splitter.
 *
 * Generates macro chunks (structural context) and micro chunks (search targets).
 * Each micro chunk carries its parent macro's full text in metadata,
 * enabling one-shot retrieval without additional DB calls.
 *
 * @param text   - The full extracted document text.
 * @param source - The source filename for metadata tagging.
 * @returns { macroChunks, microChunks } — the hierarchical split result.
 */
export function splitHierarchical(
  text: string,
  source: string
): HierarchicalResult {
  // 1. Detect structural blocks (table-aware)
  const blocks = detectStructuralBlocks(text.trim());

  // 2. Assemble macro chunks from structural blocks
  const macroChunks = buildMacroChunks(blocks, source);

  // 3. Generate micro chunks from each macro
  const allMicroChunks: MicroChunk[] = [];
  let globalMicroIndex = 0;

  for (const macro of macroChunks) {
    const micros = buildMicroChunks(macro, source, globalMicroIndex);
    globalMicroIndex += micros.length;
    allMicroChunks.push(...micros);
  }

  // 4. Backfill totalChunks now that we know the global count
  const totalMicros = allMicroChunks.length;
  for (const micro of allMicroChunks) {
    micro.metadata.totalChunks = totalMicros;
  }

  return {
    macroChunks,
    microChunks: allMicroChunks,
  };
}

/**
 * LEGACY — Flat text splitter (pre-Phase 4).
 * Preserved for backward compatibility. New code should use splitHierarchical().
 */
export function splitText(
  text: string,
  source: string,
  config: Partial<SplitterConfig> = {}
): TextChunk[] {
  const {
    chunkSize = 1000,
    chunkOverlap = 200,
    separators = DEFAULT_SEPARATORS,
  } = config;

  const rawChunks = splitTextRecursive(text.trim(), separators, chunkSize);

  const overlappedChunks: string[] = [];

  for (let i = 0; i < rawChunks.length; i++) {
    const chunk = rawChunks[i]!;

    if (i === 0) {
      overlappedChunks.push(chunk);
      continue;
    }

    const prevChunk = rawChunks[i - 1]!;
    const overlapText = prevChunk.slice(-chunkOverlap);
    const withOverlap = overlapText + ' ' + chunk;

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
