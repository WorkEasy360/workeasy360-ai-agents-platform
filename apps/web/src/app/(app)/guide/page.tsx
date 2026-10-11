"use client";

import Link from "next/link";
import { BookOpen, Bot, FlaskConical, Gauge, KeyRound, Rocket, ScrollText, Settings, Wrench } from "lucide-react";
import { Card, Notice, PageHeader } from "@/components/ui";

interface Step {
  icon: typeof Bot;
  title: string;
  where: { label: string; href: string };
  points: React.ReactNode[];
}

/** The end-to-end workflow, in the order a new user goes through it. */
const steps: Step[] = [
  {
    icon: KeyRound,
    title: "Connect an AI model",
    where: { label: "Settings → AI models", href: "/settings/ai" },
    points: [
      "Choose a provider (OpenAI, Anthropic or Google Gemini).",
      "Use the included credits, or paste your own API key and switch that provider to “Your own key”. Keys are checked before they're saved.",
      "Knowledge search needs an OpenAI or Gemini key.",
    ],
  },
  {
    icon: BookOpen,
    title: "Add your business knowledge",
    where: { label: "Knowledge", href: "/knowledge" },
    points: [
      "Click New knowledge base, give it a name and drop in your files: PDF, Word (.docx), TXT, Markdown, CSV, HTML or JSON. You can also paste text or add a web page.",
      "Wait until each document shows “ready”. Use “Try a search” to check the right passages come back.",
      "Good content: FAQs, price lists, policies, product guides, timings and contact details.",
    ],
  },
  {
    icon: Wrench,
    title: "Add tools (optional)",
    where: { label: "Tools", href: "/tools" },
    points: [
      "New email tool: lets the agent email your team, e.g. a booking request or a lead. Recipients are fixed by you.",
      "New API tool: lets the agent call one of your systems, e.g. order status. Add the URL, parameters and (under Credentials) the API key, then click Test.",
    ],
  },
  {
    icon: Bot,
    title: "Create an agent",
    where: { label: "Agents → New agent", href: "/agents" },
    points: [
      "“Describe it”: write what the agent should do in plain words and the AI drafts the setup for you.",
      "“Use a template”: start from a built-in template or one you saved yourself (Save as template on any agent).",
    ],
  },
  {
    icon: Settings,
    title: "Configure it",
    where: { label: "Agent → Build tab", href: "/agents" },
    points: [
      <>
        <strong>Instructions:</strong> what to do, what never to do, and when to hand over to a person. Use {"{{company_name}}"}-style values for details you fill in below.
      </>,
      <>
        <strong>Model:</strong> pick one that has a key (models without one show “no API key”).
      </>,
      <>
        <strong>Knowledge:</strong> tick the knowledge bases this agent may use. <strong>Tools:</strong> tick the tools it may use.
      </>,
      <>
        <strong>Settings:</strong> welcome message, fallback message, memory and limits. Everything saves automatically.
      </>,
    ],
  },
  {
    icon: FlaskConical,
    title: "Test it",
    where: { label: "Agent → test chat (right side)", href: "/agents" },
    points: [
      "Ask what a real customer would ask. Click the “N steps” line under an answer to see which documents and tools it used, how long it took and what it cost.",
      "Not right? Improve the instructions or the documents and test again. Use the reset button for a fresh conversation.",
    ],
  },
  {
    icon: Rocket,
    title: "Publish and share",
    where: { label: "Publish button, then the Deploy tab", href: "/agents" },
    points: [
      "Publish creates a version. Only published versions are live; your later edits stay as a draft until you publish again.",
      "Deploy tab: turn on a Chat page (a shareable link), the Website widget (paste one script tag; add your site under Allowed websites) or the API (create a key in Settings → API keys).",
      "Made a mistake? Versions tab → “Make live” on an earlier version.",
    ],
  },
  {
    icon: ScrollText,
    title: "Monitor and improve",
    where: { label: "Agent → Monitor tab, and Logs", href: "/logs" },
    points: [
      "Monitor shows messages, success rate, response time and cost per day.",
      "Logs shows every conversation and every run step by step. Look for wrong or missing answers and add that information to your knowledge.",
    ],
  },
  {
    icon: Gauge,
    title: "Keep an eye on usage",
    where: { label: "Usage", href: "/usage" },
    points: ["See messages, AI credits, agents and storage against your plan limits. Test chats use credits but don't count as messages."],
  },
];

const faqs: Array<{ q: string; a: React.ReactNode }> = [
  { q: "The agent replies “(Mock model…)”", a: "The server is in local test mode. Set MOCK_LLM=false in .env and restart pnpm dev." },
  {
    q: "“No API key” or “provider isn't configured”",
    a: (
      <>
        The agent's model is from a provider you have no key for. Choose another model in the Build tab, or add a key in{" "}
        <Link href="/settings/ai" className="underline">
          Settings → AI models
        </Link>
        .
      </>
    ),
  },
  { q: "It doesn't use my documents", a: "Check the documents are “ready”, the knowledge base is ticked in the agent's Knowledge tab, and you published after changing it." },
  { q: "My changes don't show on the chat page or widget", a: "The chat page, widget and API only use the published version. Click Publish." },
  { q: "The widget doesn't appear on my site", a: "Add your site's exact address (e.g. https://www.example.com) under Allowed websites on the Deploy tab." },
  { q: "How do I pause or remove an agent?", a: "Use the On/Off switch on the agent page to pause it. The trash icon (admins) deletes it." },
  { q: "How do I add teammates?", a: "Settings → Members → Invite. Owners and admins can manage settings; members can build and test agents." },
  {
    q: "A customer asked for a copy of their chats, or for them to be deleted",
    a: (
      <>
        In{" "}
        <Link href="/settings/privacy" className="underline">
          Settings → Privacy
        </Link>
        , look them up by the user id (the <code>userId</code> you sent through the API, or the visitor id shown in Logs), then download or delete. Visitors can also delete a chat
        themselves with the trash icon in the chat window. The same page sets how long conversations are kept.
      </>
    ),
  },
  { q: "How do I delete my account?", a: "Settings → Security → Delete my account. If you're the only owner of an organization others use, make someone else an owner first." },
];

export default function GuidePage() {
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Guide" description="How to go from zero to a live AI agent, step by step." />
      <Notice>
        New here? Follow the steps in order. Most people have a working agent in about 15 minutes. Everything you change is saved automatically.
      </Notice>

      <ol className="space-y-4">
        {steps.map((s, i) => (
          <li key={s.title}>
            <Card className="p-5">
              <div className="flex items-start gap-4">
                <div className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-brand-100">
                  <s.icon className="size-4" aria-hidden />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="font-medium">
                      {i + 1}. {s.title}
                    </h2>
                    <Link href={s.where.href} className="text-sm text-brand-600 hover:underline">
                      {s.where.label} →
                    </Link>
                  </div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
                    {s.points.map((p, j) => (
                      <li key={j}>{p}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ol>

      <Card className="p-5">
        <h2 className="mb-3 font-medium">Common questions</h2>
        <dl className="space-y-3 text-sm">
          {faqs.map((f) => (
            <div key={f.q}>
              <dt className="font-medium">{f.q}</dt>
              <dd className="mt-0.5 text-[var(--muted)]">{f.a}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
