"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { Button, FormError, Loading, PageHeader } from "@/components/ui";
import { useRole } from "@/components/app/use-role";
import { errorMessage } from "@/components/app/misc";
import type { Message } from "@/components/app/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";

export default function ConversationPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const router = useRouter();
  const { isAdmin } = useRole();
  const key = ["conversation-messages", id];
  const { data, isLoading, error } = useQuery({ queryKey: key, queryFn: () => api<{ data: Message[] }>(`/api/v1/conversations/${id}/messages`) });
  const messages = (data?.data ?? []).filter((m) => m.role !== "tool");

  const feedback = useMutation({
    mutationFn: ({ messageId, value }: { messageId: string; value: 1 | -1 | null }) =>
      api(`/api/v1/messages/${messageId}/feedback`, { method: "POST", body: JSON.stringify({ value }) }),
    // Update the thumbs immediately; roll back if the request fails.
    onMutate: async ({ messageId, value }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ data: Message[] }>(key);
      qc.setQueryData<{ data: Message[] }>(key, (old) => old && { data: old.data.map((m) => (m.id === messageId ? { ...m, feedback: value } : m)) });
      return { prev };
    },
    onError: (_e, _v, ctx) => ctx?.prev && qc.setQueryData(key, ctx.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  // For erasure requests: removes the messages and the run logs that contain them.
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/conversations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["conversations"] });
      router.replace("/logs?tab=conversations");
    },
  });

  const first = messages[0];
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/logs?tab=conversations" className="inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        <ArrowLeft className="size-4" /> Conversations
      </Link>
      <PageHeader
        title="Conversation"
        description={first ? `Started ${formatDateTime(first.createdAt)} · ${messages.length} messages. Rate replies to keep track of what the agent gets right.` : undefined}
        actions={
          isAdmin && (
            <Button
              variant="secondary"
              className="text-red-600"
              disabled={remove.isPending}
              onClick={() => confirm("Permanently delete this conversation and its run logs? This can't be undone.") && remove.mutate()}
            >
              <Trash2 className="size-4" /> Delete
            </Button>
          )
        }
      />
      <FormError message={errorMessage(error) ?? errorMessage(feedback.error) ?? errorMessage(remove.error)} />
      {isLoading ? (
        <Loading />
      ) : messages.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">This conversation has no messages.</p>
      ) : (
        <ol className="space-y-4">
          {messages.map((m) => {
            const isUser = m.role === "user";
            const citations = m.content?.citations ?? [];
            return (
              <li key={m.id} className={cn("flex flex-col", isUser ? "items-end" : "items-start")}>
                <div
                  className={cn(
                    "max-w-[85%] rounded-lg px-4 py-2.5 text-sm whitespace-pre-wrap",
                    isUser ? "bg-brand-600 text-white" : "border border-[var(--border)] bg-[var(--surface)]",
                  )}
                >
                  {m.content?.text ?? ""}
                  {citations.length > 0 && (
                    <div className="mt-2 border-t border-[var(--border)] pt-2">
                      <p className="mb-1 text-xs text-[var(--muted)]">Sources</p>
                      <ul className="flex flex-wrap gap-1.5">
                        {citations.map((c) => (
                          <li key={c.documentId} className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">
                            <FileText className="size-3" aria-hidden /> {c.title}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span>{formatDateTime(m.createdAt)}</span>
                  {!isUser && (
                    <>
                      <FeedbackButton
                        active={m.feedback === 1}
                        label="Good reply"
                        onClick={() => feedback.mutate({ messageId: m.id, value: m.feedback === 1 ? null : 1 })}
                      >
                        <ThumbsUp className="size-3.5" />
                      </FeedbackButton>
                      <FeedbackButton
                        active={m.feedback === -1}
                        label="Bad reply"
                        onClick={() => feedback.mutate({ messageId: m.id, value: m.feedback === -1 ? null : -1 })}
                      >
                        <ThumbsDown className="size-3.5" />
                      </FeedbackButton>
                      {m.executionId && (
                        <Link href={`/logs/${m.executionId}`} className="hover:underline">
                          View run
                        </Link>
                      )}
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function FeedbackButton({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn("rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800", active && "bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-100")}
    >
      {children}
    </button>
  );
}
