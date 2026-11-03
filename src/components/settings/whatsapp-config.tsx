'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
  Power,
  QrCode,
  RefreshCw,
  Unplug,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

/** What /api/whatsapp/waha/session returns. */
interface SessionState {
  configured: boolean;
  sessionName: string;
  status: string;
  qr: string | null;
  webhookUrl: string;
}

const KNOWN_STATUSES = [
  'WORKING',
  'SCAN_QR_CODE',
  'STARTING',
  'STOPPED',
  'FAILED',
  'NOT_FOUND',
] as const;
type KnownStatus = (typeof KNOWN_STATUSES)[number];

// While the session is mid-handshake the status changes on its own
// (QR appears, phone scans, session goes WORKING), so poll.
const POLL_STATUSES = new Set(['STARTING', 'SCAN_QR_CODE']);
const POLL_MS = 3000;

function knownStatus(status: string): KnownStatus | 'UNKNOWN' {
  return (KNOWN_STATUSES as readonly string[]).includes(status)
    ? (status as KnownStatus)
    : 'UNKNOWN';
}

function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);
}

/**
 * WhatsApp settings — WAHA only.
 *
 * The session name is generated and owned by the server (it is derived
 * from the account), so there is nothing to type here: connect, scan
 * the QR code with the phone, done. The browser never sends a session
 * name, which is also what stops one account touching another's session.
 */
export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const { accountId, loading: authLoading, profileLoading, canEditSettings } =
    useAuth();

  const [state, setState] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const call = useCallback(
    async (method: 'GET' | 'POST' | 'DELETE'): Promise<SessionState> => {
      const res = await fetch('/api/whatsapp/waha/session', { method });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data as SessionState;
    },
    [],
  );

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const next = await call('GET');
        if (!mounted.current) return;
        setState(next);
        setError(null);
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : t('loadFailed'));
      } finally {
        if (mounted.current && !silent) setLoading(false);
      }
    },
    [call, t],
  );

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountId || !canEditSettings) return;
    // First load. `loading` already starts true, so only the async result
    // touches state here.
    (async () => {
      try {
        const next = await call('GET');
        if (!mounted.current) return;
        setState(next);
        setError(null);
      } catch (err) {
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : t('loadFailed'));
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
  }, [authLoading, profileLoading, accountId, canEditSettings, call, t]);

  const status = state?.status ?? 'NOT_FOUND';
  const polling = !!state?.configured && POLL_STATUSES.has(status);
  useEffect(() => {
    if (!polling) return;
    const id = setInterval(() => refresh(true), POLL_MS);
    return () => clearInterval(id);
  }, [polling, refresh]);

  async function run(
    method: 'POST' | 'DELETE',
    successKey: string,
    failKey: string,
  ) {
    setBusy(true);
    try {
      const next = await call(method);
      setState(next);
      setError(null);
      toast.success(t(successKey));
    } catch (err) {
      const message = err instanceof Error ? err.message : t(failKey);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  function handleDisconnect() {
    if (!window.confirm(t('disconnectConfirm'))) return;
    run('DELETE', 'disconnectSuccess', 'disconnectFailed');
  }

  async function copyWebhook() {
    if (!state?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(state.webhookUrl);
      toast.success(t('copied'));
    } catch {
      /* clipboard can be blocked; the URL is selectable anyway */
    }
  }

  if (!canEditSettings && !authLoading && !profileLoading) {
    return (
      <section className="max-w-2xl animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Alert>
          <AlertDescription>{t('adminOnly')}</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (loading && canEditSettings && accountId) {
    return (
      <section className="max-w-2xl">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      </section>
    );
  }

  const label = knownStatus(status);
  const isConnected = status === 'WORKING';
  const isStopped = status === 'STOPPED' || status === 'FAILED' || status === 'NOT_FOUND';

  return (
    <section className="max-w-2xl space-y-6 animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>{t('errorTitle')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            {isConnected ? (
              <CheckCircle2 className="size-4 text-emerald-500" />
            ) : (
              <QrCode className="size-4 text-primary" />
            )}
            {t('connectionTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('connectionDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t('sessionLabel')}</Label>
            <Input
              readOnly
              value={state?.sessionName ?? ''}
              className="bg-muted border-border font-mono text-sm text-foreground"
            />
            <p className="text-xs text-muted-foreground">{t('sessionHint')}</p>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('statusLabel')}</span>
            <span
              className={
                isConnected
                  ? 'rounded-full bg-emerald-500/15 px-2.5 py-0.5 font-medium text-emerald-600 dark:text-emerald-400'
                  : 'rounded-full bg-muted px-2.5 py-0.5 font-medium text-foreground'
              }
            >
              {t(`status.${label}`)}
            </span>
            {polling && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>

          {status === 'SCAN_QR_CODE' && (
            <div className="space-y-3 rounded-lg border border-border p-4">
              <p className="text-sm font-medium text-foreground">{t('scanTitle')}</p>
              <p className="text-sm text-muted-foreground">{t('scanHint')}</p>
              <div className="flex justify-center">
                {state?.qr ? (
                  // eslint-disable-next-line @next/next/no-img-element -- data: URL from WAHA
                  <img
                    src={state.qr}
                    alt={t('qrAlt')}
                    className="size-64 rounded border border-border bg-white p-2"
                  />
                ) : (
                  <Loader2 className="size-8 animate-spin text-muted-foreground" />
                )}
              </div>
            </div>
          )}

          {isConnected && (
            <p className="text-sm text-muted-foreground">{t('connectedHint')}</p>
          )}

          <div className="flex flex-wrap gap-2">
            {(!state?.configured || isStopped) && (
              <Button
                onClick={() => run('POST', 'connectSuccess', 'connectFailed')}
                disabled={busy}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Power className="size-4" />
                )}
                {t('connect')}
              </Button>
            )}
            {state?.configured && !isStopped && (
              <Button
                variant="outline"
                onClick={() => run('POST', 'syncSuccess', 'connectFailed')}
                disabled={busy}
              >
                <RefreshCw className="size-4" />
                {t('syncWebhook')}
              </Button>
            )}
            {state?.configured && (
              <Button variant="outline" onClick={() => refresh()} disabled={busy}>
                <RefreshCw className="size-4" />
                {t('refresh')}
              </Button>
            )}
            {state?.configured && !isStopped && (
              <Button variant="outline" onClick={handleDisconnect} disabled={busy}>
                <Unplug className="size-4" />
                {t('disconnect')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {state?.webhookUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-foreground">
              {t('webhookTitle')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhookDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                readOnly
                value={state.webhookUrl}
                className="bg-muted border-border font-mono text-xs text-foreground"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={copyWebhook}
                aria-label={t('copy')}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            {isLocalUrl(state.webhookUrl) && (
              <Alert>
                <AlertTriangle className="size-4" />
                <AlertDescription>{t('webhookLocalWarning')}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      <Alert>
        <AlertTriangle className="size-4" />
        <AlertTitle>{t('unofficialTitle')}</AlertTitle>
        <AlertDescription>{t('unofficialBody')}</AlertDescription>
      </Alert>
    </section>
  );
}
