"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { BookOpen, Bot, Gauge, Home, LifeBuoy, ScrollText, Settings, Shield, Wrench } from "lucide-react";
import { ApiError, getActiveOrgId, setActiveOrgId } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/use-me";

const nav: Array<{ href: string; label: string; icon: typeof Home }> = [
  { href: "/", label: "Home", icon: Home },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/knowledge", label: "Knowledge", icon: BookOpen },
  { href: "/tools", label: "Tools", icon: Wrench },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/usage", label: "Usage", icon: Gauge },
  { href: "/settings/members", label: "Settings", icon: Settings },
  { href: "/guide", label: "Guide", icon: LifeBuoy },
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { data: me, error, isLoading } = useMe();

  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) router.replace("/login");
    else if (me && me.organizations.length === 0) router.replace("/onboarding");
    else if (me) {
      const stored = getActiveOrgId();
      if (!stored || !me.organizations.some((o) => o.id === stored)) {
        const orgId = me.activeOrganizationId ?? me.organizations[0]?.id;
        if (orgId) setActiveOrgId(orgId);
      }
    }
  }, [me, error, router]);

  if (isLoading || !me || me.organizations.length === 0) {
    return <div className="p-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  const activeOrg = me.organizations.find((o) => o.id === getActiveOrgId()) ?? me.organizations[0]!;
  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href.split("/").slice(0, 2).join("/")));

  const switchOrg = (orgId: string) => {
    setActiveOrgId(orgId);
    // Everything cached belongs to the previous org.
    queryClient.clear();
    router.push("/");
  };

  const signOut = async () => {
    await authClient.signOut();
    queryClient.clear();
    router.replace("/login");
  };

  const navLinks = (mobile: boolean) =>
    nav.map(({ href, label, icon: Icon }) => (
      <Link
        key={href}
        href={href}
        aria-current={isActive(href) ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm",
          isActive(href) ? "bg-brand-50 font-medium text-brand-700 dark:bg-slate-800 dark:text-white" : "hover:bg-slate-100 dark:hover:bg-slate-800",
          mobile && "py-1.5",
        )}
      >
        <Icon className="size-4" aria-hidden />
        {label}
      </Link>
    ));

  const orgSwitcher =
    me.organizations.length > 1 ? (
      <select
        aria-label="Organization"
        value={activeOrg.id}
        onChange={(e) => switchOrg(e.target.value)}
        className="mt-1 w-full truncate rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-1 text-xs"
      >
        {me.organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    ) : (
      <p className="mt-1 truncate text-xs text-[var(--muted)]">
        {activeOrg.name} · <span className="capitalize">{activeOrg.planKey}</span>
      </p>
    );

  return (
    <div className="min-h-screen md:flex">
      {/* Phones: compact header with a scrollable nav strip. */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)] md:hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold">
              WorkEasy360 <span className="text-brand-600">Agents</span>
            </p>
            {orgSwitcher}
          </div>
          <button onClick={signOut} className="text-xs text-[var(--muted)]">
            Sign out
          </button>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2">{navLinks(true)}</nav>
      </header>

      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--surface)] md:flex">
        <div className="border-b border-[var(--border)] px-4 py-4">
          <p className="text-sm font-semibold">
            WorkEasy360 <span className="text-brand-600">Agents</span>
          </p>
          {orgSwitcher}
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
          {navLinks(false)}
          {me.user.platformRole && (
            <Link href="/admin" className="mt-4 flex items-center gap-2.5 rounded-md px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800">
              <Shield className="size-4" aria-hidden />
              Super admin
            </Link>
          )}
        </nav>
        <div className="border-t border-[var(--border)] p-3 text-sm">
          <p className="truncate font-medium">{me.user.name}</p>
          <p className="truncate text-xs text-[var(--muted)]">{me.user.email}</p>
          <button className="mt-2 text-xs text-[var(--muted)] hover:underline" onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 md:px-10 md:py-8">{children}</main>
    </div>
  );
}
