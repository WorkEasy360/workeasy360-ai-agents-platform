"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Square } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ChatMessage } from "./use-chat";

interface ChatViewProps {
  messages: ChatMessage[];
  busy: boolean;
  onSend: (text: string) => void;
  onStop?: () => void;
  welcome?: string | null;
  placeholder?: string;
  primaryColor?: string;
  /** Extra content under an assistant message (playground trace, feedback buttons). */
  renderFooter?: (m: ChatMessage) => React.ReactNode;
  className?: string;
}

/** Message list + composer. Used by the playground, the hosted page and the widget. */
export function ChatView({ messages, busy, onSend, onStop, welcome, placeholder = "Type a message…", primaryColor, renderFooter, className }: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const submit = () => {
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft("");
    inputRef.current?.focus();
  };

  const accent = primaryColor ?? "var(--color-brand-600)";

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {welcome && (
          <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-slate-100 px-3.5 py-2.5 text-sm dark:bg-slate-800">{welcome}</div>
        )}
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-tr-sm px-3.5 py-2.5 text-sm whitespace-pre-wrap text-white" style={{ background: accent }}>
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="max-w-[90%]">
              <div className="rounded-2xl rounded-tl-sm bg-slate-100 px-3.5 py-2.5 text-sm whitespace-pre-wrap dark:bg-slate-800">
                {m.text || (m.pending ? <TypingDots /> : null)}
                {m.error && <p className="mt-1 text-red-600 dark:text-red-400">{m.error}</p>}
              </div>
              {m.citations && m.citations.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.citations.map((c) => (
                    <span key={c.documentId} className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--muted)]">
                      <FileText className="size-3" aria-hidden />
                      {c.title}
                    </span>
                  ))}
                </div>
              )}
              {renderFooter?.(m)}
            </div>
          ),
        )}
      </div>
      <form
        className="border-t border-[var(--border)] p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-end gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 focus-within:outline-2 focus-within:outline-brand-500">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={placeholder}
            aria-label="Message"
            maxLength={4000}
            className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
          />
          {busy && onStop ? (
            <button type="button" onClick={onStop} aria-label="Stop" className="grid size-9 place-items-center rounded-lg bg-slate-200 dark:bg-slate-700">
              <Square className="size-4" />
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || busy} aria-label="Send" className="grid size-9 place-items-center rounded-lg text-white disabled:opacity-40" style={{ background: accent }}>
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1 py-1" aria-label="Thinking">
      {[0, 1, 2].map((i) => (
        <span key={i} className="size-1.5 animate-bounce rounded-full bg-[var(--muted)]" style={{ animationDelay: `${i * 120}ms` }} />
      ))}
    </span>
  );
}
