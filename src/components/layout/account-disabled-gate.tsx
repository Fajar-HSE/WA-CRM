"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Ban } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";

/**
 * Replaces the whole dashboard with a notice when the platform administrator
 * has disabled this account (accounts.disabled_at). Fails open: if the column
 * is unreadable (migration 064 not applied) the app renders as usual. The
 * server refuses the account's requests either way.
 */
export function AccountDisabledGate({ children }: { children: ReactNode }) {
  const { accountId, signOut } = useAuth();
  const t = useTranslations("AccountDisabled");
  const supabase = useMemo(() => createClient(), []);
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    supabase
      .from("accounts")
      .select("disabled_at")
      .eq("id", accountId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (alive) setDisabled(!error && !!data?.disabled_at);
      });
    return () => {
      alive = false;
    };
  }, [accountId, supabase]);

  if (!disabled) return <>{children}</>;

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6">
      <div className="max-w-md text-center">
        <Ban className="mx-auto size-10 text-destructive" />
        <h1 className="mt-4 text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("body")}</p>
        <Button className="mt-6" variant="outline" onClick={() => void signOut()}>
          {t("signOut")}
        </Button>
      </div>
    </div>
  );
}
