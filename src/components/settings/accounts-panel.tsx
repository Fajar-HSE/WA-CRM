'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useAuth } from '@/hooks/use-auth';
import type { PlatformAccountRow } from '@/lib/platform/accounts';
import { SettingsPanelHead } from './settings-panel-head';

/** Settings → Accounts (platform administrator only). */
export function AccountsPanel() {
  const t = useTranslations('PlatformAccounts');
  const locale = useLocale();
  const { accountId } = useAuth();
  const [rows, setRows] = useState<PlatformAccountRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<PlatformAccountRow | null>(null);
  const [busy, setBusy] = useState(false);

  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let alive = true;
    fetch('/api/platform/accounts', { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || t('loadFailed'));
        if (!alive) return;
        setRows(json.accounts as PlatformAccountRow[]);
        setError(null);
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : t('loadFailed'));
      });
    return () => {
      alive = false;
    };
  }, [t, reloadTick]);

  async function confirm() {
    if (!target) return;
    const disabling = !target.disabledAt;
    setBusy(true);
    try {
      const res = await fetch(`/api/platform/accounts/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disabled: disabling }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || t('updateFailed'));
      toast.success(disabling ? t('disabledToast') : t('enabledToast'));
      setTarget(null);
      setReloadTick((n) => n + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('desc')} />

      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : rows === null ? (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <Card>
          <CardContent className="overflow-x-auto p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('colAccount')}</TableHead>
                  <TableHead>{t('colOwner')}</TableHead>
                  <TableHead>{t('colMembers')}</TableHead>
                  <TableHead>{t('colWhatsapp')}</TableHead>
                  <TableHead>{t('colCreated')}</TableHead>
                  <TableHead>{t('colStatus')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const own = r.id === accountId;
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">
                        {r.name}
                        {r.isPlatform ? (
                          <Badge variant="outline" className="ml-2">
                            {own ? t('you') : t('platform')}
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <div>{r.ownerName || '—'}</div>
                        <div className="text-xs text-muted-foreground">{r.ownerEmail}</div>
                      </TableCell>
                      <TableCell>{r.memberCount}</TableCell>
                      <TableCell className="text-xs">
                        {r.whatsappStatus ?? t('noWhatsapp')}
                      </TableCell>
                      <TableCell className="text-xs">
                        {fmt.format(new Date(r.createdAt))}
                      </TableCell>
                      <TableCell>
                        <Badge variant={r.disabledAt ? 'destructive' : 'secondary'}>
                          {r.disabledAt ? t('disabled') : t('active')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {own || (r.isPlatform && !r.disabledAt) ? null : (
                          <Button
                            size="sm"
                            variant={r.disabledAt ? 'outline' : 'destructive'}
                            onClick={() => setTarget(r)}
                          >
                            {r.disabledAt ? t('enable') : t('disable')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Dialog open={!!target} onOpenChange={(o) => !o && !busy && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {target?.disabledAt
                ? t('confirmEnableTitle', { name: target?.name ?? '' })
                : t('confirmDisableTitle', { name: target?.name ?? '' })}
            </DialogTitle>
            <DialogDescription>
              {target?.disabledAt ? t('confirmEnableBody') : t('confirmDisableBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>
              {t('cancel')}
            </Button>
            <Button
              variant={target?.disabledAt ? 'default' : 'destructive'}
              onClick={confirm}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {target?.disabledAt ? t('enable') : t('disable')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
