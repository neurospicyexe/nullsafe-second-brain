// src/ingestion/cron-health.ts
//
// Singleton cron health tracker. Records last-run state per job and detects
// stale jobs (no run within 1.5x expected interval). Exposed via /health endpoint.

export type CronJobStatus = 'never' | 'running' | 'ok' | 'error'

export interface CronJobHealth {
  name: string
  status: CronJobStatus
  lastStarted: string | null
  lastCompleted: string | null
  lastError: string | null
  staleSince: string | null
  expectedIntervalMs: number
}

class CronHealthTracker {
  private jobs = new Map<string, CronJobHealth>()

  register(name: string, expectedIntervalMs: number): void {
    this.jobs.set(name, {
      name,
      status: 'never',
      lastStarted: null,
      lastCompleted: null,
      lastError: null,
      staleSince: null,
      expectedIntervalMs,
    })
  }

  start(name: string): void {
    const job = this.jobs.get(name)
    if (!job) return
    job.status = 'running'
    job.lastStarted = new Date().toISOString()
    job.staleSince = null  // reset stale flag when it actually fires
  }

  complete(name: string): void {
    const job = this.jobs.get(name)
    if (!job) return
    job.status = 'ok'
    job.lastCompleted = new Date().toISOString()
    job.lastError = null
  }

  fail(name: string, error: string): void {
    const job = this.jobs.get(name)
    if (!job) return
    job.status = 'error'
    job.lastError = error.slice(0, 500)
    job.lastCompleted = new Date().toISOString()
  }

  // Call periodically or on /health request. Logs STALE warnings to stderr.
  checkStale(): void {
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if (job.status === 'never' || job.status === 'running') continue
      const lastRun = job.lastStarted ? new Date(job.lastStarted).getTime() : 0
      const threshold = job.expectedIntervalMs * 1.5
      const overdue = now - lastRun > threshold
      if (overdue && !job.staleSince) {
        job.staleSince = new Date().toISOString()
        const expectedMin = Math.round(job.expectedIntervalMs / 60_000)
        console.error(
          `[cron-health] STALE: ${job.name} last ran ${job.lastStarted ?? 'never'} ` +
          `(expected every ${expectedMin}m, threshold ${Math.round(threshold / 60_000)}m)`
        )
      } else if (!overdue && job.staleSince) {
        // Recovered -- clear stale flag
        job.staleSince = null
      }
    }
  }

  getAll(): CronJobHealth[] {
    return [...this.jobs.values()]
  }

  // Returns false if any job is in error state or overdue.
  isHealthy(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === 'error') return false
      if (job.staleSince) return false
    }
    return true
  }
}

// Module-level singleton -- import this everywhere instead of creating instances.
export const cronHealth = new CronHealthTracker()
