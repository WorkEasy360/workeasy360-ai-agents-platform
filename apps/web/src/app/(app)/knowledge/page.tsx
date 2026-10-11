"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Plus, Upload, X } from "lucide-react";
import { checkKnowledgeFile, KNOWLEDGE_ACCEPT, KNOWLEDGE_FORMATS_LABEL, uploadKnowledgeFile } from "@/components/app/knowledge-upload";
import { Badge, Button, Dialog, EmptyState, Field, FormError, Input, Loading, PageHeader, Table, Textarea } from "@/components/ui";
import { errorMessage } from "@/components/app/misc";
import type { KnowledgeBase } from "@/components/app/types";
import { api } from "@/lib/api";
import { formatBytes, timeAgo } from "@/lib/format";

export default function KnowledgePage() {
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: () => api<{ data: KnowledgeBase[] }>("/api/v1/knowledge-bases"),
  });
  const kbs = data?.data ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Knowledge"
        description="Upload PDFs, Word files and text (policies, FAQs, product guides). Agents connected to a knowledge base answer from it."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New knowledge base
          </Button>
        }
      />

      <FormError message={errorMessage(error)} />
      {isLoading ? (
        <Loading />
      ) : kbs.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No knowledge bases yet"
          description="Create one, then add files, pasted text or web pages. Agents connected to it will answer using that information."
          action={<Button onClick={() => setCreating(true)}>Create a knowledge base</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Documents</th>
              <th>Size</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {kbs.map((kb) => (
              <tr key={kb.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <td className="min-w-48">
                  <Link href={`/knowledge/${kb.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                    {kb.name}
                  </Link>
                  {kb.description && <p className="line-clamp-1 text-xs text-[var(--muted)]">{kb.description}</p>}
                </td>
                <td className="whitespace-nowrap">
                  {kb.readyCount} of {kb.documentCount} ready
                  {kb.documentCount > kb.readyCount && (
                    <Badge tone="amber" className="ml-2">
                      {kb.documentCount - kb.readyCount} pending
                    </Badge>
                  )}
                </td>
                <td className="whitespace-nowrap tabular-nums">{formatBytes(kb.sizeBytes)}</td>
                <td className="whitespace-nowrap text-[var(--muted)]">{timeAgo(kb.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <CreateKbDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** Creates a knowledge base and adds its first files and/or pasted text in one step. */
function CreateKbDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const addFiles = (list: File[]) => {
    const bad = list.map(checkKnowledgeFile).filter((p): p is string => Boolean(p));
    setProblems(bad);
    setFiles((cur) => [...cur, ...list.filter((f) => !checkKnowledgeFile(f) && !cur.some((c) => c.name === f.name && c.size === f.size))]);
  };

  const create = useMutation({
    mutationFn: async (body: { name: string; description?: string; textTitle: string; text: string }) => {
      const kb = await api<KnowledgeBase>("/api/v1/knowledge-bases", {
        method: "POST",
        body: JSON.stringify({ name: body.name, ...(body.description ? { description: body.description } : {}) }),
      });
      const failed: string[] = [];
      for (const [i, file] of files.entries()) {
        setProgress(`Uploading ${file.name} (${i + 1} of ${files.length})…`);
        const problem = await uploadKnowledgeFile(kb.id, file);
        if (problem) failed.push(problem);
      }
      if (body.text.trim()) {
        setProgress("Adding your text…");
        await api(`/api/v1/knowledge-bases/${kb.id}/documents/text`, {
          method: "POST",
          body: JSON.stringify({ title: body.textTitle.trim() || "Notes", text: body.text }),
        }).catch((e: Error) => failed.push(`Text: ${e.message}`));
      }
      return { kb, failed };
    },
    onSuccess: async ({ kb, failed }) => {
      setProgress(null);
      await qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
      if (failed.length) setProblems(failed);
      router.push(`/knowledge/${kb.id}`);
    },
    onError: () => setProgress(null),
  });

  return (
    <Dialog open={open} onClose={onClose} title="New knowledge base" wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({
            name: String(f.get("name")).trim(),
            description: String(f.get("description") ?? "").trim() || undefined,
            textTitle: String(f.get("textTitle") ?? ""),
            text: String(f.get("text") ?? ""),
          });
        }}
      >
        <Field label="Name" htmlFor="kb-name">
          <Input id="kb-name" name="name" required maxLength={80} placeholder="e.g. Company policies" autoFocus />
        </Field>
        <Field label="Description (optional)" htmlFor="kb-desc" hint="A note for your team about what goes in here.">
          <Textarea id="kb-desc" name="description" maxLength={500} className="min-h-14" />
        </Field>

        <div>
          <p className="mb-1.5 text-sm font-medium">Files</p>
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(Array.from(e.dataTransfer.files));
            }}
            className="flex flex-col items-center rounded-md border-2 border-dashed border-[var(--border)] px-4 py-5 text-center"
          >
            <Upload className="size-6 text-brand-600" aria-hidden />
            <p className="mt-1 text-sm">Drag files here, or</p>
            <Button type="button" size="sm" variant="secondary" className="mt-2" onClick={() => fileInput.current?.click()}>
              Choose files
            </Button>
            <p className="mt-2 text-xs text-[var(--muted)]">{KNOWLEDGE_FORMATS_LABEL} · up to 20 MB each</p>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={KNOWLEDGE_ACCEPT}
              className="hidden"
              onChange={(e) => {
                addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </div>
          {files.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {files.map((f) => (
                <li key={f.name + f.size} className="flex items-center justify-between gap-2 rounded border border-[var(--border)] px-2 py-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <FileText className="size-3.5 shrink-0 text-[var(--muted)]" aria-hidden />
                    <span className="truncate">{f.name}</span>
                    <span className="shrink-0 text-xs text-[var(--muted)]">{formatBytes(f.size)}</span>
                  </span>
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((c) => c !== f))}>
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <details className="rounded-md border border-[var(--border)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Or paste text (FAQs, policies, notes)</summary>
          <div className="mt-3 space-y-3">
            <Input name="textTitle" placeholder="Title, e.g. Refund policy" maxLength={200} />
            <Textarea name="text" className="min-h-32" placeholder="Paste or type the content here…" />
          </div>
        </details>

        {problems.map((p) => (
          <FormError key={p} message={p} />
        ))}
        <FormError message={errorMessage(create.error)} />
        <div className="flex items-center justify-end gap-2">
          {progress && <span className="mr-auto text-xs text-[var(--muted)]">{progress}</span>}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Creating…" : files.length ? `Create and upload ${files.length} file${files.length === 1 ? "" : "s"}` : "Create"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
