"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Check, Code2, Copy, ExternalLink, Globe, MessageSquare } from "lucide-react";
import { Badge, Button, Card, Field, FormError, Hint, Input, Loading, Notice, Select, Textarea, Toggle } from "@/components/ui";
import { api } from "@/lib/api";
import { type Deployment, useAgent, useDeployments, useVersions } from "@/lib/agents";

type Channel = Deployment["channel"];

const CHANNELS: Array<{ channel: Channel; title: string; description: string; icon: typeof Globe }> = [
  { channel: "hosted_page", title: "Chat page", description: "A ready-made page with a shareable link. No website needed.", icon: MessageSquare },
  { channel: "web_widget", title: "Website widget", description: "A chat bubble on your website. Paste one line of code.", icon: Globe },
  { channel: "api", title: "API", description: "Call the agent from your own app or backend.", icon: Code2 },
];

export default function DeployPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agent } = useAgent(id);
  const { data, isLoading } = useDeployments(id);
  const queryClient = useQueryClient();
  const [createError, setCreateError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (channel: Channel) => api<Deployment>(`/api/v1/agents/${id}/deployments`, { method: "POST", body: JSON.stringify({ channel }) }),
    onSuccess: () => {
      setCreateError(null);
      queryClient.invalidateQueries({ queryKey: ["deployments", id] });
    },
    onError: (err) => setCreateError((err as Error).message),
  });

  if (isLoading || !agent) return <Loading />;
  const deployments = data?.data ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      {!agent.publishedVersion && (
        <Notice tone="warning">Publish the agent first. Channels only serve the published version, never your unsaved draft.</Notice>
      )}
      <FormError message={createError} />
      {CHANNELS.map((c) => {
        const d = deployments.find((x) => x.channel === c.channel);
        return (
          <Card key={c.channel}>
            <div className="flex items-start gap-3">
              <c.icon className="mt-0.5 size-5 text-brand-600" aria-hidden />
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium">{c.title}</h2>
                  {d && <Badge tone={d.status === "active" ? "green" : d.status === "paused" ? "amber" : "red"}>{d.status === "disabled_by_admin" ? "disabled by support" : d.status}</Badge>}
                </div>
                <p className="text-sm text-[var(--muted)]">{c.description}</p>
              </div>
              {!d && (
                <Button variant="secondary" onClick={() => create.mutate(c.channel)} disabled={create.isPending}>
                  Turn on
                </Button>
              )}
            </div>
            {d && <DeploymentDetails agentId={id} deployment={d} />}
          </Card>
        );
      })}
    </div>
  );
}

function DeploymentDetails({ agentId, deployment: d }: { agentId: string; deployment: Deployment }) {
  const queryClient = useQueryClient();
  const { data: versions } = useVersions(agentId);
  const [title, setTitle] = useState(d.config.title ?? "");
  const [origins, setOrigins] = useState((d.config.allowedOrigins ?? []).join("\n"));
  const [color, setColor] = useState(d.config.theme?.primaryColor ?? "#2a56e0");
  const [position, setPosition] = useState(d.config.theme?.position ?? "right");
  const [privacyUrl, setPrivacyUrl] = useState(d.config.privacyPolicyUrl ?? "");

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/api/v1/agents/${agentId}/deployments/${d.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["deployments", agentId] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/v1/agents/${agentId}/deployments/${d.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["deployments", agentId] }),
  });

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const pageUrl = `${origin}/c/${d.publicKey}`;
  const snippet = `<script src="${origin}/widget.js" data-agent="${d.publicKey}" async></script>`;
  const curl = `curl -X POST ${origin}/api/v1/runs/agents/${agentId} \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello!", "userId": "customer-123"}'`;

  const saveConfig = () =>
    patch.mutate({
      config: {
        title: title || undefined,
        allowedOrigins: origins
          .split(/[\n,]/)
          .map((s) => s.trim().replace(/\/$/, ""))
          .filter(Boolean),
        theme: { primaryColor: color, position },
        privacyPolicyUrl: privacyUrl.trim() || undefined,
      },
    });

  const disabled = d.status === "disabled_by_admin";

  return (
    <div className="mt-5 space-y-5 border-t border-[var(--border)] pt-5">
      {d.channel === "hosted_page" && (
        <>
          <Field label="Link to share">
            <div className="flex gap-2">
              <Input readOnly value={pageUrl} onFocus={(e) => e.target.select()} />
              <CopyButton text={pageUrl} />
              <a href={pageUrl} target="_blank" rel="noreferrer">
                <Button variant="secondary" aria-label="Open chat page">
                  <ExternalLink className="size-4" />
                </Button>
              </a>
            </div>
          </Field>
          <Field label="Page title" htmlFor={`title-${d.id}`}>
            <Input id={`title-${d.id}`} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the agent name" />
          </Field>
          <Field
            label="Your privacy policy (optional)"
            htmlFor={`privacy-${d.id}`}
            hint="Linked under the chat box, next to a note that messages are handled by AI and stored."
          >
            <Input id={`privacy-${d.id}`} type="url" value={privacyUrl} maxLength={500} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://www.example.com/privacy" />
          </Field>
          <Button variant="secondary" onClick={saveConfig} disabled={patch.isPending}>
            Save page settings
          </Button>
        </>
      )}

      {d.channel === "web_widget" && (
        <>
          <Field label="Add this to your website, before </body>">
            <div className="flex gap-2">
              <Textarea readOnly value={snippet} className="min-h-14 font-mono text-xs" onFocus={(e) => e.target.select()} />
              <CopyButton text={snippet} />
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Allowed websites" htmlFor={`origins-${d.id}`} hint="One per line, e.g. https://www.example.com. The widget only loads on these sites.">
              <Textarea id={`origins-${d.id}`} value={origins} onChange={(e) => setOrigins(e.target.value)} className="min-h-20 font-mono text-xs" placeholder="https://www.example.com" />
            </Field>
            <div className="space-y-4">
              <Field label="Color" htmlFor={`color-${d.id}`}>
                <div className="flex items-center gap-2">
                  <input id={`color-${d.id}`} type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 rounded border border-[var(--border)]" />
                  <Input value={color} onChange={(e) => setColor(e.target.value)} maxLength={7} className="w-28 font-mono" />
                </div>
              </Field>
              <Field label="Position" htmlFor={`pos-${d.id}`}>
                <Select id={`pos-${d.id}`} value={position} onChange={(e) => setPosition(e.target.value as "left" | "right")}>
                  <option value="right">Bottom right</option>
                  <option value="left">Bottom left</option>
                </Select>
              </Field>
            </div>
          </div>
          <Field
            label="Your privacy policy (optional)"
            htmlFor={`privacy-${d.id}`}
            hint="Linked under the chat box, next to a note that messages are handled by AI and stored."
          >
            <Input id={`privacy-${d.id}`} type="url" value={privacyUrl} maxLength={500} onChange={(e) => setPrivacyUrl(e.target.value)} placeholder="https://www.example.com/privacy" />
          </Field>
          {(d.config.allowedOrigins ?? []).length === 0 && <Notice tone="warning">Add at least one website, or the widget won&apos;t load anywhere.</Notice>}
          <Button variant="secondary" onClick={saveConfig} disabled={patch.isPending}>
            Save widget settings
          </Button>
        </>
      )}

      {d.channel === "api" && (
        <>
          <p className="text-sm">
            Create a key in <Link href="/settings/api-keys" className="font-medium underline">Settings → API keys</Link>, then call:
          </p>
          <div className="flex gap-2">
            <pre className="flex-1 overflow-x-auto rounded-md bg-slate-900 p-3 text-xs text-slate-100">{curl}</pre>
            <CopyButton text={curl} />
          </div>
          <Hint>
            Pass the returned <code>conversationId</code> to continue a conversation. Add <code>&quot;stream&quot;: true</code> to receive the answer as Server-Sent Events, or{" "}
            <code>&quot;async&quot;: true</code> (optionally with a <code>callbackUrl</code>) to get a run id right away and the result later at <code>GET /api/v1/runs/&lt;id&gt;</code>. Callbacks are signed; see Settings → API keys. For <code>userId</code>, use your own customer id rather than an email address; it&apos;s what you&apos;ll use to find or delete that person&apos;s chats in Settings → Privacy.
          </Hint>
        </>
      )}

      <div className="flex flex-wrap items-end gap-4 border-t border-[var(--border)] pt-4">
        <Field label="Version" htmlFor={`version-${d.id}`}>
          <Select
            id={`version-${d.id}`}
            value={d.versionPolicy === "pinned" ? (d.pinnedVersionId ?? "") : "latest"}
            disabled={disabled}
            onChange={(e) =>
              patch.mutate(e.target.value === "latest" ? { versionPolicy: "latest" } : { versionPolicy: "pinned", pinnedVersionId: e.target.value })
            }
            className="w-64"
          >
            <option value="latest">Always the latest published version</option>
            {(versions?.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                Stay on v{v.versionNo}
                {v.changeNote ? ` — ${v.changeNote.slice(0, 30)}` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Toggle label={d.status === "active" ? "Live" : "Paused"} checked={d.status === "active"} disabled={disabled || patch.isPending} onChange={(v) => patch.mutate({ status: v ? "active" : "paused" })} />
        <Button
          variant="ghost"
          className="ml-auto text-red-600"
          onClick={() => confirm("Turn off this channel? Its link or snippet will stop working.") && remove.mutate()}
          disabled={remove.isPending}
        >
          Remove channel
        </Button>
      </div>
      <FormError message={(patch.error ?? remove.error) ? ((patch.error ?? remove.error) as Error).message : null} />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="secondary"
      aria-label="Copy"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </Button>
  );
}
