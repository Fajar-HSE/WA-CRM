"use client";

import { useCallback, useState } from "react";
import { History } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

interface HistoryResponse {
  imported?: number;
  fetched?: number;
  next_offset?: number;
  error?: string;
}

/**
 * Pulls older messages of this chat from WAHA into the conversation, one
 * page per click. The CRM only saves what arrives while it is connected, so
 * anything said before that is only reachable this way.
 */
export function LoadHistoryButton({
  conversationId,
  onLoaded,
}: {
  conversationId: string;
  onLoaded?: () => void;
}) {
  const t = useTranslations("Inbox.messageThread");
  const [loading, setLoading] = useState(false);
  // Next page to ask for. Lives in the component, which the parent keys by
  // conversation, so it restarts at 0 for each chat.
  const [offset, setOffset] = useState(0);

  const load = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const res = await fetch("/api/whatsapp/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversation_id: conversationId, offset }),
      });
      const body = (await res.json().catch(() => ({}))) as HistoryResponse;
      if (!res.ok) {
        toast.error(body.error || t("historyFailed"));
        return;
      }
      setOffset(body.next_offset ?? offset);
      if (!body.fetched) {
        toast.info(t("historyNone"));
        return;
      }
      toast.success(t("historyImported", { count: body.imported ?? 0 }));
      if (body.imported) onLoaded?.();
    } catch {
      toast.error(t("historyFailed"));
    } finally {
      setLoading(false);
    }
  }, [conversationId, loading, offset, onLoaded, t]);

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void load()}
      disabled={loading}
    >
      <History className="size-3.5" aria-hidden />
      {loading ? t("loadingHistory") : t("loadHistory")}
    </Button>
  );
}
