"use client";

import { Check, Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import {
  LOCALES,
  LOCALE_LABELS,
  isAppLocale,
  type AppLocale,
} from "@/i18n/locales";
import { storeLocale } from "@/i18n/locale-client";
import { cn } from "@/lib/utils";

/**
 * Interface language picker (Bahasa Indonesia / English).
 *
 * The choice lives in a cookie so the server can render the right
 * catalogue on the very first byte; router.refresh() re-renders the
 * current route with the new locale without a full page reload.
 */
export function LanguageCard() {
  const t = useTranslations("Settings.appearance");
  const active = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function pick(locale: AppLocale) {
    if (locale === active) return;
    storeLocale(locale);
    startTransition(() => router.refresh());
  }

  return (
    <div className="mt-8 space-y-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Languages className="size-4 text-muted-foreground" />
        {t("language")}
      </h3>
      <p className="max-w-md text-sm text-muted-foreground">
        {t("languageDesc")}
      </p>

      <div
        role="radiogroup"
        aria-label={t("language")}
        aria-busy={pending}
        className="grid max-w-md grid-cols-2 gap-3"
      >
        {LOCALES.map((locale) => {
          const isActive = isAppLocale(active) && locale === active;
          return (
            <button
              key={locale}
              type="button"
              role="radio"
              aria-checked={isActive}
              disabled={pending}
              onClick={() => pick(locale)}
              className={cn(
                "flex items-center justify-between rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                isActive
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border bg-muted text-foreground hover:border-primary/50",
              )}
            >
              <span lang={locale}>{LOCALE_LABELS[locale]}</span>
              {isActive && <Check className="size-4 text-primary" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
