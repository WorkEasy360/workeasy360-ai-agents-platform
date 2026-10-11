import type { ParsedSection } from "./parsers";

export interface Chunk {
  content: string;
  tokenCount: number;
  metadata: { headingPath?: string[]; page?: number };
}

/** Rough token estimate (≈4 chars per token for English; conservative for other scripts). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/**
 * Structure-aware chunking: keeps markdown heading context, splits on paragraphs, then
 * sentences, and packs pieces up to `maxTokens` with `overlap` tokens carried forward.
 */
export function chunkSections(sections: ParsedSection[], maxTokens = 600, overlap = 80): Chunk[] {
  const chunks: Chunk[] = [];
  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;

  for (const section of sections) {
    const headings: string[] = [];
    let buffer = "";

    const flush = () => {
      const content = buffer.trim();
      if (content) {
        chunks.push({
          content,
          tokenCount: estimateTokens(content),
          metadata: { headingPath: headings.length ? [...headings] : undefined, page: section.page },
        });
      }
      buffer = content.length > overlapChars ? content.slice(-overlapChars) : "";
    };

    const pieces = section.text.split(/\n{2,}/);
    for (const raw of pieces) {
      const piece = raw.trim();
      if (!piece) continue;
      const heading = /^(#{1,6})\s+(.+)$/.exec(piece);
      if (heading) {
        flush();
        buffer = "";
        headings.splice(heading[1]!.length - 1);
        headings[heading[1]!.length - 1] = heading[2]!.trim();
      }
      const parts = piece.length > maxChars ? piece.split(/(?<=[.!?।])\s+/) : [piece];
      for (const part of parts) {
        if (buffer.length + part.length + 2 > maxChars) flush();
        // A single sentence longer than a chunk: hard-split it.
        if (part.length > maxChars) {
          for (let i = 0; i < part.length; i += maxChars) {
            buffer += part.slice(i, i + maxChars);
            flush();
          }
        } else {
          buffer += (buffer ? "\n\n" : "") + part;
        }
      }
    }
    flush();
  }
  // Drop pure-overlap leftovers that duplicate the previous chunk's tail.
  return chunks.filter((c, i) => i === 0 || !chunks[i - 1]!.content.endsWith(c.content));
}
