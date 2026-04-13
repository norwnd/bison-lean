import { create } from 'zustand'
import { getJSON } from '../services/api'
import type { MarketMakingStatus, MMBotStatus, RunStatsNote, EpochReportNote, CEXProblemsNote } from './types'
import { useAuthStore } from './useAuthStore'

interface MMState {
  fetchMMStatus: () => Promise<void>
  handleRunStatsNote: (note: RunStatsNote) => void
  handleEpochReportNote: (note: EpochReportNote) => void
  handleCEXProblemsNote: (note: CEXProblemsNote) => void
  botStatus: (host: string, baseID: number, quoteID: number) => MMBotStatus | undefined
}

function findBot (status: MarketMakingStatus | null, host: string, baseID: number, quoteID: number): MMBotStatus | undefined {
  if (!status) return undefined
  return status.bots.find(b =>
    b.config.host === host && b.config.baseID === baseID && b.config.quoteID === quoteID
  )
}

export const useMMStore = create<MMState>(() => ({
  fetchMMStatus: async () => {
    const resp = await getJSON('/api/mmstatus')
    if (resp.requestSuccessful && resp.ok) {
      useAuthStore.setState({ mmStatus: resp.mmStatus })
    }
  },

  handleRunStatsNote: (note: RunStatsNote) => {
    const { mmStatus } = useAuthStore.getState()
    if (!mmStatus) return
    const bot = findBot(mmStatus, note.host, note.baseID, note.quoteID)
    if (bot && note.stats) {
      bot.runStats = note.stats
      useAuthStore.setState({ mmStatus: { ...mmStatus } })
    }
  },

  handleEpochReportNote: (note: EpochReportNote) => {
    const { mmStatus } = useAuthStore.getState()
    if (!mmStatus) return
    const bot = findBot(mmStatus, note.host, note.baseID, note.quoteID)
    if (bot && note.report) {
      bot.latestEpoch = note.report
      useAuthStore.setState({ mmStatus: { ...mmStatus } })
    }
  },

  handleCEXProblemsNote: (note: CEXProblemsNote) => {
    const { mmStatus } = useAuthStore.getState()
    if (!mmStatus) return
    const bot = findBot(mmStatus, note.host, note.baseID, note.quoteID)
    if (bot && note.problems) {
      bot.cexProblems = note.problems
      useAuthStore.setState({ mmStatus: { ...mmStatus } })
    }
  },

  botStatus: (host: string, baseID: number, quoteID: number) => {
    const { mmStatus } = useAuthStore.getState()
    return findBot(mmStatus, host, baseID, quoteID)
  },
}))
