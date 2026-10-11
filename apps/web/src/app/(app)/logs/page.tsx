"use client";

import { PageHeader, Tabs } from "@/components/ui";
import { ConversationsTab } from "@/components/app/logs/conversations-tab";
import { RunsTab } from "@/components/app/logs/runs-tab";
import { useUrlTab } from "@/components/app/url-tab";

const TABS = ["runs", "conversations"] as const;

export default function LogsPage() {
  const [tab, setTab] = useUrlTab(TABS, "runs");
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Logs" description="See every time your agents answered, what they did along the way, and how much it cost." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "runs", label: "Runs" },
          { value: "conversations", label: "Conversations" },
        ]}
      />
      <div className="mt-6">{tab === "runs" ? <RunsTab /> : <ConversationsTab />}</div>
    </div>
  );
}
