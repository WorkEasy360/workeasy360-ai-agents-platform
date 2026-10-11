/** Error shape returned by the API (RFC 9457 problem+json). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

const ORG_KEY = "we360.activeOrgId";

export function getActiveOrgId(): string | null {
  try {
    return localStorage.getItem(ORG_KEY);
  } catch {
    return null;
  }
}

export function setActiveOrgId(orgId: string) {
  try {
    localStorage.setItem(ORG_KEY, orgId);
  } catch {
    // Storage unavailable (private mode); the session's active org is still used.
  }
}

/** Fetches from our API on the same origin, sending the session cookie and active org. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const orgId = getActiveOrgId();
  if (orgId && !headers.has("x-org-id")) headers.set("x-org-id", orgId);

  const res = await fetch(path, { ...init, headers, credentials: "include" });
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

  const body = await res.json().catch(() => ({}));
  throw new ApiError(res.status, body.code ?? "error", body.detail ?? res.statusText, body.errors);
}
