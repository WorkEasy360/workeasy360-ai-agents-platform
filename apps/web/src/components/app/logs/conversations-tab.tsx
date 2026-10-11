"use client";

import Link from "next/link";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import { Button, EmptyState, FormError, Loading, Table } from "@/components/ui";
import { errorMessage, sourceLabel } from "@/components/app/misc";
import type { ConversationRow, Page } from "@/components/app/types";
import { api } from "@/lib/api";
import { formatDateTime, timeAgo } from "@/lib/format";
import { AgentFilter, qs } from "./shared";

export function ConversationsTab() {
  const [agentId, setAgentId] = useState("");
  const q = useInfiniteQuery({
    queryKey: ["conversations", { agentId }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Page<ConversationRow>>(`/api/v1/conversations${qs({ agentId, cursor: pageParam, limit: "50" })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-4">
      <AgentFilter value={agentId} onChange={setAgentId} />
      <FormError message={errorMessage(q.error)} />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title={agentId ? "No conversations for this agent" : "No conversations yet"}
          description="Conversations from your hosted page, website widget and API appear here once people start chatting."
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>Conversation</th>
                <th>Agent</th>
                <th>Channel</th>
                <th>Visitor</th>
                <th>Started</th>
                <th>Last message</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="max-w-xs min-w-48">
                    <Link
                      href={`/logs/conversations/${c.id}`}
                      className="block truncate font-medium text-brand-700 hover:underline dark:text-brand-100"
                    >
                      {c.title || "Untitled conversation"}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{c.agentName ?? "Deleted agent"}</td>
                  <td className="whitespace-nowrap">{sourceLabel(c.channel)}</td>
                  <td className="whitespace-nowrap text-[var(--muted)]">{c.endUserRef ?? "Anonymous"}</td>
                  <td className="whitespace-nowrap">{formatDateTime(c.createdAt)}</td>
                  <td className="whitespace-nowrap text-[var(--muted)]">{timeAgo(c.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
