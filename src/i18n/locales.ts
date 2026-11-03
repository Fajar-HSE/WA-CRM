/**
 * The two UI languages this fork ships, and how the active one is picked.
 *
 * Order of precedence on every request:
 *   1. the `wacrm_locale` cookie, set from Settings → Appearance
 *   2. NEXT_PUBLIC_APP_LOCALE (build-time default for new visitors)
 *   3. Indonesian
 */
export const LOCALES = ['id', 'en'] as const;
export type AppLocale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'id';
export const LOCALE_COOKIE = 'wacrm_locale';
/** One year, in seconds. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Shown in the language picker, always in the language's own name. */
export const LOCALE_LABELS: Record<AppLocale, string> = {
  id: 'Bahasa Indonesia',
  en: 'English',
};

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Locale to use when the visitor has not chosen one. */
export function resolveDefaultLocale(
  env: string | undefined = process.env.NEXT_PUBLIC_APP_LOCALE,
): AppLocale {
  return isAppLocale(env) ? env : DEFAULT_LOCALE;
}

export function resolveLocale(
  cookieValue: string | undefined,
  env?: string,
): AppLocale {
  return isAppLocale(cookieValue) ? cookieValue : resolveDefaultLocale(env);
}
