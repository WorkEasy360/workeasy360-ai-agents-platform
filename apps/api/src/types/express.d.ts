import type { AuthSession } from "../auth/auth";

export type OrgRole = "owner" | "admin" | "member";

export interface TenantContext {
  orgId: string;
  workspaceId: string;
  role: OrgRole;
  planKey: string;
}

declare global {
  namespace Express {
    interface Request {
      id: string;
      auth?: AuthSession;
      tenant?: TenantContext;
    }
  }
}

export {};
