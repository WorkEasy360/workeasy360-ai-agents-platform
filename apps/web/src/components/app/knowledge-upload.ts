import { getActiveOrgId } from "@/lib/api";

/** File types the knowledge base accepts (must match apps/api/src/modules/knowledge/parsers.ts). */
export const KNOWLEDGE_ACCEPT = ".pdf,.docx,.txt,.md,.markdown,.csv,.html,.htm,.json";
export const KNOWLEDGE_ACCEPT_EXT = KNOWLEDGE_ACCEPT.split(",");
export const KNOWLEDGE_MAX_BYTES = 20 * 1024 * 1024;
export const KNOWLEDGE_FORMATS_LABEL = "PDF, Word (.docx), TXT, Markdown, CSV, HTML or JSON";

/** Checks a file before upload. Returns a problem message, or null if it's fine. */
export function checkKnowledgeFile(file: File): string | null {
  const ext = "." + (file.name.split(".").pop() ?? "").toLowerCase();
  if (ext === ".doc") return `${file.name}: old Word (.doc) files aren't supported. In Word, use File → Save As → .docx.`;
  if (!KNOWLEDGE_ACCEPT_EXT.includes(ext)) return `${file.name}: only ${KNOWLEDGE_FORMATS_LABEL} files are supported.`;
  if (file.size > KNOWLEDGE_MAX_BYTES) return `${file.name}: files must be 20 MB or smaller.`;
  return null;
}

/** Uploads one file to a knowledge base. Returns a problem message, or null on success. */
export async function uploadKnowledgeFile(kbId: string, file: File): Promise<string | null> {
  const problem = checkKnowledgeFile(file);
  if (problem) return problem;
  try {
    const form = new FormData();
    form.append("file", file);
    const headers: Record<string, string> = {};
    const orgId = getActiveOrgId();
    if (orgId) headers["x-org-id"] = orgId;
    const res = await fetch(`/api/v1/knowledge-bases/${kbId}/documents`, { method: "POST", body: form, headers, credentials: "include" });
    if (res.ok) return null;
    const body = await res.json().catch(() => ({}));
    return `${file.name}: ${body.detail ?? "upload failed."}`;
  } catch {
    return `${file.name}: upload failed. Check your connection and try again.`;
  }
}
