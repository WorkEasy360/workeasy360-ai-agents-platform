import { ApiError, getActiveOrgId } from "./api";

/**
 * POSTs JSON and reads a Server-Sent Events response, calling `onEvent` per event.
 * (EventSource can't POST, so this parses the stream manually.)
 */
export async function postSse<E extends { type: string }>(
  path: string,
  body: unknown,
  onEvent: (event: E) => void,
  opts: { signal?: AbortSignal; withOrg?: boolean } = {},
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  const orgId = opts.withOrg === false ? null : getActiveOrgId();
  if (orgId) headers["x-org-id"] = orgId;

  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), credentials: "include", signal: opts.signal });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(res.status, err.code ?? "error", err.detail ?? res.statusText);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) onEvent(JSON.parse(data) as E);
    }
  }
}
