'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { membersToCsv } from './csv'

interface Member {
  id: string
  phone: string | null
  is_admin: boolean
}

interface MembersResponse {
  members?: Member[]
  total?: number
  unresolved?: number
  truncated?: boolean
  error?: string
}

/** Keep in step with GRAB_BATCH_LIMIT on the server. */
const SLICE = 150

export function GrabNumbersDialog({
  onOpenChange,
  jid,
  name,
}: {
  onOpenChange: (open: boolean) => void
  jid: string
  name: string
}) {
  const t = useTranslations('Groups')
  // Mounted only while the dialog is open, so it starts out loading.
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<MembersResponse | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/whatsapp/groups/members?jid=${encodeURIComponent(jid)}`)
        const body = (await res.json().catch(() => ({}))) as MembersResponse
        if (cancelled) return
        if (!res.ok) {
          toast.error(body.error || t('membersFailed'))
          onOpenChange(false)
          return
        }
        setData(body)
        // Start with everyone whose number is known ticked.
        setPicked(new Set((body.members ?? []).filter((m) => m.phone).map((m) => m.phone as string)))
      } catch {
        if (!cancelled) {
          toast.error(t('membersFailed'))
          onOpenChange(false)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [jid, onOpenChange, t])

  const withPhone = useMemo(
    () => (data?.members ?? []).filter((m): m is Member & { phone: string } => !!m.phone),
    [data],
  )
  const visible = useMemo(() => {
    const q = query.replace(/\D/g, '')
    return q ? withPhone.filter((m) => m.phone.includes(q)) : withPhone
  }, [withPhone, query])

  const toggle = (phone: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(phone)
      else next.delete(phone)
      return next
    })

  const chosen = withPhone.filter((m) => picked.has(m.phone))

  const downloadCsv = () => {
    const csv = membersToCsv(
      chosen.map((m) => ({ phone: m.phone, admin: m.is_admin })),
      name,
    )
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'anggota-grup.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const save = useCallback(async () => {
    if (chosen.length === 0 || saving) return
    setSaving(true)
    const total = { created: 0, existing: 0, tagged: 0, invalid: 0 }
    try {
      for (let i = 0; i < chosen.length; i += SLICE) {
        const res = await fetch('/api/whatsapp/groups/grab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jid,
            group_name: name,
            members: chosen.slice(i, i + SLICE).map((m) => ({ phone: m.phone })),
          }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          created?: number
          existing?: number
          tagged?: number
          invalid?: number
          error?: string
        }
        if (!res.ok) {
          toast.error(body.error || t('grabFailed'))
          return
        }
        total.created += body.created ?? 0
        total.existing += body.existing ?? 0
        total.tagged += body.tagged ?? 0
        total.invalid += body.invalid ?? 0
      }
      toast.success(
        t('grabDone', { created: total.created, existing: total.existing, tagged: total.tagged }),
      )
      onOpenChange(false)
    } catch {
      toast.error(t('grabFailed'))
    } finally {
      setSaving(false)
    }
  }, [chosen, jid, name, onOpenChange, saving, t])

  return (
    <Dialog open onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('grabTitle', { name })}</DialogTitle>
          <DialogDescription>{t('grabDesc', { tag: name.slice(0, 40) })}</DialogDescription>
        </DialogHeader>

        <p className="rounded-md border border-status-critical/30 bg-status-critical/10 px-3 py-2 text-xs text-foreground">
          {t('grabWarning')}
        </p>

        {loading || !data ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t('loadingMembers')}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {t('membersSummary', {
                total: data.total ?? 0,
                found: withPhone.length,
                hidden: data.unresolved ?? 0,
              })}
              {data.truncated ? ` ${t('truncatedNote')}` : ''}
            </p>

            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('search')}
                inputMode="numeric"
                className="h-8"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPicked(new Set(withPhone.map((m) => m.phone)))}
              >
                {t('selectAll')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPicked(new Set())}>
                {t('clearAll')}
              </Button>
            </div>

            <ul className="max-h-[34dvh] divide-y divide-border overflow-y-auto rounded-md border border-border">
              {visible.map((m) => (
                <li key={m.phone}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                    <Checkbox
                      checked={picked.has(m.phone)}
                      onCheckedChange={(c) => toggle(m.phone, c === true)}
                    />
                    <span className="flex-1 tabular-nums">+{m.phone}</span>
                    {m.is_admin ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                        {t('admin')}
                      </span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t('selected', { count: chosen.length })}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={downloadCsv} disabled={chosen.length === 0 || saving}>
            <Download className="size-4" aria-hidden />
            {t('downloadCsv')}
          </Button>
          <Button onClick={() => void save()} disabled={chosen.length === 0 || saving}>
            {saving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <UserPlus className="size-4" aria-hidden />
            )}
            {saving ? t('saving') : t('saveContacts')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
