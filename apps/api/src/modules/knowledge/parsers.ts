import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** A section of extracted text, optionally tied to a PDF page. */
export interface ParsedSection {
  text: string;
  page?: number;
}

export const SUPPORTED_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "text",
  "text/markdown": "text",
  "text/csv": "csv",
  "text/html": "html",
  "application/json": "text",
};

export function detectType(mime: string, filename: string): string | undefined {
  const byMime = SUPPORTED_TYPES[mime.split(";")[0]!.trim().toLowerCase()];
  if (byMime) return byMime;
  const ext = filename.toLowerCase().split(".").pop();
  return { pdf: "pdf", docx: "docx", txt: "text", md: "text", markdown: "text", csv: "csv", html: "html", htm: "html", json: "text" }[ext ?? ""];
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, inner: string) => `\n\n${"#".repeat(Number(level))} ${inner}\n\n`)
    .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export async function parseDocument(bytes: Buffer, type: string): Promise<ParsedSection[]> {
  switch (type) {
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: false });
      return (text as string[]).map((t, i) => ({ text: t, page: i + 1 })).filter((s) => s.text.trim());
    }
    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      return [{ text: value }];
    }
    case "html":
      return [{ text: htmlToText(bytes.toString("utf8")) }];
    case "csv": {
      // Keep the header with every group of rows so chunks stay self-explanatory.
      const lines = bytes.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
      const [header, ...rows] = lines;
      const sections: ParsedSection[] = [];
      for (let i = 0; i < rows.length; i += 20) sections.push({ text: [header, ...rows.slice(i, i + 20)].join("\n") });
      return sections.length ? sections : [{ text: header ?? "" }];
    }
    default:
      return [{ text: bytes.toString("utf8") }];
  }
}

/** Extracted text above this is refused: it is far beyond any real document and would flood embeddings. */
export const MAX_EXTRACTED_CHARS = 5_000_000;
const ISOLATED_TYPES = new Set(["pdf", "docx"]);

export class DocumentTooLargeError extends Error {}

/**
 * Parses an uploaded file safely. PDF and DOCX are compressed formats: a 1 MB upload can expand to
 * gigabytes ("zip bomb") and exhaust the worker's memory, stopping ingestion for every tenant. Those
 * are parsed in a worker thread with its own memory and time limits; if either is hit, only that
 * thread ends and the document fails with a clear error.
 */
export async function parseDocumentIsolated(bytes: Buffer, type: string, opts: { maxHeapMb?: number; timeoutMs?: number } = {}): Promise<ParsedSection[]> {
  const sections = ISOLATED_TYPES.has(type) ? await parseInWorker(bytes, type, opts.maxHeapMb ?? 512, opts.timeoutMs ?? 120_000) : await parseDocument(bytes, type);
  const total = sections.reduce((n, s) => n + s.text.length, 0);
  if (total > MAX_EXTRACTED_CHARS) throw new DocumentTooLargeError("This document has too much text once extracted. Split it into smaller files.");
  return sections;
}

function parseInWorker(bytes: Buffer, type: string, maxHeapMb: number, timeoutMs: number): Promise<ParsedSection[]> {
  // Source (.ts, run through tsx in dev and tests) or the bundled dist/parse-worker.js next to dist/worker.js.
  // A child process, not a worker thread: thread heap limits don't reliably contain a V8 out-of-memory crash.
  const isTs = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(isTs ? "./parse-worker.ts" : "./parse-worker.js", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = fork(entry, [], {
      execArgv: [...(isTs ? ["--import", "tsx"] : []), `--max-old-space-size=${maxHeapMb}`],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr?.resume(); // discard V8's out-of-memory report
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill("SIGKILL");
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new DocumentTooLargeError("This document took too long to read."))), timeoutMs);
    child.once("message", (m: { ok: boolean; sections?: ParsedSection[]; message?: string }) =>
      finish(() => (m.ok ? resolve(m.sections!) : reject(new Error(m.message)))),
    );
    child.once("error", (err) => finish(() => reject(err)));
    // Exiting without a result means the parser ran out of memory (or crashed) on this file.
    child.once("exit", () => finish(() => reject(new DocumentTooLargeError("This document is too large to read once uncompressed."))));
    child.send({ bytes, type });
  });
}
