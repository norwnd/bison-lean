import { useUIStore } from '../stores/useUIStore'

export function useTheme () {
  const darkMode = useUIStore(s => s.darkMode)
  const toggleDarkMode = useUIStore(s => s.toggleDarkMode)
  return { darkMode, toggleDarkMode }
}
