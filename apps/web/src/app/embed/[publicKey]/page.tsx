"use client";

import { useParams } from "next/navigation";
import { PublicChat } from "@/components/chat/public-chat";

/** Rendered inside the widget's iframe. Which sites may frame it is set by src/proxy.ts. */
export default function EmbedPage() {
  const { publicKey } = useParams<{ publicKey: string }>();
  return (
    <main className="h-dvh">
      <PublicChat publicKey={publicKey} embedded />
    </main>
  );
}
