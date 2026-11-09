'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Settings2, UserPlus, UsersRound } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { GrabNumbersDialog } from '@/components/groups/grab-numbers-dialog'
import { ManageGroupsDialog } from '@/components/groups/manage-groups-dialog'
import { useAuth } from '@/hooks/use-auth'
import { canEditSettings } from '@/lib/auth/roles'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

interface GroupRow {
  id: string
  jid: string
  subject: string | null
  last_message_at: string | null
  last_message_text: string | null
}

interface GroupMessage {
  id: string
  from_me: boolean
  sender_phone: string | null
  sender_name: string | null
  content_text: string | null
  created_at: string
}

const POLL_MS = 30_000
const PAGE_SIZE = 200

function groupName(g: Pick<GroupRow, 'subject' | 'jid'>): string {
  return g.subject || g.jid.replace('@g.us', '')
}

export default function GroupsPage() {
  const t = useTranslations('Groups')
  const format = useFormatter()
  const { accountRole } = useAuth()
  const isAdmin = accountRole ? canEditSettings(accountRole) : false

  const [groups, setGroups] = useState<GroupRow[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Messages are kept with the group they belong to, so switching groups
  // shows "loading" until the new group's rows arrive.
  const [loaded, setLoaded] = useState<{ groupId: string; rows: GroupMessage[] } | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [grab, setGrab] = useState<{ jid: string; name: string } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadGroups = useCallback(() => {
    createClient()
      .from('whatsapp_groups')
      .select('id, jid, subject, last_message_at, last_message_text')
      .eq('monitored', true)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .then(({ data, error }) => {
        if (error) {
          console.error('[groups] load failed:', error)
          setGroups((prev) => prev ?? [])
          return
        }
        setGroups((data ?? []) as GroupRow[])
      })
  }, [])

  const loadMessages = useCallback((groupId: string) => {
    createClient()
      .from('whatsapp_group_messages')
      .select('id, from_me, sender_phone, sender_name, content_text, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)
      .then(({ data, error }) => {
        if (error) {
          console.error('[groups] messages failed:', error)
          return
        }
        setLoaded({ groupId, rows: ((data ?? []) as GroupMessage[]).slice().reverse() })
      })
  }, [])

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  useEffect(() => {
    if (selectedId) loadMessages(selectedId)
  }, [selectedId, loadMessages])

  useEffect(() => {
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      loadGroups()
      if (selectedId) loadMessages(selectedId)
    }, POLL_MS)
    return () => window.clearInterval(tick)
  }, [selectedId, loadGroups, loadMessages])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [loaded])

  const selected = groups?.find((g) => g.id === selectedId) ?? null
  const messages = loaded && loaded.groupId === selectedId ? loaded.rows : []
  const loadingMessages = selectedId !== null && loaded?.groupId !== selectedId

  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <UsersRound className="h-6 w-6 text-primary" aria-hidden />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">{t('title')}</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t('description')}</p>
        </div>
        {isAdmin ? (
          <Button variant="outline" size="sm" onClick={() => setManageOpen(true)}>
            <Settings2 className="size-4" aria-hidden />
            {t('manage')}
          </Button>
        ) : null}
      </div>

      <div className="mt-4 grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto rounded-xl bg-card ring-1 ring-foreground/10">
          {groups === null ? (
            <p className="p-4 text-sm text-muted-foreground">…</p>
          ) : groups.length === 0 ? (
            <div className="p-4 text-sm">
              <p className="font-medium text-foreground">{t('noMonitored')}</p>
              <p className="mt-1 text-muted-foreground">{t('noMonitoredHint')}</p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {groups.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(g.id)}
                    className={cn(
                      'block w-full px-4 py-3 text-left transition-colors hover:bg-muted/50',
                      g.id === selectedId && 'bg-muted',
                    )}
                  >
                    <span className="block truncate text-sm font-medium text-foreground">{groupName(g)}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {g.last_message_text ?? t('noMessages')}
                    </span>
                    {g.last_message_at ? (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{when(g.last_message_at)}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className="flex min-h-[24rem] min-w-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              {t('selectGroup')}
            </div>
          ) : (
            <>
              <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
                <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">{groupName(selected)}</h2>
                <div className="flex items-center gap-2">
                  {isAdmin ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setGrab({ jid: selected.jid, name: groupName(selected) })}
                    >
                      <UserPlus className="size-3.5" aria-hidden />
                      {t('grab')}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => loadMessages(selected.id)}
                    aria-label={t('refresh')}
                    title={t('refresh')}
                  >
                    <RefreshCw className="size-4" aria-hidden />
                  </Button>
                </div>
              </header>

              <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
                {loadingMessages ? (
                  <p className="text-center text-sm text-muted-foreground">…</p>
                ) : messages.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">{t('noMessagesYet')}</p>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className={cn('flex', m.from_me && 'justify-end')}>
                      <div
                        className={cn(
                          'max-w-[85%] rounded-xl px-3 py-2 text-sm',
                          m.from_me ? 'bg-primary text-primary-foreground' : 'bg-muted text-foreground',
                        )}
                      >
                        <p className={cn('text-xs font-medium', m.from_me ? 'opacity-80' : 'text-muted-foreground')}>
                          {m.from_me
                            ? t('you')
                            : [m.sender_name, m.sender_phone ? `+${m.sender_phone}` : null]
                                .filter(Boolean)
                                .join(' · ') || t('unknownSender')}
                        </p>
                        <p className="mt-0.5 break-words whitespace-pre-wrap">{m.content_text}</p>
                        <p className={cn('mt-1 text-[10px]', m.from_me ? 'opacity-70' : 'text-muted-foreground')}>
                          {when(m.created_at)}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                {t('readOnly')}
              </footer>
            </>
          )}
        </section>
      </div>

      {isAdmin && manageOpen ? (
        <ManageGroupsDialog
          onOpenChange={setManageOpen}
          onChanged={loadGroups}
          onGrab={(g) => {
            setManageOpen(false)
            setGrab(g)
          }}
        />
      ) : null}
      {grab ? (
        <GrabNumbersDialog
          onOpenChange={(open) => {
            if (!open) setGrab(null)
          }}
          jid={grab.jid}
          name={grab.name}
        />
      ) : null}
    </div>
  )
}
