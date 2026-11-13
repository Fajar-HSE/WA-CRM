'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { SettingsPanelHead } from './settings-panel-head';

interface ErrorLogRow {
  id: string;
  account_id: string | null;
  source: string;
  level: 'error' | 'warning';
  message: string;
  stack: string | null;
  context: Record<string, unknown>;
  occurrences: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

type Filter = 'open' | 'resolved' | 'all';

/** Settings → Error log (admin and above). */
export function ErrorLogsPanel() {
  const t = useTranslations('ErrorLogs');
  const locale = useLocale();
  const [filter, setFilter] = useState<Filter>('open');
  const [rows, setRows] = useState<ErrorLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch(`/api/error-logs?status=${filter}`, { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || t('loadFailed'));
        if (!alive) return;
        setRows(json.logs as ErrorLogRow[]);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : t('loadFailed'));
      });
    return () => {
      alive = false;
    };
  }, [filter, tick, t]);

  const reload = useCallback(() => setTick((n) => n + 1), []);

  async function call(id: string, init: RequestInit) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/error-logs/${id}`, {
        ...init,
        headers: { 'Content-Type': 'application/json' },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || t('actionFailed'));
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('actionFailed'));
    } finally {
      setBusyId(null);
    }
  }

  async function clearResolved() {
    try {
      const res = await fetch('/api/error-logs?resolved=1', { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || t('actionFailed'));
      toast.success(t('clearedToast'));
      reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('actionFailed'));
    }
  }

  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="animate-in fade-in-50 space-y-5 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          filter !== 'open' ? (
            <Button variant="outline" size="sm" onClick={clearResolved}>
              <Trash2 className="mr-1.5 size-4" />
              {t('clearResolved')}
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap gap-2" role="tablist" aria-label={t('title')}>
        {(['open', 'resolved', 'all'] as const).map((f) => (
          <Button
            key={f}
            type="button"
            size="sm"
            role="tab"
            aria-selected={filter === f}
            variant={filter === f ? 'default' : 'outline'}
            onClick={() => {
              setRows(null);
              setFilter(f);
            }}
          >
            {t(`filter.${f}`)}
          </Button>
        ))}
      </div>

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : rows === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t('loading')}
        </div>
      ) : rows.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
            <CheckCircle2 className="size-5 text-primary" />
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => {
            const isOpen = openId === row.id;
            const resolved = !!row.resolved_at;
            return (
              <li key={row.id} className="rounded-lg border border-border bg-card">
                <button
                  type="button"
                  className="flex w-full items-start gap-3 p-3 text-left"
                  onClick={() => setOpenId(isOpen ? null : row.id)}
                  aria-expanded={isOpen}
                >
                  {isOpen ? (
                    <ChevronDown className="mt-0.5 size-4 shrink-0" />
                  ) : (
                    <ChevronRight className="mt-0.5 size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant={row.level === 'error' ? 'destructive' : 'secondary'}>
                        {t(`level.${row.level}`)}
                      </Badge>
                      <code className="text-xs text-muted-foreground">{row.source}</code>
                      {row.occurrences > 1 ? (
                        <span className="text-xs text-muted-foreground">
                          {t('times', { count: row.occurrences })}
                        </span>
                      ) : null}
                      {resolved ? <Badge variant="outline">{t('resolved')}</Badge> : null}
                    </span>
                    <span
                      className={cn(
                        'mt-1 block text-sm break-words text-foreground',
                        !isOpen && 'line-clamp-2',
                      )}
                    >
                      {row.message}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {t('lastSeen', { when: fmt(row.last_seen_at) })}
                    </span>
                  </span>
                </button>

                {isOpen ? (
                  <div className="space-y-3 border-t border-border p-3 text-xs">
                    <p className="text-muted-foreground">
                      {t('firstSeen', { when: fmt(row.first_seen_at) })}
                    </p>
                    {Object.keys(row.context ?? {}).length > 0 ? (
                      <div>
                        <p className="mb-1 font-medium text-foreground">{t('details')}</p>
                        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
                          {JSON.stringify(row.context, null, 2)}
                        </pre>
                      </div>
                    ) : null}
                    {row.stack ? (
                      <div>
                        <p className="mb-1 font-medium text-foreground">{t('stack')}</p>
                        <pre className="max-h-60 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">
                          {row.stack}
                        </pre>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={resolved ? 'outline' : 'default'}
                        disabled={busyId === row.id}
                        onClick={() =>
                          call(row.id, {
                            method: 'PATCH',
                            body: JSON.stringify({ resolved: !resolved }),
                          })
                        }
                      >
                        {resolved ? (
                          <RotateCcw className="mr-1.5 size-4" />
                        ) : (
                          <CheckCircle2 className="mr-1.5 size-4" />
                        )}
                        {resolved ? t('reopen') : t('markResolved')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => call(row.id, { method: 'DELETE' })}
                      >
                        <Trash2 className="mr-1.5 size-4" />
                        {t('delete')}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
