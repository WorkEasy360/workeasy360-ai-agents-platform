"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { Badge, Button, Dialog, Field, FormError, Input, Select } from "@/components/ui";
import { errorMessage, JsonBlock } from "@/components/app/misc";
import type { Tool, ToolParam } from "@/components/app/types";
import { api } from "@/lib/api";
import { EmailToolTest } from "./email-tool";

interface TestResult {
  output: { status?: number; ok: boolean; body?: string; error?: string };
  trace: { request?: { method: string; url: string }; status?: number; truncated?: boolean; error?: string };
}

export function ToolTestDialog({ tool, onClose }: { tool: Tool | null; onClose: () => void }) {
  return (
    <Dialog open={tool !== null} onClose={onClose} title={tool ? `Test ${tool.name}` : "Test tool"} wide>
      {tool && (tool.providerKey === "send_email" ? <EmailToolTest tool={tool} /> : <ToolTest key={tool.id} tool={tool} />)}
    </Dialog>
  );
}

function convert(p: ToolParam, raw: string): unknown {
  if (p.type === "number") return Number(raw);
  if (p.type === "boolean") return raw === "true";
  return raw;
}

function prettyBody(body: string | undefined) {
  if (!body) return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function ToolTest({ tool }: { tool: Tool }) {
  const params = tool.config.params;
  const [values, setValues] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: (input: Record<string, unknown>) => api<TestResult>(`/api/v1/tools/${tool.id}/test`, { method: "POST", body: JSON.stringify({ input }) }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const input: Record<string, unknown> = {};
    for (const p of params) {
      const raw = values[p.name] ?? "";
      if (raw !== "") input[p.name] = convert(p, raw);
    }
    run.mutate(input);
  }

  const result = run.data;
  return (
    <div className="space-y-5">
      <p className="text-sm text-[var(--muted)]">
        This calls <code className="break-all">{tool.config.method} {tool.config.url}</code> for real, with the sample values below.
        {tool.config.method !== "GET" && " Because it isn't a GET request, it may change data in your system."}
      </p>
      <form onSubmit={submit} className="space-y-3">
        {params.length === 0 && <p className="text-sm text-[var(--muted)]">This tool has no parameters.</p>}
        {params.map((p) => (
          <Field key={p.name} label={`${p.name}${p.required ? " *" : ""}`} htmlFor={`tp-${p.name}`} hint={p.description || undefined}>
            {p.type === "boolean" ? (
              <Select id={`tp-${p.name}`} value={values[p.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}>
                <option value="">(not set)</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </Select>
            ) : (
              <Input
                id={`tp-${p.name}`}
                type={p.type === "number" ? "number" : "text"}
                step="any"
                required={p.required}
                value={values[p.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
              />
            )}
          </Field>
        ))}
        <Button type="submit" disabled={run.isPending}>
          <Play className="size-4" /> {run.isPending ? "Running…" : "Run test"}
        </Button>
      </form>

      <FormError message={errorMessage(run.error)} />
      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium">Result</span>
            {result.output.ok ? <Badge tone="green">Success</Badge> : <Badge tone="red">Failed</Badge>}
            {result.output.status !== undefined && <Badge>HTTP {result.output.status}</Badge>}
            {result.trace.truncated && <Badge tone="amber">Response shortened</Badge>}
          </div>
          {result.trace.request && <p className="text-xs break-all text-[var(--muted)]">{result.trace.request.method} {result.trace.request.url}</p>}
          {result.output.error ? <FormError message={result.output.error} /> : <JsonBlock value={prettyBody(result.output.body)} />}
          <p className="text-xs text-[var(--muted)]">This is what the agent will see when it uses the tool.</p>
        </div>
      )}
    </div>
  );
}
