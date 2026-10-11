import { parseDocument } from "./parsers";

/**
 * Child-process entry for parsing untrusted PDF/DOCX files (see parseDocumentIsolated).
 * Runs with its own --max-old-space-size, so a decompression bomb ends this process, not the worker.
 */
process.once("message", (msg: { bytes: Uint8Array; type: string }) => {
  parseDocument(Buffer.from(msg.bytes), msg.type).then(
    (sections) => process.send!({ ok: true, sections }, () => process.exit(0)),
    (err: unknown) => process.send!({ ok: false, message: err instanceof Error ? err.message : String(err) }, () => process.exit(0)),
  );
});
