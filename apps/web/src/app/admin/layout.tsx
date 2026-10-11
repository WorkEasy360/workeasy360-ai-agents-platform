"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  Building2,
  Cpu,
  Flag,
  LayoutDashboard,
  Layers,
  ScrollText,
  Users,
  Workflow,
} from "lucide-react";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/use-me";

const nav: Array<{ href: string; label: string; icon: typeof Bot }> = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard },
  { href: "/admin/organizations", label: "Organizations", icon: Building2 },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/agents", label: "Agents", icon: Bot },
  { href: "/admin/executions", label: "Executions", icon: Workflow },
  { href: "/admin/usage", label: "Usage & cost", icon: BarChart3 },
  { href: "/admin/plans", label: "Plans", icon: Layers },
  { href: "/admin/models", label: "Models", icon: Cpu },
  { href: "/admin/feature-flags", label: "Feature flags", icon: Flag },
  { href: "/admin/health", label: "System health", icon: Activity },
  { href: "/admin/audit-log", label: "Audit log", icon: ScrollText },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { data: me, error, isLoading } = useMe();

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/login");
    // Non-staff are sent home; the API also hides admin routes from them.
    else if (me && !me.user.platformRole) router.replace("/");
  }, [me, error, router]);

  if (isLoading || !me?.user.platformRole) return <div className="p-8 text-sm text-[var(--muted)]">Loading…</div>;

  const isActive = (href: string) => (href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-[var(--border)] bg-slate-900 px-4 py-3 text-white md:px-6">
        <p className="text-sm font-semibold">
          Super admin <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 text-xs font-normal">{me.user.platformRole}</span>
        </p>
        <Link href="/" className="text-sm text-white/80 hover:text-white">
          Back to app
        </Link>
      </header>

      <div className="md:flex">
        {/* Desktop sidebar; on phones the same links render as a scrollable strip. */}
        <nav aria-label="Admin" className="border-b border-[var(--border)] bg-[var(--surface)] md:sticky md:top-0 md:h-[calc(100vh-49px)] md:w-56 md:shrink-0 md:border-r md:border-b-0">
          <ul className="flex gap-1 overflow-x-auto px-2 py-2 md:flex-col md:overflow-visible">
            {nav.map(({ href, label, icon: Icon }) => (
              <li key={href} className="shrink-0">
                <Link
                  href={href}
                  aria-current={isActive(href) ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm whitespace-nowrap",
                    isActive(href)
                      ? "bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-white"
                      : "hover:bg-slate-100 dark:hover:bg-slate-800",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto max-w-6xl">{children}</div>
        </main>
      </div>
    </div>
  );
}
