"use client";

import { createAuthClient } from "better-auth/react";
import { organizationClient, twoFactorClient } from "better-auth/client/plugins";

// Same origin as the app: requests go to /api/auth/*, proxied to the Express API.
export const authClient = createAuthClient({
  plugins: [organizationClient(), twoFactorClient()],
});
