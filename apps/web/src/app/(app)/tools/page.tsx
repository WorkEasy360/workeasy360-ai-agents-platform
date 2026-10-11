"use client";

import { PageHeader, Tabs } from "@/components/ui";
import { CredentialsTab } from "@/components/app/tools/credentials-tab";
import { ToolsTab } from "@/components/app/tools/tools-tab";
import { useUrlTab } from "@/components/app/url-tab";

const TABS = ["tools", "credentials"] as const;

export default function ToolsPage() {
  const [tab, setTab] = useUrlTab(TABS, "tools");
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Tools" description="Let your agents take actions or look things up in your other systems, like checking an order or creating a lead." />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: "tools", label: "API tools" },
          { value: "credentials", label: "Credentials" },
        ]}
      />
      <div className="mt-6">{tab === "tools" ? <ToolsTab /> : <CredentialsTab />}</div>
    </div>
  );
}
