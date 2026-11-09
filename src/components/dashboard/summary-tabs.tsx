'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { DashboardOverview } from '@/lib/dashboard/overview'
import { CampaignsCard } from './campaigns-card'
import { PipelineCard } from './pipeline-card'
import { TeamCard } from './team-card'

type SummaryTab = 'team' | 'pipeline' | 'campaigns'

/**
 * Pipeline, team and campaigns used to sit side by side as three cards.
 * They are reference material, not things to watch, so they share one slot
 * and the reader opens the one they want.
 */
export function SummaryTabs({
  data,
  now,
  currency,
}: {
  data: DashboardOverview | null
  now: number
  currency: string
}) {
  const t = useTranslations('Dashboard.overview')
  const [tab, setTab] = useState<SummaryTab>('team')

  return (
    <div className="flex flex-col gap-3">
      <Tabs value={tab} onValueChange={(v) => setTab(v as SummaryTab)}>
        <TabsList aria-label={t('sections.summaryLabel')}>
          <TabsTrigger value="team" className="px-3 text-xs">
            {t('team.title')}
          </TabsTrigger>
          <TabsTrigger value="pipeline" className="px-3 text-xs">
            {t('pipeline.title')}
          </TabsTrigger>
          <TabsTrigger value="campaigns" className="px-3 text-xs">
            {t('campaigns.title')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'team' ? <TeamCard data={data} now={now} /> : null}
      {tab === 'pipeline' ? <PipelineCard data={data} currency={currency} /> : null}
      {tab === 'campaigns' ? <CampaignsCard data={data} /> : null}
    </div>
  )
}
