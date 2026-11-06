"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";

/**
 * True when the signed-in user owns the platform account (the one flagged
 * accounts.can_create_workspaces). Only used to show or hide the "Accounts"
 * settings section; the API re-checks on the server. False while loading
 * and when the column is missing.
 */
export function usePlatformAdmin(): boolean {
  const { accountId, isOwner } = useAuth();
  const supabase = useMemo(() => createClient(), []);
  const [flag, setFlag] = useState(false);

  useEffect(() => {
    if (!accountId || !isOwner) return;
    let alive = true;
    supabase
      .from("accounts")
      .select("can_create_workspaces")
      .eq("id", accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (alive) setFlag(!error && data?.can_create_workspaces === true);
      });
    return () => {
      alive = false;
    };
  }, [accountId, isOwner, supabase]);

  return Boolean(accountId && isOwner && flag);
}
