// Responsive layout hook ported from vanilla
// `mmsettings/hooks/PageSizeBreakpoints.ts`.
//
// Exposes a Bootstrap-style breakpoint helper. Consumers pass an array
// of the breakpoints they care about (e.g. ['md', 'xl']) and receive
// the current label based on `window.innerWidth`. Used by mmsettings
// components to reshuffle layouts at specific widths without touching
// CSS media queries.

import { useState, useEffect } from 'react'

/**
 * Enum representing Bootstrap breakpoint sizes with their min-width values.
 * - XS: 0 (default/smallest)
 * - SM: 576px
 * - MD: 768px
 * - LG: 992px
 * - XL: 1200px
 * - XXL: 1400px
 */
export enum BootstrapBreakpoint {
  XS = 0,
  SM = 576,
  MD = 768,
  LG = 992,
  XL = 1200,
  XXL = 1400,
}

const BREAKPOINT_VALUES: Record<keyof typeof BootstrapBreakpoint, number> = {
  XS: BootstrapBreakpoint.XS,
  SM: BootstrapBreakpoint.SM,
  MD: BootstrapBreakpoint.MD,
  LG: BootstrapBreakpoint.LG,
  XL: BootstrapBreakpoint.XL,
  XXL: BootstrapBreakpoint.XXL
}

const useWindowWidth = () => {
  const [width, setWidth] = useState<number>(typeof window !== 'undefined' ? window.innerWidth : 0)

  useEffect(() => {
    const handleResize = () => {
      setWidth(window.innerWidth)
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return width
}

/**
 * Determines the current Bootstrap-like breakpoint based on the list of
 * passed breakpoints. Passed breakpoints define the lower bounds for
 * ranges (min-width). Returns 'xs' if below the first passed breakpoint.
 */
export const useBootstrapBreakpoints = (passedBreakpoints: Array<'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'>): string => {
  const width = useWindowWidth()

  const breakpointMap = passedBreakpoints
    .map(bp => {
      const key = bp.toUpperCase() as keyof typeof BootstrapBreakpoint
      if (!(key in BREAKPOINT_VALUES)) {
        console.warn(`Invalid breakpoint: ${bp}. Ignoring.`)
        return null
      }
      return { label: bp.toLowerCase(), value: BREAKPOINT_VALUES[key] }
    })
    .filter((bp): bp is { label: string; value: number } => bp !== null)
    .sort((a, b) => a.value - b.value)

  if (breakpointMap.length === 0) {
    return 'xs'
  }

  let currentBp = 'xs'
  for (let i = 0; i < breakpointMap.length; i++) {
    const current = breakpointMap[i]
    const next = breakpointMap[i + 1]

    if (width >= current.value && (!next || width < next.value)) {
      currentBp = current.label
      break
    }
  }

  return currentBp
}
