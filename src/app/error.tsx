'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { reportClientError } from '@/lib/logging/report-client-error';

// Shown when a page crashes while rendering. Without this file the user
// saw a blank screen and nothing was recorded.
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations('ErrorLogs.boundary');

  useEffect(() => {
    reportClientError(error, { kind: 'render', digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-3 px-4 text-center">
      <h2 className="text-xl font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('body')}</p>
      {error.digest ? (
        <p className="text-xs text-muted-foreground">
          {t('code')}: <code>{error.digest}</code>
        </p>
      ) : null}
      <Button onClick={() => retry()}>{t('retry')}</Button>
    </div>
  );
}
