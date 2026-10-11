"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PageHeader } from "@/components/ui";
import { useRole } from "@/components/app/use-role";
import { cn } from "@/lib/cn";

const tabs = [
  { href: "/settings/members", label: "Members" },
  { href: "/settings/ai", label: "AI models" },
  { href: "/settings/api-keys", label: "API keys", adminOnly: true },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/organization", label: "Organization" },
  { href: "/settings/privacy", label: "Privacy" },
  { href: "/settings/audit", label: "Audit log", adminOnly: true },
];

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isAdmin } = useRole();
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Settings" description="Manage your team, AI providers and API access." />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--border)]" aria-label="Settings sections">
        {tabs
          .filter((t) => isAdmin || !t.adminOnly)
          .map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                  active ? "border-brand-600 font-medium text-brand-700 dark:text-white" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]",
                )}
              >
                {t.label}
              </Link>
            );
          })}
      </nav>
      {children}
    </div>
  );
}
