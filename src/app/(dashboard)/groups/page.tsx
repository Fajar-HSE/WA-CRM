'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CornerUpLeft, RefreshCw, SendHorizontal, Settings2, UserPlus, UsersRound, X } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { GrabNumbersDialog } from '@/components/groups/grab-numbers-dialog'
import { ManageGroupsDialog } from '@/components/groups/manage-groups-dialog'
import { useAuth } from '@/hooks/use-auth'
import { useGroupsUnread } from '@/hooks/use-groups-unread'
import { canEditSettings, canSendMessages } from '@/lib/auth/roles'
import { MAX_GROUP_TEXT } from '@/lib/groups/limits'
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
  message_id: string | null
  from_me: boolean
  sender_phone: string | null
  sender_name: string | null
  content_text: string | null
  created_at: string
}

// The group list is a small query, so it is refreshed often. Messages are
// only reloaded when the open group's latest message changes.
const POLL_MS = 10_000
const PAGE_SIZE = 200
// Within this distance of the bottom, new messages keep the view pinned down.
const STICK_PX = 80
// WAHA's echo of a message sent from here can lag a moment.
const ECHO_REFRESH_MS = 2_500

function groupName(g: Pick<GroupRow, 'subject' | 'jid'>): string {
  return g.subject || g.jid.replace('@g.us', '')
}

/** Ids WAHA could not report are local stand-ins that WhatsApp cannot quote. */
function canQuote(m: GroupMessage): boolean {
  return !!m.message_id && !m.message_id.startsWith('waha-local-')
}

export default function GroupsPage() {
  const t = useTranslations('Groups')
  const format = useFormatter()
  const { accountRole } = useAuth()
  const isAdmin = accountRole ? canEditSettings(accountRole) : false
  const canReply = accountRole ? canSendMessages(accountRole) : false

  const [groups, setGroups] = useState<GroupRow[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Messages are kept with the group they belong to, so switching groups
  // shows "loading" until the new group's rows arrive.
  const [loaded, setLoaded] = useState<{ groupId: string; rows: GroupMessage[] } | null>(null)
  const [manageOpen, setManageOpen] = useState(false)
  const [grab, setGrab] = useState<{ jid: string; name: string } | null>(null)
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<GroupMessage | null>(null)
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const { unreadIds, markGroupSeen } = useGroupsUnread(groups)

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
      .select('id, message_id, from_me, sender_phone, sender_name, content_text, created_at')
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

  const selected = groups?.find((g) => g.id === selectedId) ?? null
  // Changes whenever the open group gets a new message; drives the reload.
  const selectedStamp = selected ? `${selected.last_message_at ?? ''}|${selected.last_message_text ?? ''}` : null
  const selectedAt = selected?.last_message_at ?? null

  useEffect(() => {
    loadGroups()
  }, [loadGroups])

  // Keep the list fresh while the tab is in front, and catch up the moment
  // the person comes back to it.
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') loadGroups()
    }
    const tick = window.setInterval(refresh, POLL_MS)
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(tick)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [loadGroups])

  useEffect(() => {
    if (selectedId) loadMessages(selectedId)
  }, [selectedId, selectedStamp, loadMessages])

  // What is on screen counts as read, but only while the tab is in front.
  useEffect(() => {
    if (!selectedId || loaded?.groupId !== selectedId) return
    const mark = () => {
      if (document.visibilityState === 'visible') markGroupSeen(selectedId, selectedAt)
    }
    mark()
    document.addEventListener('visibilitychange', mark)
    return () => document.removeEventListener('visibilitychange', mark)
  }, [selectedId, selectedAt, loaded, markGroupSeen])

  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [loaded])

  const onScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
  }

  const selectGroup = (id: string) => {
    if (id === selectedId) return
    // A draft or quote written for one group must never end up in another.
    setText('')
    setReplyTo(null)
    stickRef.current = true
    setSelectedId(id)
  }

  const send = useCallback(async () => {
    const body = text.trim()
    if (!selected || !body || sending) return
    setSending(true)
    try {
      const res = await fetch('/api/whatsapp/groups/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_id: selected.id,
          text: body,
          reply_to_message_id: replyTo && canQuote(replyTo) ? replyTo.message_id : undefined,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        // The draft stays, so nothing typed is lost.
        toast.error(data.error || t('sendFailed'))
        return
      }
      setText('')
      setReplyTo(null)
      stickRef.current = true
      loadGroups()
      loadMessages(selected.id)
      window.setTimeout(loadGroups, ECHO_REFRESH_MS)
    } catch {
      toast.error(t('sendFailed'))
    } finally {
      setSending(false)
    }
  }, [text, selected, sending, replyTo, loadGroups, loadMessages, t])

  const messages = loaded && loaded.groupId === selectedId ? loaded.rows : []
  const loadingMessages = selectedId !== null && loaded?.groupId !== selectedId

  const when = (iso: string) => format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' })
  const senderLabel = (m: GroupMessage) =>
    m.from_me
      ? t('you')
      : [m.sender_name, m.sender_phone ? `+${m.sender_phone}` : null].filter(Boolean).join(' · ') ||
        t('unknownSender')

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
              {groups.map((g) => {
                const unread = g.id !== selectedId && unreadIds.has(g.id)
                return (
                  <li key={g.id}>
                    <button
                      type="button"
                      onClick={() => selectGroup(g.id)}
                      className={cn(
                        'block w-full px-4 py-3 text-left transition-colors hover:bg-muted/50',
                        g.id === selectedId && 'bg-muted',
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            'block min-w-0 flex-1 truncate text-sm text-foreground',
                            unread ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {groupName(g)}
                        </span>
                        {unread ? (
                          <span
                            role="img"
                            aria-label={t('unreadGroup')}
                            title={t('unreadGroup')}
                            className="size-2 shrink-0 rounded-full bg-primary"
                          />
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          'mt-0.5 block truncate text-xs',
                          unread ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {g.last_message_text ?? t('noMessages')}
                      </span>
                      {g.last_message_at ? (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {when(g.last_message_at)}
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
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
                    onClick={() => {
                      loadGroups()
                      loadMessages(selected.id)
                    }}
                    aria-label={t('refresh')}
                    title={t('refresh')}
                  >
                    <RefreshCw className="size-4" aria-hidden />
                  </Button>
                </div>
              </header>

              <div ref={scrollRef} onScroll={onScroll} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
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
                          {senderLabel(m)}
                        </p>
                        <p className="mt-0.5 break-words whitespace-pre-wrap">{m.content_text}</p>
                        <div
                          className={cn(
                            'mt-1 flex items-center justify-between gap-3 text-[10px]',
                            m.from_me ? 'opacity-70' : 'text-muted-foreground',
                          )}
                        >
                          <span>{when(m.created_at)}</span>
                          {canReply && canQuote(m) ? (
                            <button
                              type="button"
                              onClick={() => setReplyTo(m)}
                              className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                            >
                              <CornerUpLeft className="size-3" aria-hidden />
                              {t('reply')}
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {canReply ? (
                <footer className="border-t border-border p-3">
                  {replyTo ? (
                    <div className="mb-2 flex items-start gap-2 rounded-lg border-l-2 border-primary bg-muted/60 px-3 py-1.5 text-xs">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground">
                          {t('replyingTo', { name: senderLabel(replyTo) })}
                        </p>
                        <p className="line-clamp-2 break-words text-muted-foreground">{replyTo.content_text}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setReplyTo(null)}
                        aria-label={t('cancelReply')}
                        title={t('cancelReply')}
                      >
                        <X className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  ) : null}
                  <div className="flex items-end gap-2">
                    <Textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => {
                        // Enter sends; Shift+Enter is a new line. Enter that
                        // confirms an IME candidate must not send.
                        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault()
                          void send()
                        }
                      }}
                      placeholder={t('messagePlaceholder')}
                      aria-label={t('messagePlaceholder')}
                      maxLength={MAX_GROUP_TEXT}
                      rows={1}
                      className="max-h-40 min-h-10 resize-none"
                    />
                    <Button onClick={() => void send()} disabled={sending || !text.trim()} aria-label={t('send')}>
                      <SendHorizontal className="size-4" aria-hidden />
                      <span className="hidden sm:inline">{t('send')}</span>
                    </Button>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">{t('sendHint')}</p>
                </footer>
              ) : (
                <footer className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
                  {t('readOnly')}
                </footer>
              )}
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
