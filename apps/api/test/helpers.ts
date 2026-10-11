import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app";

export const app = createApp();
const ORIGIN = "http://localhost:3000";

/** Signs up a fresh user and creates an organization. Returns a cookie-carrying agent. */
export async function signUpWithOrg(label: string) {
  const agent = request.agent(app);
  const suffix = randomUUID().slice(0, 8);
  const email = `${label}-${suffix}@test.local`;

  const signUp = await agent
    .post("/api/auth/sign-up/email")
    .set("Origin", ORIGIN)
    .send({ email, password: "correct-horse-battery", name: label });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status} ${signUp.text}`);

  const org = await agent
    .post("/api/auth/organization/create")
    .set("Origin", ORIGIN)
    .send({ name: `${label} org`, slug: `${label}-${suffix}` });
  if (org.status !== 200) throw new Error(`org create failed: ${org.status} ${org.text}`);

  return { agent, email, userId: signUp.body.user.id as string, orgId: org.body.id as string };
}

export { ORIGIN };
