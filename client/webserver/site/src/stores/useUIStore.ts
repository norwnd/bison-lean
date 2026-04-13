import { create } from 'zustand'
import * as State from '../services/state'

interface UIState {
  darkMode: boolean
  showPopups: boolean
  leftMarketDock: boolean

  toggleDarkMode: () => void
  togglePopups: () => void
  toggleLeftMarketDock: () => void
}

export const useUIStore = create<UIState>((set) => ({
  darkMode: State.isDark(),
  showPopups: State.fetchLocal(State.popupsLK) === '1',
  leftMarketDock: State.fetchLocal(State.leftMarketDockLK) === '1',

  toggleDarkMode: () => {
    set(prev => {
      const next = !prev.darkMode
      State.storeLocal(State.darkModeLK, next ? '1' : '0')
      document.body.classList.toggle('dark', next)
      return { darkMode: next }
    })
  },

  togglePopups: () => {
    set(prev => {
      const next = !prev.showPopups
      State.storeLocal(State.popupsLK, next ? '1' : '0')
      return { showPopups: next }
    })
  },

  toggleLeftMarketDock: () => {
    set(prev => {
      const next = !prev.leftMarketDock
      State.storeLocal(State.leftMarketDockLK, next ? '1' : '0')
      return { leftMarketDock: next }
    })
  },
}))
