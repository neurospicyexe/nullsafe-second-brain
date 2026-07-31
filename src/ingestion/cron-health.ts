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
  /** Consecutive failures. One is noise; a streak is a condition. See ERROR_STREAK_FOR_UNHEALTHY. */
  consecutiveFailures: number
  lastErrorAt: string | null
  /** Last time the job actually SUCCEEDED. Staleness keys on this, not on lastStarted -- see checkStale. */
  lastSuccessAt: string | null
  staleSince: string | null
  expectedIntervalMs: number
}

/**
 * How many failures IN A ROW make the service unhealthy.
 *
 * 2, not 1, and this is a fix rather than a loosening (2026-07-31). `isHealthy()` returned false for
 * any job in `status === 'error'`, and that status only cleared on the job's next SUCCESS. The
 * thoughtform detector runs once a day at 03:00. So a single transient `fetch failed` -- a ~30 second
 * network blip, with every other cron healthy and the service answering queries perfectly -- pinned
 * Second Brain at `degraded`/503 for a FULL 24 HOURS, and the suite health check faithfully paged
 * Raziel about it every 12 hours.
 *
 * That is the cry-wolf failure: an alarm that fires for a day over a blip teaches you to ignore the
 * alarm, and then it is worth less than no alarm at all. Same family as the rails-need-decay lesson --
 * a latched state with no path back to normal except a once-daily event.
 *
 * A single failure stays FULLY VISIBLE in the /health body (status 'error', lastError, lastErrorAt) so
 * it is diagnosable; it just does not declare the whole service down. Two in a row does, and genuine
 * staleness (the job not running at all) still does immediately -- a dead cron is never noise.
 */
export const ERROR_STREAK_FOR_UNHEALTHY = 2

class CronHealthTracker {
  private jobs = new Map<string, CronJobHealth>()

  register(name: string, expectedIntervalMs: number): void {
    this.jobs.set(name, {
      name,
      status: 'never',
      lastStarted: null,
      lastCompleted: null,
      lastError: null,
      consecutiveFailures: 0,
      lastErrorAt: null,
      lastSuccessAt: null,
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
    // A success ends the streak. This is the only path back to healthy, which is exactly why a
    // single failure must not have declared the service down for a daily job's whole interval.
    job.consecutiveFailures = 0
    job.lastErrorAt = null
    job.lastSuccessAt = job.lastCompleted
  }

  fail(name: string, error: string): void {
    const job = this.jobs.get(name)
    if (!job) return
    job.status = 'error'
    job.lastError = error.slice(0, 500)
    job.lastCompleted = new Date().toISOString()
    job.consecutiveFailures += 1
    job.lastErrorAt = new Date().toISOString()
  }

  // Call periodically or on /health request. Logs STALE warnings to stderr.
  checkStale(): void {
    const now = Date.now()
    for (const job of this.jobs.values()) {
      if (job.status === 'never' || job.status === 'running') continue
      // Keys on last SUCCESS, not last START (2026-07-31, review finding). A job that runs and FAILS
      // still updates lastStarted, so staleness could never trip for it -- leaving the consecutive-failure
      // streak as the only detector, and that streak lives in memory and is reset to 0 by register() on
      // every boot. A deploy or OOM between two daily failures therefore let a permanently broken 03:00
      // job dodge the threshold forever: neither detector could ever fire.
      //
      // Anchoring to success closes it without persistence: a job that has not SUCCEEDED within 1.5x its
      // interval is stale regardless of how many times it has started, or how many restarts have happened.
      // A never-yet-succeeded job falls back to lastStarted so a genuinely new registration is not
      // instantly branded stale.
      const anchor = job.lastSuccessAt ?? job.lastStarted
      const lastRun = anchor ? new Date(anchor).getTime() : 0
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

  // Unhealthy when a job has failed ERROR_STREAK_FOR_UNHEALTHY times IN A ROW, or is genuinely stale.
  //
  // A single failure is deliberately NOT unhealthy -- see ERROR_STREAK_FOR_UNHEALTHY for the incident.
  // It remains fully visible in the /health body either way, so nothing is hidden; the difference is
  // whether one blip on a once-daily job gets to declare the entire service down for 24 hours.
  isHealthy(): boolean {
    for (const job of this.jobs.values()) {
      if (job.consecutiveFailures >= ERROR_STREAK_FOR_UNHEALTHY) return false
      // Staleness is never noise: a job that is not running at all is a real outage regardless of
      // whether its last attempt happened to succeed.
      if (job.staleSince) return false
    }
    return true
  }
}

// Module-level singleton -- import this everywhere instead of creating instances.
export const cronHealth = new CronHealthTracker()
