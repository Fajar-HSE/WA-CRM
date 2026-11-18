"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { loadSeen, saveSeen, subscribeSeen } from "@/lib/groups/seen-store";
import {
  initSeen,
  markSeen,
  unreadGroupIds,
  type GroupStamp,
  type SeenMap,
} from "@/lib/groups/unread";

/**
 * Which monitored groups have messages this browser has not shown yet.
 *
 * Takes the group list from the caller (the Groups page already loads it;
 * the sidebar uses `useGroupStamps`). Read state lives in this browser only,
 * see `lib/groups/unread.ts`.
 */
export function useGroupsUnread(groups: GroupStamp[] | null) {
  const { accountId } = useAuth();
  const [seen, setSeen] = useState<SeenMap>({});

  // Follow the stored map, including changes from other hook instances
  // (sidebar <-> page) and other tabs.
  useEffect(() => {
    if (!accountId) return;
    const sync = () => setSeen(loadSeen(accountId));
    sync();
    return subscribeSeen(sync);
  }, [accountId]);

  // First sight of a group: treat what is there now as read.
  useEffect(() => {
    if (!accountId || !groups) return;
    const stored = loadSeen(accountId);
    const next = initSeen(groups, stored);
    if (next !== stored) saveSeen(accountId, next);
  }, [accountId, groups]);

  const unreadIds = useMemo(
    () => (groups ? unreadGroupIds(groups, seen) : new Set<string>()),
    [groups, seen],
  );

  const markGroupSeen = useCallback(
    (groupId: string, lastMessageAt: string | null) => {
      if (!accountId) return;
      const stored = loadSeen(accountId);
      const next = markSeen(stored, groupId, lastMessageAt);
      if (next !== stored) saveSeen(accountId, next);
    },
    [accountId],
  );

  return { unreadIds, count: unreadIds.size, markGroupSeen };
}

/**
 * Light poll of the monitored groups' latest-message times, for the sidebar
 * dot. Row-level security limits it to the signed-in user's account. Only
 * polls while the tab is visible and catches up when it becomes visible.
 */
export function useGroupStamps(pollMs = 15_000): GroupStamp[] | null {
  const [stamps, setStamps] = useState<GroupStamp[] | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    const load = () => {
      supabase
        .from("whatsapp_groups")
        .select("id, last_message_at")
        .eq("monitored", true)
        .then(({ data, error }) => {
          if (cancelled || error) return;
          setStamps((data ?? []) as GroupStamp[]);
        });
    };

    load();
    const tick = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, pollMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pollMs]);

  return stamps;
}
