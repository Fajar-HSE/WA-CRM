'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { useRealtime } from '@/hooks/use-realtime'
import { Button } from '@/components/ui/button'
import { loadActivity } from '@/lib/dashboard/queries'
import type { ActivityItem } from '@/lib/dashboard/types'
import {
  browserTimeZone,
  loadOverview,
  needsSetup,
  parseOverviewRange,
  type DashboardOverview,
  type OverviewRange,
} from '@/lib/dashboard/overview'
import { derivePresence } from '@/lib/presence'

import { ActivityFeed } from '@/components/dashboard/activity-feed'
import { AttentionRow } from '@/components/dashboard/attention-row'
import { KpiRow } from '@/components/dashboard/kpi-row'
import { MessageVolumeCard } from '@/components/dashboard/message-volume-card'
import { OverviewHeader } from '@/components/dashboard/overview-header'
import { ReplyQueueCard } from '@/components/dashboard/reply-queue-card'
import { SetupChecklist } from '@/components/dashboard/setup-checklist'
import { SummaryTabs } from '@/components/dashboard/summary-tabs'

const POLL_MS = 60_000
const REALTIME_DEBOUNCE_MS = 2_000

export default function DashboardPage() {
  return (
    <Suspense fallback={null}>
      <DashboardPageInner />
    </Suspense>
  )
}

function DashboardPageInner() {
  const t = useTranslations('Dashboard.overview')
  const tHeader = useTranslations('Dashboard.overview.header')
  const tKpi = useTranslations('Dashboard.overview.kpi')
  const router = useRouter()
  const searchParams = useSearchParams()
  const range = parseOverviewRange(searchParams.get('range'))
  const { defaultCurrency, profile } = useAuth()

  const [overview, setOverview] = useState<DashboardOverview | null>(null)
  const [failed, setFailed] = useState(false)
  const [activity, setActivity] = useState<ActivityItem[] | null>(null)
  const [activityLoading, setActivityLoading] = useState(true)
  const [now, setNow] = useState(() => Date.now())
  const requestRef = useRef(0)
  const debounceRef = useRef<number | null>(null)

  const refresh = useCallback((days: OverviewRange) => {
    const request = ++requestRef.current
    loadOverview(createClient(), days, browserTimeZone())
      .then((data) => {
        if (request !== requestRef.current) return
        setOverview(data)
        setFailed(false)
        setNow(Date.now())
      })
      .catch((err) => {
        if (request !== requestRef.current) return
        console.error('[dashboard] overview failed:', err)
        setFailed(true)
      })
  }, [])

  useEffect(() => {
    refresh(range)
  }, [range, refresh])

  // Same cadence as the overview: on mount, every poll, and (debounced)
  // when a message or conversation changes. It used to load once, so the
  // feed fell behind the cards above it.
  const refreshActivity = useCallback(() => {
    loadActivity(createClient(), 50)
      .then(setActivity)
      .catch((err) => console.error('[dashboard] activity failed:', err))
      .finally(() => setActivityLoading(false))
  }, [])

  useEffect(() => {
    refreshActivity()
  }, [refreshActivity])

  useEffect(() => {
    const tick = window.setInterval(() => {
      setNow(Date.now())
      if (document.visibilityState === 'visible') {
        refresh(range)
        refreshActivity()
      }
    }, POLL_MS)
    return () => window.clearInterval(tick)
  }, [range, refresh, refreshActivity])

  useEffect(
    () => () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    },
    [],
  )

  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      refresh(range)
      refreshActivity()
    }, REALTIME_DEBOUNCE_MS)
  }, [range, refresh, refreshActivity])

  useRealtime({
    channelName: 'dashboard-overview',
    onMessageEvent: scheduleRefresh,
    onConversationEvent: scheduleRefresh,
  })

  const handleRangeChange = useCallback(
    (next: OverviewRange) => {
      const params = new URLSearchParams(searchParams.toString())
      params.set('range', String(next))
      setFailed(false)
      router.replace(`/dashboard?${params.toString()}`, { scroll: false })
    },
    [router, searchParams],
  )

  const data = overview?.days === range ? overview : null

  const onlineCount = useMemo(
    () =>
      (overview?.replies.team ?? []).filter(
        (m) => derivePresence(m.presence ?? undefined, m.lastSeenAt, now) === 'online',
      ).length,
    [overview, now],
  )

  if (failed && !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => refresh(range)}>
          {t('retry')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <OverviewHeader
        data={data}
        now={now}
        name={profile?.full_name ?? null}
        range={range}
        onRangeChange={handleRangeChange}
      />

      {data && needsSetup(data.setup) ? (
        <SetupChecklist setup={data.setup} />
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="dash-now">
            <h3 id="dash-now" className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t('sections.now')}
            </h3>
            <AttentionRow data={data} now={now} onlineCount={onlineCount} />
            <ReplyQueueCard data={data} now={now} />
          </section>

          <section className="space-y-3" aria-labelledby="dash-period">
            <h3 id="dash-period" className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
              {t('sections.period', { range: tHeader(`range.${range}`) })}
              <span className="font-normal tracking-normal normal-case">
                {' · '}
                {tKpi(`vsPrevious.${range}`)}
              </span>
            </h3>
            <KpiRow data={data} currency={defaultCurrency} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <MessageVolumeCard data={data} />
              <SummaryTabs data={data} now={now} currency={defaultCurrency} />
            </div>
          </section>

          <ActivityFeed items={activity} loading={activityLoading} />
        </>
      )}
    </div>
  )
}
