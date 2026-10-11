"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { ChatView } from "@/components/chat/chat-view";
import { TracePanel } from "@/components/chat/trace-panel";
import { type SendFn, useChat } from "@/components/chat/use-chat";
import { Badge, Button, Card, Field, Hint, Input, Notice, Select, Tabs, Textarea, Toggle } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { type Agent, type AgentConfig, type RunEvent, useAgent, useKnowledgeBases, useModels, useToolList } from "@/lib/agents";
import { postSse } from "@/lib/sse";
import { useEditor } from "./editor-context";

type Section = "identity" | "instructions" | "model" | "knowledge" | "tools" | "settings";
type SaveState = "saved" | "saving" | "unsaved" | "conflict" | "error";

export default function BuildPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agent } = useAgent(id);
  if (!agent) return null;
  return <Builder key={agent.id} agent={agent} />;
}

function Builder({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const { setFlush } = useEditor();
  const [section, setSection] = useState<Section>("instructions");
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [config, setConfig] = useState<AgentConfig>(agent.draftConfig);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);

  const revision = useRef(agent.draftRevision);
  const pending = useRef<null | { name: string; description: string; config: AgentConfig }>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  const save = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (inFlight.current) await inFlight.current;
    const payload = pending.current;
    if (!payload) return;
    pending.current = null;
    setSaveState("saving");
    inFlight.current = (async () => {
      try {
        const updated = await api<Agent>(`/api/v1/agents/${agent.id}`, {
          method: "PATCH",
          body: JSON.stringify({ draftRevision: revision.current, name: payload.name, description: payload.description || null, draftConfig: payload.config }),
        });
        revision.current = updated.draftRevision;
        setSaveState(pending.current ? "unsaved" : "saved");
        setSaveError(null);
        queryClient.invalidateQueries({ queryKey: ["agent", agent.id] });
      } catch (err) {
        if (err instanceof ApiError && err.code === "draft_conflict") setSaveState("conflict");
        else {
          setSaveState("error");
          setSaveError(err instanceof ApiError ? err.message : "Couldn't save. Check your connection.");
          pending.current ??= payload; // retry on next change or publish
        }
      } finally {
        inFlight.current = null;
      }
    })();
    await inFlight.current;
  }, [agent.id, queryClient]);

  // Debounced autosave whenever the user edits.
  const schedule = (next: { name?: string; description?: string; config?: AgentConfig }) => {
    const merged = { name: next.name ?? name, description: next.description ?? description, config: next.config ?? config };
    pending.current = merged;
    setSaveState("unsaved");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 800);
  };

  const updateConfig = (fn: (c: AgentConfig) => AgentConfig) => {
    const next = fn(config);
    setConfig(next);
    schedule({ config: next });
  };

  useEffect(() => {
    setFlush(save);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (pending.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      setFlush(null);
      window.removeEventListener("beforeunload", beforeUnload);
      void save();
    };
  }, [save, setFlush]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
      <div className="min-w-0">
        <div className="mb-4 flex items-center justify-between gap-2">
          <Tabs
            value={section}
            onChange={setSection}
            items={[
              { value: "instructions", label: "Instructions" },
              { value: "identity", label: "Identity" },
              { value: "model", label: "Model" },
              { value: "knowledge", label: "Knowledge" },
              { value: "tools", label: "Tools" },
              { value: "settings", label: "Settings" },
            ]}
          />
          <SaveIndicator state={saveState} />
        </div>
        {saveState === "conflict" && (
          <Notice tone="warning">
            Someone else edited this agent.{" "}
            <button className="font-medium underline" onClick={() => window.location.reload()}>
              Reload
            </button>{" "}
            to see their changes (your latest edit wasn&apos;t saved).
          </Notice>
        )}
        {saveState === "error" && saveError && <Notice tone="warning">{saveError}</Notice>}
        <Card className="mt-3 space-y-5">
          {section === "identity" && (
            <IdentitySection
              name={name}
              description={description}
              config={config}
              onName={(v) => {
                setName(v);
                schedule({ name: v });
              }}
              onDescription={(v) => {
                setDescription(v);
                schedule({ description: v });
              }}
              updateConfig={updateConfig}
            />
          )}
          {section === "instructions" && <InstructionsSection config={config} updateConfig={updateConfig} />}
          {section === "model" && <ModelSection config={config} updateConfig={updateConfig} />}
          {section === "knowledge" && <KnowledgeSection config={config} updateConfig={updateConfig} />}
          {section === "tools" && <ToolsSection config={config} updateConfig={updateConfig} />}
          {section === "settings" && <SettingsSection config={config} updateConfig={updateConfig} />}
        </Card>
      </div>
      <Playground agentId={agent.id} hasPublished={Boolean(agent.publishedVersionId)} flush={save} welcome={config.messages.welcome} />
    </div>
  );
}

function SaveIndicator({ state }: { state: SaveState }) {
  const label = { saved: "All changes saved", saving: "Saving…", unsaved: "Unsaved changes", conflict: "Not saved", error: "Not saved" }[state];
  return <span className={`shrink-0 text-xs ${state === "error" || state === "conflict" ? "text-red-600" : "text-[var(--muted)]"}`}>{label}</span>;
}

type SectionProps = { config: AgentConfig; updateConfig: (fn: (c: AgentConfig) => AgentConfig) => void };

function IdentitySection({
  name,
  description,
  onName,
  onDescription,
  config,
  updateConfig,
}: SectionProps & { name: string; description: string; onName: (v: string) => void; onDescription: (v: string) => void }) {
  return (
    <>
      <Field label="Agent name" htmlFor="name" hint="Shown to people chatting with the agent.">
        <Input id="name" value={name} maxLength={80} onChange={(e) => onName(e.target.value)} />
      </Field>
      <Field label="Description" htmlFor="description" hint="For your team; customers don't see this.">
        <Textarea id="description" value={description} maxLength={500} className="min-h-16" onChange={(e) => onDescription(e.target.value)} />
      </Field>
      <Field label="Role" htmlFor="role" hint='What the agent is, e.g. "Customer support assistant for Acme".'>
        <Input id="role" value={config.identity.role ?? ""} maxLength={200} onChange={(e) => updateConfig((c) => ({ ...c, identity: { ...c.identity, role: e.target.value } }))} />
      </Field>
      <Field label="Tone" htmlFor="tone" hint='e.g. "Friendly and concise" or "Formal and precise".'>
        <Input id="tone" value={config.identity.tone ?? ""} maxLength={200} onChange={(e) => updateConfig((c) => ({ ...c, identity: { ...c.identity, tone: e.target.value } }))} />
      </Field>
    </>
  );
}

function InstructionsSection({ config, updateConfig }: SectionProps) {
  const vars = config.variables ?? {};
  const used = [...new Set([...config.instructions.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!))];
  return (
    <>
      <Field
        label="Instructions"
        htmlFor="instructions"
        hint={
          <>
            Describe what the agent should do, what it must never do, and when to hand off to a human. Use <code>{"{{name}}"}</code> for values you want to fill in below.
          </>
        }
      >
        <Textarea
          id="instructions"
          value={config.instructions}
          onChange={(e) => updateConfig((c) => ({ ...c, instructions: e.target.value }))}
          className="min-h-72 font-mono text-[13px]"
          maxLength={20_000}
          placeholder={"You help customers of Acme with questions about orders and returns.\nAlways check the knowledge base before answering.\nIf you don't know, say so and offer to connect them with support@acme.com."}
        />
      </Field>
      {used.length > 0 && (
        <div>
          <p className="mb-2 text-sm font-medium">Values</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {used.map((k) => (
              <Field key={k} label={k} htmlFor={`var-${k}`}>
                <Input id={`var-${k}`} value={vars[k] ?? ""} maxLength={2000} onChange={(e) => updateConfig((c) => ({ ...c, variables: { ...(c.variables ?? {}), [k]: e.target.value } }))} />
              </Field>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ModelSection({ config, updateConfig }: SectionProps) {
  const { data } = useModels();
  const models = data?.data ?? [];
  const current = models.find((m) => m.id === config.model.modelId);
  const tierLabel = { fast: "Fast & low cost", balanced: "Balanced", premium: "Most capable" };
  return (
    <>
      <Field label="Model" htmlFor="model" hint="Faster models cost less; more capable models handle complex questions and tools better.">
        <Select id="model" value={config.model.modelId} onChange={(e) => updateConfig((c) => ({ ...c, model: { ...c.model, modelId: e.target.value } }))}>
          <option value="">Choose a model</option>
          {(["fast", "balanced", "premium"] as const).map((tier) => (
            <optgroup key={tier} label={tierLabel[tier]}>
              {models
                .filter((m) => m.tier === tier)
                .map((m) => (
                  <option key={m.id} value={m.id} disabled={!m.allowedOnPlan || !m.hasKey}>
                    {m.displayName} {!m.allowedOnPlan ? "(upgrade required)" : !m.hasKey ? "(no API key)" : ""}
                  </option>
                ))}
            </optgroup>
          ))}
        </Select>
      </Field>
      {current && !current.allowedOnPlan && <Notice tone="warning">This model isn&apos;t included in your plan. Choose another model.</Notice>}
      {current && current.allowedOnPlan && !current.hasKey && (
        <Notice tone="warning">
          There&apos;s no API key for {current.displayName}. Choose another model, or add a key in{" "}
          <Link href="/settings/ai" className="underline">
            Settings → AI models
          </Link>
          .
        </Notice>
      )}
      {current?.supportsTemperature !== false && (
        <Field label={`Creativity: ${config.model.temperature ?? "default"}`} htmlFor="temperature" hint="Lower = more consistent answers. Higher = more varied wording.">
          <input
            id="temperature"
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={config.model.temperature ?? 0.3}
            onChange={(e) => updateConfig((c) => ({ ...c, model: { ...c.model, temperature: Number(e.target.value) } }))}
            className="w-full accent-brand-600"
          />
        </Field>
      )}
      <Field label="Maximum answer length (tokens)" htmlFor="max-out" hint="About 750 words per 1,000 tokens. Leave empty for the model default.">
        <Input
          id="max-out"
          type="number"
          min={64}
          max={16000}
          value={config.model.maxOutputTokens ?? ""}
          onChange={(e) => updateConfig((c) => ({ ...c, model: { ...c.model, maxOutputTokens: e.target.value ? Number(e.target.value) : undefined } }))}
        />
      </Field>
      <Hint>
        Using your own provider key? Set it up in <Link href="/settings/ai" className="underline">Settings → AI models</Link>.
      </Hint>
    </>
  );
}

function KnowledgeSection({ config, updateConfig }: SectionProps) {
  const { data } = useKnowledgeBases();
  const kbs = data?.data ?? [];
  const selected = new Set(config.knowledge.knowledgeBaseIds);
  return (
    <>
      <div>
        <p className="mb-2 text-sm font-medium">Knowledge bases this agent can use</p>
        {kbs.length === 0 ? (
          <Notice>
            You don&apos;t have any knowledge yet. <Link href="/knowledge" className="font-medium underline">Add documents</Link> like FAQs, policies or product guides.
          </Notice>
        ) : (
          <ul className="space-y-2">
            {kbs.map((kb) => (
              <li key={kb.id}>
                <label className="flex items-center gap-3 rounded-md border border-[var(--border)] px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-brand-600"
                    checked={selected.has(kb.id)}
                    onChange={(e) =>
                      updateConfig((c) => ({
                        ...c,
                        knowledge: {
                          ...c.knowledge,
                          knowledgeBaseIds: e.target.checked ? [...c.knowledge.knowledgeBaseIds, kb.id] : c.knowledge.knowledgeBaseIds.filter((x) => x !== kb.id),
                        },
                      }))
                    }
                  />
                  <span className="flex-1">{kb.name}</span>
                  <span className="text-xs text-[var(--muted)]">
                    {kb.readyCount}/{kb.documentCount} documents ready
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Field label="How should the agent use knowledge?" htmlFor="kb-mode">
        <Select id="kb-mode" value={config.knowledge.mode} onChange={(e) => updateConfig((c) => ({ ...c, knowledge: { ...c.knowledge, mode: e.target.value as "auto" | "always" } }))}>
          <option value="auto">Search when needed (recommended)</option>
          <option value="always">Always look up before answering</option>
        </Select>
        <Hint>&quot;Always look up&quot; suits FAQ-style agents. &quot;When needed&quot; suits agents that also use tools or chat casually.</Hint>
      </Field>
      <Field label={`Passages per search: ${config.knowledge.topK}`} htmlFor="topk">
        <input id="topk" type="range" min={1} max={12} value={config.knowledge.topK} onChange={(e) => updateConfig((c) => ({ ...c, knowledge: { ...c.knowledge, topK: Number(e.target.value) } }))} className="w-full accent-brand-600" />
      </Field>
    </>
  );
}

function ToolsSection({ config, updateConfig }: SectionProps) {
  const { data } = useToolList();
  const tools = data?.data ?? [];
  const binding = (id: string) => config.tools.find((t) => t.toolId === id);
  return (
    <>
      <p className="text-sm text-[var(--muted)]">Tools let the agent look things up or take actions in your systems, like checking an order status.</p>
      {tools.length === 0 ? (
        <Notice>
          No tools yet. <Link href="/tools" className="font-medium underline">Connect an API</Link> to give the agent actions.
        </Notice>
      ) : (
        <ul className="space-y-2">
          {tools.map((t) => {
            const b = binding(t.id);
            return (
              <li key={t.id} className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1 accent-brand-600"
                    checked={Boolean(b)}
                    onChange={(e) =>
                      updateConfig((c) => ({ ...c, tools: e.target.checked ? [...c.tools, { toolId: t.id }] : c.tools.filter((x) => x.toolId !== t.id) }))
                    }
                  />
                  <span className="flex-1">
                    <span className="font-medium">{t.name}</span> <Badge className="ml-1">{t.providerKey === "send_email" ? "EMAIL" : t.config.method}</Badge>
                    <span className="mt-0.5 block text-xs text-[var(--muted)]">{t.description}</span>
                  </span>
                </label>
                {b && (
                  <div className="mt-2 ml-7">
                    <Toggle
                      label="Require human approval (the agent won't run it on its own)"
                      checked={Boolean(b.requiresApproval)}
                      onChange={(v) => updateConfig((c) => ({ ...c, tools: c.tools.map((x) => (x.toolId === t.id ? { ...x, requiresApproval: v } : x)) }))}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function SettingsSection({ config, updateConfig }: SectionProps) {
  return (
    <>
      <Field label="Welcome message" htmlFor="welcome" hint="First message people see in the chat.">
        <Input id="welcome" value={config.messages.welcome ?? ""} maxLength={1000} onChange={(e) => updateConfig((c) => ({ ...c, messages: { ...c.messages, welcome: e.target.value || undefined } }))} />
      </Field>
      <Field label="Fallback message" htmlFor="fallback" hint="Used when the agent can't help or something goes wrong.">
        <Input id="fallback" value={config.messages.fallback ?? ""} maxLength={1000} onChange={(e) => updateConfig((c) => ({ ...c, messages: { ...c.messages, fallback: e.target.value || undefined } }))} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Conversation memory" htmlFor="history" hint="Earlier messages the agent remembers.">
          <Input id="history" type="number" min={0} max={50} value={config.memory.maxHistoryMessages} onChange={(e) => updateConfig((c) => ({ ...c, memory: { maxHistoryMessages: Number(e.target.value) } }))} />
        </Field>
        <Field label="Max steps per answer" htmlFor="steps" hint="Limits tool calls per reply.">
          <Input id="steps" type="number" min={1} max={15} value={config.limits.maxSteps} onChange={(e) => updateConfig((c) => ({ ...c, limits: { ...c.limits, maxSteps: Number(e.target.value) } }))} />
        </Field>
        <Field label="Time limit (seconds)" htmlFor="timeout">
          <Input
            id="timeout"
            type="number"
            min={5}
            max={120}
            value={Math.round(config.limits.timeoutMs / 1000)}
            onChange={(e) => updateConfig((c) => ({ ...c, limits: { ...c.limits, timeoutMs: Number(e.target.value) * 1000 } }))}
          />
        </Field>
      </div>
    </>
  );
}

function Playground({ agentId, hasPublished, flush, welcome }: { agentId: string; hasPublished: boolean; flush: () => Promise<void>; welcome?: string }) {
  const [version, setVersion] = useState<"draft" | "published">("draft");
  const send: SendFn = useCallback(
    async (message, conversationId, onEvent, signal) => {
      if (version === "draft") await flush();
      await postSse<RunEvent>(`/api/v1/agents/${agentId}/test`, { message, conversationId, version }, onEvent, { signal });
    },
    [agentId, flush, version],
  );
  const chat = useChat(send);

  return (
    <Card className="flex h-[calc(100vh-14rem)] min-h-[480px] flex-col p-0 lg:sticky lg:top-6">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-2.5">
        <p className="text-sm font-medium">Test your agent</p>
        <div className="flex items-center gap-2">
          <Select
            aria-label="Version to test"
            value={version}
            onChange={(e) => {
              setVersion(e.target.value as "draft" | "published");
              chat.reset();
            }}
            className="h-8 w-auto text-xs"
          >
            <option value="draft">Draft</option>
            <option value="published" disabled={!hasPublished}>
              Live version
            </option>
          </Select>
          <Button variant="ghost" size="sm" onClick={chat.reset} aria-label="Start a new conversation">
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </div>
      <ChatView
        messages={chat.messages}
        busy={chat.busy}
        onSend={chat.sendMessage}
        onStop={chat.stop}
        welcome={welcome}
        placeholder="Ask something a customer would ask…"
        renderFooter={(m) => (m.events?.length ? <TracePanel events={m.events} /> : null)}
      />
      <p className="border-t border-[var(--border)] px-4 py-2 text-[11px] text-[var(--muted)]">Test conversations use AI credits but don&apos;t count toward your monthly message limit.</p>
    </Card>
  );
}
