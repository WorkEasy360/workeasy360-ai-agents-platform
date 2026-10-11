"use client";

import { useEffect, useState } from "react";

/**
 * Tab state mirrored in the `?tab=` query string, so links like /logs?tab=conversations work.
 * Reads window.location after mount (avoids a Suspense boundary for useSearchParams).
 */
export function useUrlTab<T extends string>(allowed: readonly T[], fallback: T) {
  const [tab, setTab] = useState<T>(fallback);
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab") as T | null;
    if (t && allowed.includes(t)) setTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  function change(next: T) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }
  return [tab, change] as const;
}
