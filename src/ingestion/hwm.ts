import fs from 'fs'
import path from 'path'
import type { HwmMap } from './types.js'

export function loadHwm(hwmPath: string): HwmMap {
  try {
    const raw = fs.readFileSync(hwmPath, 'utf-8')
    return JSON.parse(raw) as HwmMap
  } catch {
    return {}  // file doesn't exist yet = empty map
  }
}

export function saveHwm(hwmPath: string, hwm: HwmMap): void {
  const dir = path.dirname(hwmPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(hwmPath, JSON.stringify(hwm, null, 2), 'utf-8')
}

export function getHwm(hwm: HwmMap, source: string): string | undefined {
  return hwm[source]
}

export function setHwm(hwm: HwmMap, source: string, timestamp: string): HwmMap {
  return { ...hwm, [source]: timestamp }  // immutable update
}
