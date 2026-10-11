"use client";

import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import type { RunEvent } from "@/lib/agents";
import { cn } from "@/lib/cn";
import { postSse } from "@/lib/sse";
import { ChatView } from "./chat-view";
import { type ChatMessage, type SendFn, useChat } from "./use-chat";

interface PublicConfig {
  channel: "hosted_page" | "web_widget";
  title: string;
  agentName: string;
  avatarUrl: string | null;
  welcomeMessage: string | null;
  theme: { primaryColor?: string; position?: "left" | "right" };
  showBranding: boolean;
  privacyPolicyUrl: string | null;
}

/** localStorage can be unavailable (private mode, blocked storage): never let that break the chat. */
const storage = {
  get(key: string) {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

function visitorId(): string {
  let id = storage.get("we360.visitor");
  if (!id) {
    id = crypto.randomUUID();
    storage.set("we360.visitor", id);
  }
  return id;
}

/** Chat for the hosted page and the widget iframe. Talks to the public (unauthenticated) API. */
export function PublicChat({ publicKey, embedded }: { publicKey: string; embedded?: boolean }) {
  const { data: config, error } = useQuery({
    queryKey: ["public-deployment", publicKey],
    queryFn: async () => {
      const res = await fetch(`/api/public/v1/deployments/${publicKey}`);
      const body = await res.json();
      if (!res.ok) throw new ApiError(res.status, body.code, body.detail);
      return body as PublicConfig;
    },
    retry: false,
  });

  const convKey = `we360.conv.${publicKey}`;
  const send: SendFn = useCallback(
    (message, conversationId, onEvent, signal) =>
      postSse<RunEvent>(`/api/public/v1/deployments/${publicKey}/messages`, { message, conversationId, visitorId: visitorId() }, onEvent, { signal, withOrg: false }),
    [publicKey],
  );
  // Conversations resume across page loads, but the transcript itself isn't stored client-side.
  const chat = useChat(send, { initialConversationId: storage.get(convKey), onConversation: (id) => storage.set(convKey, id) });

  // Lets the visitor erase this conversation on our side (messages and run logs), not just forget it locally.
  async function deleteChat() {
    const id = chat.conversationId.current;
    if (!id || !confirm("Delete this chat? The messages will be removed permanently.")) return;
    await fetch(`/api/public/v1/deployments/${publicKey}/conversations/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ visitorId: visitorId() }),
    }).catch(() => undefined);
    storage.remove(convKey);
    chat.reset();
  }

  if (error) {
    return (
      <div className="grid h-full place-items-center p-6 text-center text-sm text-[var(--muted)]">
        {error instanceof ApiError && error.status === 404 ? "This chat doesn't exist." : "This assistant is unavailable right now. Please try again later."}
      </div>
    );
  }
  if (!config) return <div className="grid h-full place-items-center text-sm text-[var(--muted)]">Loading…</div>;

  const color = config.theme.primaryColor ?? "#2a56e0";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--surface)]">
      <header className="flex items-center gap-3 px-4 py-3 text-white" style={{ background: color }}>
        <div className="grid size-8 place-items-center rounded-full bg-white/20 text-sm font-semibold">{config.agentName.slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{config.title}</p>
          <p className="text-xs text-white/80">Usually replies instantly</p>
        </div>
        {(chat.messages.length > 0 || storage.get(convKey)) && (
          <button className="rounded p-1.5 text-white/90 hover:bg-white/10" onClick={deleteChat} aria-label="Delete this chat" title="Delete this chat">
            <Trash2 className="size-3.5" />
          </button>
        )}
        <button
          className="rounded px-2 py-1 text-xs text-white/90 hover:bg-white/10"
          onClick={() => {
            storage.remove(convKey);
            chat.reset();
          }}
        >
          New chat
        </button>
      </header>
      <ChatView
        messages={chat.messages}
        busy={chat.busy}
        onSend={chat.sendMessage}
        welcome={config.welcomeMessage}
        primaryColor={color}
        renderFooter={(m) => <Feedback publicKey={publicKey} message={m} conversationId={chat.conversationId.current} />}
      />
      <p className="px-4 pb-1 text-center text-[11px] leading-snug text-[var(--muted)]">
        You&apos;re chatting with an AI assistant. Messages are stored to answer you; please don&apos;t share sensitive personal details.
        {config.privacyPolicyUrl && (
          <>
            {" "}
            <a href={config.privacyPolicyUrl} target="_blank" rel="noopener noreferrer" className="underline">
              Privacy policy
            </a>
          </>
        )}
      </p>
      {config.showBranding && (
        <p className={cn("pb-2 text-center text-[11px] text-[var(--muted)]", embedded && "pb-1.5")}>
          Powered by <span className="font-medium">WorkEasy360 Agents</span>
        </p>
      )}
    </div>
  );
}

function Feedback({ publicKey, message, conversationId }: { publicKey: string; message: ChatMessage; conversationId?: string }) {
  const [value, setValue] = useState<1 | -1 | null>(null);
  if (message.pending || message.error || !message.executionId || !conversationId) return null;
  const rate = async (v: 1 | -1) => {
    setValue(v);
    await fetch(`/api/public/v1/deployments/${publicKey}/feedback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ executionId: message.executionId, conversationId, value: v }),
    }).catch(() => undefined);
  };
  return (
    <div className="mt-1 flex gap-1 text-[var(--muted)]">
      <button aria-label="Helpful" onClick={() => rate(1)} className={cn("rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800", value === 1 && "text-green-600")}>
        <ThumbsUp className="size-3.5" />
      </button>
      <button aria-label="Not helpful" onClick={() => rate(-1)} className={cn("rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800", value === -1 && "text-red-600")}>
        <ThumbsDown className="size-3.5" />
      </button>
    </div>
  );
}
