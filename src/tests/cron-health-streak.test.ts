// Cron health: one blip is not an outage (2026-07-31).
//
// THE INCIDENT. `isHealthy()` returned false for any job with `status === 'error'`, and that status
// only cleared on the job's next SUCCESS. The thoughtform detector runs once a day at 03:00. So a
// single transient `fetch failed` -- roughly 30 seconds of network trouble, every other cron healthy,
// the service answering queries perfectly -- pinned Second Brain at degraded/503 for a FULL 24 HOURS,
// and the suite health check dutifully paged Raziel about it every 12 hours.
//
// An alarm that fires for a day over a blip teaches you to ignore the alarm. Then it is worth less
// than no alarm. The failure still has to be VISIBLE (it is, in the body) -- it just must not declare
// the whole service down on its own.

import { describe, it, expect, beforeEach } from "vitest";
import { cronHealth, ERROR_STREAK_FOR_UNHEALTHY } from "../ingestion/cron-health.js";

const JOB = "test_job";
const DAILY = 24 * 60 * 60 * 1000;

describe("cron health streak", () => {
  beforeEach(() => {
    // The tracker is a module singleton; re-registering resets this job's state.
    cronHealth.register(JOB, DAILY);
  });

  it("REPRODUCES the incident's shape: one failure must NOT declare the service down", () => {
    cronHealth.start(JOB);
    cronHealth.fail(JOB, "fetch failed");
    expect(cronHealth.isHealthy()).toBe(true);
  });

  it("but the failure stays fully visible, so it is still diagnosable", () => {
    cronHealth.start(JOB);
    cronHealth.fail(JOB, "fetch failed");
    const job = cronHealth.getAll().find(j => j.name === JOB)!;
    expect(job.status).toBe("error");
    expect(job.lastError).toBe("fetch failed");
    expect(job.lastErrorAt).toBeTruthy();
    expect(job.consecutiveFailures).toBe(1);
  });

  it("two failures in a row IS a condition and does declare it down", () => {
    for (let i = 0; i < ERROR_STREAK_FOR_UNHEALTHY; i++) {
      cronHealth.start(JOB);
      cronHealth.fail(JOB, "fetch failed");
    }
    expect(cronHealth.isHealthy()).toBe(false);
  });

  it("a success ends the streak -- the path back to healthy that the old code lacked", () => {
    cronHealth.start(JOB); cronHealth.fail(JOB, "fetch failed");
    cronHealth.start(JOB); cronHealth.fail(JOB, "fetch failed");
    expect(cronHealth.isHealthy()).toBe(false);
    cronHealth.start(JOB); cronHealth.complete(JOB);
    expect(cronHealth.isHealthy()).toBe(true);
    const job = cronHealth.getAll().find(j => j.name === JOB)!;
    expect(job.consecutiveFailures).toBe(0);
    expect(job.lastError).toBeNull();
    expect(job.lastErrorAt).toBeNull();
  });

  it("alternating fail/succeed never trips it -- that is a flaky dependency, not an outage", () => {
    for (let i = 0; i < 6; i++) {
      cronHealth.start(JOB); cronHealth.fail(JOB, "blip");
      expect(cronHealth.isHealthy()).toBe(true);
      cronHealth.start(JOB); cronHealth.complete(JOB);
    }
    expect(cronHealth.isHealthy()).toBe(true);
  });

  it("STALENESS still trips it immediately -- a job that never runs is never noise", () => {
    // This is the case that must NOT be loosened. A single failure is ambiguous; a cron that stopped
    // firing is an outage whether or not its last attempt happened to succeed.
    cronHealth.register("stale_job", 1); // 1ms interval -> instantly overdue
    cronHealth.start("stale_job");
    cronHealth.complete("stale_job");
    // Wait past 1.5x the interval, then check.
    const until = Date.now() + 20;
    while (Date.now() < until) { /* spin briefly; interval is 1ms */ }
    cronHealth.checkStale();
    expect(cronHealth.isHealthy()).toBe(false);
    const job = cronHealth.getAll().find(j => j.name === "stale_job")!;
    expect(job.staleSince).toBeTruthy();
  });
});
