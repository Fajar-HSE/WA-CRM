import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { LOCALE_COOKIE, resolveLocale, type AppLocale } from './locales';

type Catalogue = Record<string, unknown>;

/** Recursively overlay `over` on `base`; keys missing in `over` keep the base value. */
function overlay(base: Catalogue, over: Catalogue): Catalogue {
  const out: Catalogue = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      current &&
      typeof current === 'object' &&
      !Array.isArray(current)
        ? overlay(current as Catalogue, value as Catalogue)
        : value;
  }
  return out;
}

async function loadMessages(locale: AppLocale): Promise<Catalogue> {
  const en = (await import('../../messages/en.json')).default as Catalogue;
  if (locale === 'en') return en;
  // English underneath: a key that exists only in en.json renders in
  // English instead of as a raw key path.
  const local = (await import(`../../messages/${locale}.json`)).default as Catalogue;
  return overlay(en, local);
}

export default getRequestConfig(async () => {
  const store = await cookies();
  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);
  return { locale, messages: await loadMessages(locale) };
});
