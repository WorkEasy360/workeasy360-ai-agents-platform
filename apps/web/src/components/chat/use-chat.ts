"use client";

import { useCallback, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import type { RunEvent } from "@/lib/agents";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  error?: string;
  citations?: Array<{ title: string; documentId: string }>;
  executionId?: string;
  /** Debug events for the playground trace panel. */
  events?: RunEvent[];
  usage?: Extract<RunEvent, { type: "run.completed" }>["usage"];
}

export type SendFn = (message: string, conversationId: string | undefined, onEvent: (e: RunEvent) => void, signal: AbortSignal) => Promise<void>;

let seq = 0;
const nextId = () => `m${Date.now()}-${seq++}`;

/** Chat state + streaming. The transport (`send`) differs between playground and public pages. */
export function useChat(send: SendFn, opts: { initialConversationId?: string; onConversation?: (id: string) => void } = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const conversationId = useRef<string | undefined>(opts.initialConversationId);
  const abort = useRef<AbortController | null>(null);

  const update = (id: string, fn: (m: ChatMessage) => ChatMessage) => setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      const assistantId = nextId();
      setMessages((ms) => [...ms, { id: nextId(), role: "user", text: trimmed }, { id: assistantId, role: "assistant", text: "", pending: true, events: [] }]);
      setBusy(true);
      abort.current = new AbortController();
      try {
        await send(
          trimmed,
          conversationId.current,
          (ev) => {
            if (ev.type === "run.started") {
              conversationId.current = ev.conversationId;
              opts.onConversation?.(ev.conversationId);
              update(assistantId, (m) => ({ ...m, executionId: ev.executionId }));
            } else if (ev.type === "text.delta") {
              update(assistantId, (m) => ({ ...m, text: m.text + ev.text }));
            } else if (ev.type === "run.completed") {
              update(assistantId, (m) => ({ ...m, text: ev.text, citations: ev.citations, usage: ev.usage, pending: false, events: [...(m.events ?? []), ev] }));
            } else if (ev.type === "run.failed") {
              update(assistantId, (m) => ({ ...m, pending: false, error: ev.message, events: [...(m.events ?? []), ev] }));
            } else {
              update(assistantId, (m) => ({ ...m, events: [...(m.events ?? []), ev] }));
            }
          },
          abort.current.signal,
        );
      } catch (err) {
        const message = err instanceof ApiError ? err.message : (err as Error).name === "AbortError" ? "Stopped." : "Couldn't reach the agent. Check your connection and try again.";
        update(assistantId, (m) => ({ ...m, pending: false, error: message }));
      } finally {
        update(assistantId, (m) => ({ ...m, pending: false }));
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, send],
  );

  const reset = useCallback(() => {
    abort.current?.abort();
    conversationId.current = undefined;
    setMessages([]);
    setBusy(false);
  }, []);

  const stop = useCallback(() => abort.current?.abort(), []);

  return { messages, busy, sendMessage, reset, stop, conversationId };
}
