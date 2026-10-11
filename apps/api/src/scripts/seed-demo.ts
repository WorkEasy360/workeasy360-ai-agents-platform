/**
 * Local demo data: a fictional dental clinic ("Sunrise Dental Clinic, Pune") with real PDF, Word,
 * Markdown and CSV documents, a knowledge base, two tools, three published agents and a saved template.
 *
 *   pnpm --filter @we360/api demo:seed --org <organization id> [--reset]
 *
 * Also writes the sample files to ./demo-data so you can try uploading them yourself.
 * Local development only: it upgrades the org to the Professional plan so the demo fits.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { and, eq, inArray, isNull, like, max, ne } from "drizzle-orm";
import { adminDb, closeDb, withTenant } from "@we360/db";
import {
  agentTemplates,
  agentVersionKnowledge,
  agentVersions,
  agentVersionTools,
  agents,
  aiModels,
  deployments,
  documents,
  knowledgeBases,
  organization,
  tools,
  workspaces,
} from "@we360/db/schema";
import { closeQueues } from "../lib/queue";
import { documentKey, putObject } from "../lib/storage";
import { hashConfig, parseAgentConfig } from "../modules/agents/agent-config";
import { ingestDocument } from "../modules/knowledge/ingestion";
import { inputSchemaFromParams } from "../runtime/tools/http-request";
import { EMAIL_INPUT_SCHEMA } from "../runtime/tools/send-email";
import { makeDocx, makePdf } from "./demo/files";

const { values } = parseArgs({ options: { org: { type: "string" }, reset: { type: "boolean", default: false } } });
const orgId = values.org;
if (!orgId) throw new Error("--org <organization id> is required");
if (process.env.NODE_ENV === "production") throw new Error("Demo data is for local development only");

const DEMO = "(demo)";
const KB_NAME = `Sunrise Dental Clinic ${DEMO}`;

/* ------------------------------- Demo documents ------------------------------- */

const faqMd = `# Sunrise Dental Clinic - Frequently asked questions

## Where are you located?
Sunrise Dental Clinic, 2nd floor, Lotus Plaza, FC Road, Shivajinagar, Pune 411005. Nearest metro: Shivajinagar station (5 minutes walk). Free parking for 2-wheelers; paid car parking in Lotus Plaza basement.

## How do I book an appointment?
Call +91 20 4000 1234, WhatsApp +91 98220 12345, or ask our online assistant to send a booking request. The front desk confirms every booking by phone within 2 working hours.

## Do you treat children?
Yes. Dr. Meera Kulkarni is our pediatric dentist and sees children from age 2. Children's appointments are on Tuesday, Thursday and Saturday mornings.

## Do you handle dental emergencies?
Yes. For severe pain, swelling or a broken tooth, call the emergency line +91 98220 99999. Same-day emergency slots are kept free every day until 4 pm.

## Which payment methods do you accept?
UPI, all major credit and debit cards, net banking and cash. No-cost EMI is available on treatments above Rs 15,000 through Bajaj Finserv.

## Do you accept dental insurance?
We are cashless partners with Star Health and HDFC ERGO. For other insurers we provide all documents for reimbursement.

## Is teeth whitening safe?
Yes, when done by a dentist. We use in-clinic LED whitening; results last 1-2 years. It is not recommended during pregnancy.
`;

const servicesCsv = `Service,Price (INR),Duration,Notes
Consultation and check-up,500,20 min,Free for children under 12
Scaling and polishing (cleaning),1500,45 min,Recommended every 6 months
Tooth-coloured filling,1800,40 min,Per tooth
Root canal treatment (front tooth),6500,2 visits,Crown charged separately
Root canal treatment (back tooth),8500,2-3 visits,Crown charged separately
Zirconia crown,12000,2 visits,10 year warranty
Tooth extraction (simple),1200,30 min,
Wisdom tooth surgery,6000,60 min,Includes follow-up visit
Teeth whitening (in-clinic LED),9000,90 min,Single session
Clear aligners (full treatment),120000,12-18 months,EMI available
Dental implant (single),35000,3-6 months,Includes crown
Kids fluoride application,800,20 min,Age 3-14
`;

const policiesPdf = [
  "Sunrise Dental Clinic - Patient Policies (effective 1 April 2026)",
  "",
  "1. Appointments and cancellations",
  "Please arrive 10 minutes before your appointment. Cancellations or changes are free up to",
  "24 hours before the appointment. Cancellations with less than 24 hours notice, or missed",
  "appointments, are charged Rs 300, which is adjusted against your next treatment.",
  "",
  "2. Refunds",
  "Advance payments for treatments not yet started are refunded in full within 7 working days",
  "to the original payment method. Once a treatment has started, the amount for completed",
  "stages is not refundable. Lab fees for crowns and aligners are non-refundable once the",
  "lab order is placed.",
  "",
  "3. Treatment warranty",
  "Fillings have a 1 year warranty and zirconia crowns a 10 year warranty against",
  "manufacturing defects, provided you attend a check-up every 6 months.",
  "",
  "4. Medical history and consent",
  "Inform the dentist about pregnancy, heart conditions, diabetes, allergies and blood",
  "thinners before treatment. Written consent is required for surgical procedures.",
  "",
  "5. Sterilisation",
  "All instruments are sterilised in a Class B autoclave. Single-use items are never reused.",
  "",
  "6. Privacy",
  "Your records are confidential and shared only with your consent or as required by law.",
];

const teamDocx = [
  "# Clinic team and timings",
  "Clinic hours: Monday to Saturday, 9:30 am to 8:00 pm. Sunday: emergencies only, 10 am to 1 pm.",
  "Lunch break: 1:30 pm to 2:30 pm (emergency line stays open).",
  "# Our dentists",
  "Dr. Arjun Deshpande (BDS, MDS Endodontics) - Root canal and crown specialist. Available Monday to Friday.",
  "Dr. Meera Kulkarni (BDS, MDS Pedodontics) - Children's dentist. Tuesday, Thursday and Saturday mornings.",
  "Dr. Sameer Joshi (BDS, MDS Oral Surgery) - Implants and wisdom tooth surgery. Monday, Wednesday and Friday.",
  "Dr. Priya Nair (BDS) - General dentistry, cleaning and fillings. Monday to Saturday.",
  "# Languages",
  "Our team speaks English, Hindi and Marathi.",
  "# Contact",
  "Front desk: +91 20 4000 1234. WhatsApp: +91 98220 12345. Email: care@sunrisedental.example",
];

const files = [
  { name: "clinic-faq.md", mime: "text/markdown", data: Buffer.from(faqMd, "utf8") },
  { name: "services-and-prices.csv", mime: "text/csv", data: Buffer.from(servicesCsv, "utf8") },
  { name: "patient-policies.pdf", mime: "application/pdf", data: makePdf(policiesPdf) },
  {
    name: "team-and-timings.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    data: makeDocx(teamDocx),
  },
];

/* ---------------------------------- Helpers ---------------------------------- */

const db = adminDb();

async function publish(agentId: string, workspaceOrg: string, configInput: unknown, note: string) {
  const config = parseAgentConfig(configInput);
  return withTenant(workspaceOrg, async (tx) => {
    const [{ latest } = { latest: 0 }] = await tx.select({ latest: max(agentVersions.versionNo) }).from(agentVersions).where(eq(agentVersions.agentId, agentId));
    const [v] = await tx
      .insert(agentVersions)
      .values({ orgId: workspaceOrg, agentId, versionNo: (latest ?? 0) + 1, config, configHash: hashConfig(config), changeNote: note })
      .returning();
    if (config.tools.length) {
      await tx.insert(agentVersionTools).values(config.tools.map((t) => ({ orgId: workspaceOrg, agentVersionId: v!.id, toolId: t.toolId })));
    }
    if (config.knowledge.knowledgeBaseIds.length) {
      await tx
        .insert(agentVersionKnowledge)
        .values(config.knowledge.knowledgeBaseIds.map((kb) => ({ orgId: workspaceOrg, agentVersionId: v!.id, knowledgeBaseId: kb })));
    }
    await tx.update(agents).set({ publishedVersionId: v!.id, draftConfig: config }).where(eq(agents.id, agentId));
    return v!;
  });
}

/* ----------------------------------- Seed ------------------------------------ */

const [org] = await db.select().from(organization).where(eq(organization.id, orgId));
if (!org) throw new Error(`Organization ${orgId} not found`);
const [ws] = await db.select().from(workspaces).where(and(eq(workspaces.orgId, orgId), isNull(workspaces.deletedAt)));
if (!ws) throw new Error("Organization has no workspace");

const [existing] = await db.select().from(knowledgeBases).where(and(eq(knowledgeBases.orgId, orgId), eq(knowledgeBases.name, KB_NAME), isNull(knowledgeBases.deletedAt)));
if (existing && !values.reset) {
  console.log("Demo data already exists. Re-run with --reset to recreate it.");
  await closeQueues();
  await closeDb();
  process.exit(0);
}
if (values.reset) {
  const now = new Date();
  const demoAgents = await db
    .update(agents)
    .set({ deletedAt: now, status: "disabled" })
    .where(and(eq(agents.orgId, orgId), like(agents.name, `%${DEMO}%`), isNull(agents.deletedAt)))
    .returning({ id: agents.id });
  if (demoAgents.length) {
    await db.update(deployments).set({ deletedAt: now, status: "paused" }).where(inArray(deployments.agentId, demoAgents.map((a) => a.id)));
  }
  await db.update(knowledgeBases).set({ deletedAt: now }).where(and(eq(knowledgeBases.orgId, orgId), eq(knowledgeBases.name, KB_NAME)));
  await db.update(tools).set({ deletedAt: now }).where(and(eq(tools.orgId, orgId), like(tools.description, `%${DEMO}%`)));
  await db.update(agentTemplates).set({ deletedAt: now }).where(and(eq(agentTemplates.orgId, orgId), like(agentTemplates.name, `%${DEMO}%`)));
  console.log("Removed previous demo data.");
}

// Professional plan so several agents, the API and storage fit (local demo only).
await db.update(organization).set({ planKey: "professional" }).where(eq(organization.id, orgId));
console.log(`Organization "${org.name}" set to the Professional plan (local demo).`);

const [gemini] = await db.select().from(aiModels).where(and(eq(aiModels.provider, "google"), eq(aiModels.modelKey, "gemini-2.5-flash")));
if (!gemini) throw new Error("Model gemini-2.5-flash is missing; run pnpm db:seed");

// Sample files for manual upload tests.
const outDir = path.resolve(process.cwd(), "../../demo-data/sunrise-dental");
mkdirSync(outDir, { recursive: true });
for (const f of files) writeFileSync(path.join(outDir, f.name), f.data);
console.log(`Wrote sample files to ${outDir}`);

// Knowledge base + documents (embedded now, with the org's key).
const [kb] = await withTenant(orgId, (tx) =>
  tx.insert(knowledgeBases).values({ orgId, workspaceId: ws.id, name: KB_NAME, description: "FAQ, prices, policies and team details for the demo clinic." }).returning(),
);
for (const f of files) {
  const id = randomUUID();
  const key = documentKey(orgId, kb!.id, id);
  await putObject(key, f.data, f.mime);
  await withTenant(orgId, (tx) =>
    tx.insert(documents).values({ id, orgId, knowledgeBaseId: kb!.id, sourceType: "file", title: f.name, storageKey: key, mimeType: f.mime, sizeBytes: f.data.length, status: "queued" }),
  );
  await ingestDocument(orgId, id);
  const [doc] = await withTenant(orgId, (tx) => tx.select({ status: documents.status, chunks: documents.chunkCount, error: documents.error }).from(documents).where(eq(documents.id, id)));
  console.log(`  ${f.name}: ${doc?.status} (${doc?.chunks} sections)${doc?.error ? ` - ${doc.error}` : ""}`);
}

// Re-process the org's older documents: they were embedded by the local mock model, whose
// vectors can't be compared with real Gemini/OpenAI ones.
const stale = await withTenant(orgId, (tx) =>
  tx
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(isNull(documents.deletedAt), ne(documents.knowledgeBaseId, kb!.id))),
);
for (const d of stale) {
  await ingestDocument(orgId, d.id).catch(() => undefined);
  console.log(`  Re-processed older document: ${d.title}`);
}

// Tools.
const [emailTool] = await withTenant(orgId, (tx) =>
  tx
    .insert(tools)
    .values({
      orgId,
      workspaceId: ws.id,
      providerKey: "send_email",
      operationKey: "send",
      name: "notify_front_desk",
      description: `Email the clinic front desk with an appointment request once the patient has confirmed all details ${DEMO}.`,
      inputSchema: EMAIL_INPUT_SCHEMA,
      config: { recipients: ["frontdesk@sunrisedental.example"], subjectPrefix: "[Booking request]" },
    })
    .returning(),
);
const weatherParams = [
  { name: "latitude", type: "number" as const, description: "Latitude of the city, e.g. 18.52 for Pune", required: true },
  { name: "longitude", type: "number" as const, description: "Longitude of the city, e.g. 73.86 for Pune", required: true },
];
const [weatherTool] = await withTenant(orgId, (tx) =>
  tx
    .insert(tools)
    .values({
      orgId,
      workspaceId: ws.id,
      providerKey: "http_request",
      operationKey: "request",
      name: "get_weather",
      description: `Get the current weather and today's forecast for a location (latitude/longitude). Free Open-Meteo API ${DEMO}.`,
      inputSchema: inputSchemaFromParams(weatherParams),
      config: {
        method: "GET",
        url: "https://api.open-meteo.com/v1/forecast?current=temperature_2m,precipitation,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=2&timezone=auto",
        headers: {},
        params: weatherParams,
        timeoutMs: 15000,
      },
    })
    .returning(),
);

// Agents.
const model = { modelId: gemini.id, temperature: 0.3 };
const agentDefs = [
  {
    name: `Sunrise Dental - Front Desk ${DEMO}`,
    description: "Answers patient questions from the clinic's documents and sends booking requests to the front desk.",
    config: {
      identity: { role: "Front desk assistant for Sunrise Dental Clinic, Pune", tone: "Warm, reassuring and concise" },
      instructions: [
        "You answer questions from patients of Sunrise Dental Clinic.",
        "- Always search the knowledge base before answering questions about treatments, prices, timings, doctors or policies. Quote prices exactly as listed.",
        "- If something isn't in the knowledge base, say you don't have that information and share the front desk number +91 20 4000 1234.",
        "- To book an appointment, collect one at a time: patient name, phone number, treatment needed, preferred day and time. Read the details back and ask for confirmation.",
        "- After the patient confirms, use notify_front_desk to send the request, then tell them the front desk will call to confirm within 2 working hours.",
        "- For severe pain, swelling or bleeding, give the emergency line +91 98220 99999 straight away.",
        "- Never give a diagnosis. Never promise a confirmed slot yourself.",
      ].join("\n"),
      model,
      knowledge: { knowledgeBaseIds: [kb!.id], mode: "auto", topK: 5 },
      tools: [{ toolId: emailTool!.id }],
      messages: { welcome: "Hi! I'm the Sunrise Dental assistant. Ask me about treatments, prices or timings, or I can help you book a visit.", fallback: "Sorry, I can't help with that here. Please call us on +91 20 4000 1234." },
    },
    channels: ["hosted_page", "web_widget"] as const,
  },
  {
    name: `Sunrise Dental - Hindi + English ${DEMO}`,
    description: "Same clinic knowledge, replies in the patient's language (Hindi, English or Hinglish).",
    config: {
      identity: { role: "Bilingual patient support for Sunrise Dental Clinic", tone: "Friendly and respectful" },
      instructions: [
        "You help patients of Sunrise Dental Clinic, Pune.",
        "Reply in the same language and script the patient uses: Hindi (Devanagari), English or Hinglish.",
        "Search the knowledge base before answering about treatments, prices, timings, doctors or policies, and answer only from what you find.",
        "If you can't help, share the front desk number +91 20 4000 1234.",
      ].join("\n"),
      model,
      knowledge: { knowledgeBaseIds: [kb!.id], mode: "auto", topK: 5 },
      messages: { welcome: "Namaste! Main aapki kya madad kar sakta hoon? / How can I help you today?" },
    },
    channels: ["hosted_page"] as const,
  },
  {
    name: `Field Visit Planner ${DEMO}`,
    description: "Checks live weather (free Open-Meteo API) to help plan site visits. Shows a custom API tool in action.",
    config: {
      identity: { role: "Planning assistant for field sales visits", tone: "Practical and brief" },
      instructions: [
        "You help a sales team plan outdoor client visits.",
        "When the user mentions a city, work out its latitude and longitude yourself and call get_weather.",
        "Summarise: current temperature, rain chances today and tomorrow, and a clear recommendation (go / carry an umbrella / reschedule).",
        "If the tool fails, say the weather service is unavailable and suggest checking again later.",
      ].join("\n"),
      model,
      tools: [{ toolId: weatherTool!.id }],
      messages: { welcome: "Which city are you visiting, and when?" },
    },
    channels: [] as const,
  },
];

const created: Array<{ name: string; id: string; links: string[] }> = [];
for (const def of agentDefs) {
  const config = parseAgentConfig(def.config);
  const [agent] = await withTenant(orgId, (tx) =>
    tx.insert(agents).values({ orgId, workspaceId: ws.id, name: def.name, description: def.description, draftConfig: config }).returning(),
  );
  await publish(agent!.id, orgId, config, "Demo setup");
  const links: string[] = [];
  for (const channel of def.channels) {
    const publicKey = `pk_${randomBytes(18).toString("base64url")}`;
    await withTenant(orgId, (tx) =>
      tx.insert(deployments).values({
        orgId,
        workspaceId: ws.id,
        agentId: agent!.id,
        channel,
        publicKey,
        config: channel === "web_widget" ? { allowedOrigins: ["http://localhost:5500"], theme: { primaryColor: "#0f766e" } } : { title: "Sunrise Dental Clinic" },
      }),
    );
    links.push(channel === "hosted_page" ? `http://localhost:3000/c/${publicKey}` : `widget key ${publicKey}`);
  }
  created.push({ name: def.name, id: agent!.id, links });
}

// A saved template, so "Your templates" isn't empty.
await withTenant(orgId, (tx) =>
  tx.insert(agentTemplates).values({
    orgId,
    workspaceId: ws.id,
    name: `Clinic front desk ${DEMO}`,
    description: "Front desk setup: knowledge search, booking requests by email, emergency handling.",
    config: parseAgentConfig(agentDefs[0]!.config),
  }),
);

console.log("\nDemo agents (published):");
for (const a of created) {
  console.log(`  ${a.name}\n    http://localhost:3000/agents/${a.id}`);
  for (const l of a.links) console.log(`    ${l}`);
}
console.log(`\nSaved template: "Clinic front desk ${DEMO}"`);

await closeQueues();
await closeDb();
