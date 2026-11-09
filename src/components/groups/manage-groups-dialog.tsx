'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'

export interface LiveGroup {
  jid: string
  subject: string | null
  size: number | null
  monitored: boolean
  left: boolean
}

/** Admin only: choose which groups are saved, and grab members from any of them. */
export function ManageGroupsDialog({
  onOpenChange,
  onChanged,
  onGrab,
}: {
  onOpenChange: (open: boolean) => void
  onChanged: () => void
  onGrab: (group: { jid: string; name: string }) => void
}) {
  const t = useTranslations('Groups')
  // Mounted only while the dialog is open, so it starts out loading.
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState<LiveGroup[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/whatsapp/groups')
        const body = (await res.json().catch(() => ({}))) as { groups?: LiveGroup[]; error?: string }
        if (cancelled) return
        if (!res.ok) {
          toast.error(body.error || t('loadFailed'))
          return
        }
        setGroups(body.groups ?? [])
      } catch {
        if (!cancelled) toast.error(t('loadFailed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t])

  const setMonitored = useCallback(
    async (g: LiveGroup, enabled: boolean) => {
      setBusy(g.jid)
      try {
        const res = await fetch('/api/whatsapp/groups/monitor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jid: g.jid, subject: g.subject, enabled }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          toast.error(body.error || t('saveFailed'))
          return
        }
        setGroups((prev) => prev.map((x) => (x.jid === g.jid ? { ...x, monitored: enabled } : x)))
        onChanged()
      } catch {
        toast.error(t('saveFailed'))
      } finally {
        setBusy(null)
      }
    },
    [onChanged, t],
  )

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('manageTitle')}</DialogTitle>
          <DialogDescription>{t('manageDesc')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('loadingGroups')}
          </div>
        ) : groups.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('noGroups')}</p>
        ) : (
          <ul className="max-h-[50dvh] divide-y divide-border overflow-y-auto rounded-md border border-border">
            {groups.map((g) => {
              const name = g.subject || g.jid.replace('@g.us', '')
              return (
                <li key={g.jid} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{name}</p>
                    <p className="text-xs text-muted-foreground">
                      {g.left
                        ? t('left')
                        : g.size != null
                          ? t('members', { count: g.size })
                          : ''}
                    </p>
                  </div>
                  {!g.left ? (
                    <Button variant="outline" size="sm" onClick={() => onGrab({ jid: g.jid, name })}>
                      <UserPlus className="size-3.5" aria-hidden />
                      {t('grab')}
                    </Button>
                  ) : null}
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    {t('monitor')}
                    <Switch
                      checked={g.monitored}
                      disabled={busy === g.jid}
                      onCheckedChange={(c) => void setMonitored(g, c === true)}
                      aria-label={`${t('monitor')} ${name}`}
                    />
                  </label>
                </li>
              )
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}
