"use client";

import { createContext, useContext, useRef } from "react";

/**
 * Lets the agent header (Publish button) flush the Build page's pending autosave first,
 * so what gets published is exactly what the user sees.
 */
interface EditorContextValue {
  setFlush: (fn: (() => Promise<void>) | null) => void;
  flush: () => Promise<void>;
}

const EditorContext = createContext<EditorContextValue>({ setFlush: () => {}, flush: async () => {} });

export function EditorProvider({ children }: { children: React.ReactNode }) {
  const ref = useRef<(() => Promise<void>) | null>(null);
  return (
    <EditorContext.Provider value={{ setFlush: (fn) => (ref.current = fn), flush: async () => ref.current?.() }}>{children}</EditorContext.Provider>
  );
}

export const useEditor = () => useContext(EditorContext);
