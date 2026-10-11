"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, Globe, Pencil, RotateCw, Search, Trash2, Type, Upload } from "lucide-react";
import { Badge, Button, Card, Dialog, Field, FormError, Input, Loading, Notice, PageHeader, StatusBadge, Table, Textarea } from "@/components/ui";
import { ConfirmDialog, errorMessage } from "@/components/app/misc";
import type { Chunk, KbDocument, KnowledgeBase, SearchHit } from "@/components/app/types";
import { KNOWLEDGE_ACCEPT, KNOWLEDGE_FORMATS_LABEL, uploadKnowledgeFile } from "@/components/app/knowledge-upload";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes, timeAgo } from "@/lib/format";


const statusText: Record<KbDocument["status"], string> = {
  queued: "Waiting",
  parsing: "Reading",
  embedding: "Making searchable",
  ready: "Ready",
  failed: "Failed",
};

export default function KnowledgeBasePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();

  const kbQuery = useQuery({ queryKey: ["knowledge-base", id], queryFn: () => api<KnowledgeBase>(`/api/v1/knowledge-bases/${id}`) });
  const docsQuery = useQuery({
    queryKey: ["kb-documents", id],
    queryFn: () => api<{ data: KbDocument[] }>(`/api/v1/knowledge-bases/${id}/documents`),
    // Keep polling while anything is still being processed.
    refetchInterval: (q) => (q.state.data?.data.some((d) => d.status !== "ready" && d.status !== "failed") ? 3000 : false),
  });
  const docs = docsQuery.data?.data ?? [];

  const refreshDocs = () => {
    qc.invalidateQueries({ queryKey: ["kb-documents", id] });
    qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
  };

  const [dialog, setDialog] = useState<null | "rename" | "delete" | "text" | "url">(null);
  // Store the id so the dialog reflects live status updates from polling.
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewing = docs.find((d) => d.id === viewingId) ?? null;
  const [removing, setRemoving] = useState<KbDocument | null>(null);

  const deleteKb = useMutation({
    mutationFn: () => api(`/api/v1/knowledge-bases/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["knowledge-bases"] });
      router.push("/knowledge");
    },
  });
  const reindex = useMutation({
    mutationFn: (docId: string) => api(`/api/v1/documents/${docId}/reindex`, { method: "POST" }),
    onSuccess: refreshDocs,
  });
  const removeDoc = useMutation({
    mutationFn: (docId: string) => api(`/api/v1/documents/${docId}`, { method: "DELETE" }),
    onSuccess: () => {
      setRemoving(null);
      refreshDocs();
    },
  });

  if (kbQuery.error instanceof ApiError && kbQuery.error.status === 404) {
    return (
      <div className="mx-auto max-w-5xl space-y-4">
        <Notice tone="warning">This knowledge base doesn&apos;t exist or was deleted.</Notice>
        <Link href="/knowledge" className="text-sm text-brand-600 hover:underline">
          Back to knowledge
        </Link>
      </div>
    );
  }
  const kb = kbQuery.data;
  if (!kb) return <Loading />;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <Link href="/knowledge" className="mb-3 inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
          <ArrowLeft className="size-4" /> Knowledge
        </Link>
        <PageHeader
          title={kb.name}
          description={kb.description || "Add documents below. Agents connected to this knowledge base use them to answer questions."}
          actions={
            <>
              <Button variant="secondary" onClick={() => setDialog("rename")}>
                <Pencil className="size-4" /> Rename
              </Button>
              <Button variant="secondary" onClick={() => setDialog("delete")}>
                <Trash2 className="size-4" /> Delete
              </Button>
            </>
          }
        />
      </div>

      <AddContent kbId={id} onAdded={refreshDocs} onPaste={() => setDialog("text")} onUrl={() => setDialog("url")} />

      <section>
        <h2 className="mb-3 font-medium">Documents</h2>
        <FormError message={errorMessage(docsQuery.error) ?? errorMessage(reindex.error)} />
        {docsQuery.isLoading ? (
          <Loading />
        ) : docs.length === 0 ? (
          <Card className="py-8 text-center text-sm text-[var(--muted)]">No documents yet. Upload a file, paste text or add a web page to get started.</Card>
        ) : (
          <Table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Status</th>
                <th>Size</th>
                <th>Added</th>
                <th className="text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="min-w-56">
                    <button onClick={() => setViewingId(d.id)} className="flex items-start gap-2 text-left hover:underline">
                      <SourceIcon type={d.sourceType} />
                      <span className="font-medium break-all">{d.title}</span>
                    </button>
                    {d.status === "failed" && d.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{d.error}</p>}
                  </td>
                  <td className="whitespace-nowrap">
                    <DocStatus doc={d} />
                  </td>
                  <td className="whitespace-nowrap tabular-nums">{d.sourceType === "url" && !d.sizeBytes ? "—" : formatBytes(d.sizeBytes)}</td>
                  <td className="whitespace-nowrap text-[var(--muted)]">{timeAgo(d.createdAt)}</td>
                  <td className="whitespace-nowrap text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      title="Process again"
                      aria-label={`Process ${d.title} again`}
                      disabled={reindex.isPending && reindex.variables === d.id}
                      onClick={() => reindex.mutate(d.id)}
                    >
                      <RotateCw className="size-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" title="Delete" aria-label={`Delete ${d.title}`} onClick={() => setRemoving(d)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </section>

      <TrySearch kbId={id} hasReady={docs.some((d) => d.status === "ready")} />

      <RenameDialog kb={kb} open={dialog === "rename"} onClose={() => setDialog(null)} />
      <PasteTextDialog kbId={id} open={dialog === "text"} onClose={() => setDialog(null)} onAdded={refreshDocs} />
      <AddUrlDialog kbId={id} open={dialog === "url"} onClose={() => setDialog(null)} onAdded={refreshDocs} />
      <DocumentDialog doc={viewing} onClose={() => setViewingId(null)} />
      <ConfirmDialog
        open={dialog === "delete"}
        onClose={() => setDialog(null)}
        title="Delete knowledge base?"
        message={
          <>
            <strong>{kb.name}</strong> and all {docs.length} of its documents will be permanently deleted, including the uploaded files. Agents using it will no longer be able to look anything up in it.
          </>
        }
        pending={deleteKb.isPending}
        error={errorMessage(deleteKb.error)}
        onConfirm={() => deleteKb.mutate()}
      />
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Delete document?"
        message={
          <>
            Agents will stop using <strong>{removing?.title}</strong> straight away.
          </>
        }
        pending={removeDoc.isPending}
        error={errorMessage(removeDoc.error)}
        onConfirm={() => removing && removeDoc.mutate(removing.id)}
      />
    </div>
  );
}

function SourceIcon({ type }: { type: KbDocument["sourceType"] }) {
  const Icon = type === "url" ? Globe : type === "text" ? Type : FileText;
  return <Icon className="mt-0.5 size-4 shrink-0 text-[var(--muted)]" aria-hidden />;
}

function DocStatus({ doc }: { doc: KbDocument }) {
  if (doc.status === "ready") {
    return (
      <span className="flex items-center gap-2">
        <StatusBadge status="ready" />
        <span className="text-xs text-[var(--muted)]">
          {doc.chunkCount} {doc.chunkCount === 1 ? "section" : "sections"}
        </span>
      </span>
    );
  }
  if (doc.status === "failed") return <Badge tone="red">Failed</Badge>;
  return (
    <Badge tone={doc.status === "queued" ? "amber" : "blue"}>
      <span className="mr-1.5 inline-block size-1.5 animate-pulse rounded-full bg-current" />
      {statusText[doc.status]}…
    </Badge>
  );
}

/** Upload area (drag-and-drop or button) plus entry points for text and web pages. */
function AddContent({ kbId, onAdded, onPaste, onUrl }: { kbId: string; onAdded: () => void; onPaste: () => void; onUrl: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  async function uploadFiles(files: File[]) {
    const problems: string[] = [];
    for (const file of files) {
      setUploading(file.name);
      const problem = await uploadKnowledgeFile(kbId, file);
      if (problem) problems.push(problem);
      onAdded();
    }
    setUploading(null);
    setErrors(problems);
  }

  return (
    <Card className="p-4 sm:p-5">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) uploadFiles(Array.from(e.dataTransfer.files));
        }}
        className={cn(
          "flex flex-col items-center rounded-md border-2 border-dashed px-4 py-8 text-center transition-colors",
          dragging ? "border-brand-500 bg-brand-50 dark:bg-slate-800" : "border-[var(--border)]",
        )}
      >
        <Upload className="size-8 text-brand-600" aria-hidden />
        <p className="mt-2 text-sm font-medium">{uploading ? `Uploading ${uploading}…` : "Drag files here to upload"}</p>
        <p className="mt-1 text-xs text-[var(--muted)]">{KNOWLEDGE_FORMATS_LABEL} · up to 20 MB each</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button size="sm" disabled={!!uploading} onClick={() => inputRef.current?.click()}>
            <Upload className="size-3.5" /> Choose files
          </Button>
          <Button size="sm" variant="secondary" onClick={onPaste}>
            <Type className="size-3.5" /> Paste text
          </Button>
          <Button size="sm" variant="secondary" onClick={onUrl}>
            <Globe className="size-3.5" /> Add web page
          </Button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={KNOWLEDGE_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) uploadFiles(files);
          }}
        />
      </div>
      {errors.length > 0 && (
        <div className="mt-3 space-y-1">
          {errors.map((m) => (
            <FormError key={m} message={m} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RenameDialog({ kb, open, onClose }: { kb: KnowledgeBase; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (body: { name: string; description: string }) =>
      api<KnowledgeBase>(`/api/v1/knowledge-bases/${kb.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["knowledge-base", kb.id] }), qc.invalidateQueries({ queryKey: ["knowledge-bases"] })]);
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Rename knowledge base">
      <form
        key={String(open)}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          save.mutate({ name: String(f.get("name")).trim(), description: String(f.get("description") ?? "") });
        }}
      >
        <Field label="Name" htmlFor="rn-name">
          <Input id="rn-name" name="name" required maxLength={80} defaultValue={kb.name} />
        </Field>
        <Field label="Description (optional)" htmlFor="rn-desc">
          <Textarea id="rn-desc" name="description" maxLength={500} defaultValue={kb.description ?? ""} className="min-h-16" />
        </Field>
        <FormError message={errorMessage(save.error)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function PasteTextDialog({ kbId, open, onClose, onAdded }: { kbId: string; open: boolean; onClose: () => void; onAdded: () => void }) {
  const add = useMutation({
    mutationFn: (body: { title: string; text: string }) =>
      api(`/api/v1/knowledge-bases/${kbId}/documents/text`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Paste text" wide>
      <form
        key={String(open)}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          add.mutate({ title: String(f.get("title")).trim(), text: String(f.get("text")) });
        }}
      >
        <Field label="Title" htmlFor="pt-title" hint="Shown when an agent quotes this text as a source.">
          <Input id="pt-title" name="title" required maxLength={200} placeholder="e.g. Refund policy" />
        </Field>
        <Field label="Text" htmlFor="pt-text">
          <Textarea id="pt-text" name="text" required maxLength={500_000} className="min-h-60" placeholder="Paste or type the information here…" />
        </Field>
        <FormError message={errorMessage(add.error)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add text"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddUrlDialog({ kbId, open, onClose, onAdded }: { kbId: string; open: boolean; onClose: () => void; onAdded: () => void }) {
  const add = useMutation({
    mutationFn: (url: string) => api(`/api/v1/knowledge-bases/${kbId}/documents/url`, { method: "POST", body: JSON.stringify({ url }) }),
    onSuccess: () => {
      onAdded();
      onClose();
    },
  });
  return (
    <Dialog open={open} onClose={onClose} title="Add a web page">
      <form
        key={String(open)}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate(String(new FormData(e.currentTarget).get("url")).trim());
        }}
      >
        <Field label="Page address" htmlFor="url" hint="We'll copy the text from this one page. It must be publicly visible (no login).">
          <Input id="url" name="url" type="url" required placeholder="https://example.com/faq" />
        </Field>
        <FormError message={errorMessage(add.error)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={add.isPending}>
            {add.isPending ? "Adding…" : "Add page"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Shows a document's details and a preview of the searchable sections it was split into. */
function DocumentDialog({ doc, onClose }: { doc: KbDocument | null; onClose: () => void }) {
  const chunks = useQuery({
    queryKey: ["doc-chunks", doc?.id, doc?.status],
    enabled: !!doc && doc.status === "ready",
    queryFn: () => api<{ data: Chunk[] }>(`/api/v1/documents/${doc!.id}/chunks`),
  });
  const list = chunks.data?.data ?? [];
  return (
    <Dialog open={doc !== null} onClose={onClose} title={doc?.title ?? "Document"} wide>
      {doc && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Meta label="Status">
              <DocStatus doc={doc} />
            </Meta>
            <Meta label="Type">{doc.sourceType === "url" ? "Web page" : doc.sourceType === "text" ? "Pasted text" : "File"}</Meta>
            <Meta label="Size">{formatBytes(doc.sizeBytes)}</Meta>
            <Meta label="Added">{timeAgo(doc.createdAt)}</Meta>
          </dl>
          {doc.sourceUrl && (
            <a href={doc.sourceUrl} target="_blank" rel="noreferrer" className="block truncate text-sm text-brand-600 hover:underline">
              {doc.sourceUrl}
            </a>
          )}
          {doc.status === "failed" && <FormError message={doc.error ?? "Processing failed. Try processing it again."} />}
          {doc.status !== "ready" && doc.status !== "failed" && <Notice>This document is still being processed. Its sections will appear here when it&apos;s ready.</Notice>}
          {doc.status === "ready" && (
            <div>
              <h3 className="mb-2 text-sm font-medium">
                Sections the agent can search{list.length >= 50 && " (first 50)"}
              </h3>
              {chunks.isLoading ? (
                <Loading />
              ) : list.length === 0 ? (
                <p className="text-sm text-[var(--muted)]">No text was found in this document.</p>
              ) : (
                <ol className="space-y-2">
                  {list.map((c) => (
                    <li key={c.id} className="rounded-md border border-[var(--border)] p-3">
                      <p className="mb-1 text-xs text-[var(--muted)]">
                        Section {c.ordinal + 1}
                        {c.metadata?.page ? ` · page ${c.metadata.page}` : ""}
                        {c.metadata?.headingPath?.length ? ` · ${c.metadata.headingPath.join(" › ")}` : ""}
                      </p>
                      <p className="text-sm whitespace-pre-wrap">{c.content}</p>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/** Lets users check what an agent would find for a question. */
function TrySearch({ kbId, hasReady }: { kbId: string; hasReady: boolean }) {
  const [query, setQuery] = useState("");
  const search = useMutation({
    mutationFn: (q: string) => api<{ data: SearchHit[] }>(`/api/v1/knowledge-bases/${kbId}/search`, { method: "POST", body: JSON.stringify({ query: q }) }),
  });
  const hits = search.data?.data;
  return (
    <Card>
      <h2 className="font-medium">Try a search</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">Ask a question the way a customer would, and see which passages an agent would find.</p>
      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim()) search.mutate(query.trim());
        }}
      >
        <Input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={500} placeholder="e.g. What is the refund window?" aria-label="Search question" />
        <Button type="submit" disabled={!hasReady || search.isPending || !query.trim()}>
          <Search className="size-4" /> {search.isPending ? "Searching…" : "Search"}
        </Button>
      </form>
      {!hasReady && <p className="mt-2 text-xs text-[var(--muted)]">Add a document and wait until it&apos;s ready to try searching.</p>}
      <div className="mt-3">
        <FormError message={errorMessage(search.error)} />
      </div>
      {hits && (
        <div className="mt-3 space-y-2">
          {hits.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">Nothing matched. Try different words, or add a document that covers this topic.</p>
          ) : (
            hits.map((h, i) => (
              <div key={h.chunkId} className="rounded-md border border-[var(--border)] p-3">
                <p className="mb-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                  <Badge tone={i === 0 ? "green" : "neutral"}>#{i + 1}</Badge>
                  <span className="truncate font-medium text-[var(--foreground)]">{h.documentTitle}</span>
                  {h.metadata?.page ? <span>· page {h.metadata.page}</span> : null}
                </p>
                <p className="line-clamp-4 text-sm whitespace-pre-wrap">{h.content}</p>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}
