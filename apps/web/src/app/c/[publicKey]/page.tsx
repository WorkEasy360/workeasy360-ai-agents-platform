"use client";

import { useParams } from "next/navigation";
import { PublicChat } from "@/components/chat/public-chat";

/** Hosted chat page: a shareable link per agent (no website needed). */
export default function HostedChatPage() {
  const { publicKey } = useParams<{ publicKey: string }>();
  return (
    <main className="flex h-dvh justify-center bg-[var(--background)] sm:py-8">
      <div className="flex w-full max-w-2xl flex-col overflow-hidden border-[var(--border)] shadow-sm sm:rounded-xl sm:border">
        <PublicChat publicKey={publicKey} />
      </div>
    </main>
  );
}
