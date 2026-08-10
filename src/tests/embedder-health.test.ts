// src/tests/embedder-health.test.ts
//
// THE OUTAGE THAT NOTHING ALERTED ON.
//
// The OpenAI credit balance reached zero on 2026-07-31 and nobody found out until 2026-08-10, because every
// consumer handled it gracefully and silently: search degraded to lexical (correct, by design) and Discord
// ingest 500'd per message (a bug, fixed separately). The failure was in the logs the entire time and in no
// alarm anywhere. The lesson from [fail-open-hides-a-dead-mechanism]: a fail-open path looks identical working
// or dead, so it must ASSERT THE REASON rather than merely counting failures.
//
// There is no usable OpenAI balance endpoint, so this cannot mirror the DeepSeek balance check added 2026-08-07.
// The signal is the embedder's own last outcome, classified by the PROVIDER'S error code -- because a 429 is
// either a standing quota wall that needs a human and money, or a transient speed bump that needs nothing.
// Alerting on those identically is how a real outage gets filed as noise.

import { describe, it, expect } from "vitest";
import { classifyEmbedderError } from "../embeddings/openai-embedder.js";

describe("classifyEmbedderError -- distinguish 'add money' from 'retry later'", () => {
  // The literal body returned during the 2026-07-31..08-10 outage.
  it("classifies the real outage body as a quota wall, not a rate limit", () => {
    expect(classifyEmbedderError(
      'OpenAI embeddings error: 429 Too Many Requests — {"error":{"message":"You have no credits remaining. ' +
      'Add credits to continue using the API.","type":"insufficient_quota","code":"credit_balance_exhausted"}}',
    )).toBe("quota");
  });

  // Same HTTP status, completely different operational meaning. This is the whole point of the function:
  // keying on the status alone would have filed the nine-day outage as a transient blip.
  it("classifies a bare 429 with no quota language as a rate limit", () => {
    expect(classifyEmbedderError("OpenAI embeddings error: 429 Too Many Requests — Rate limit reached")).toBe("rate_limit");
  });

  it("classifies a bad key as auth, which no amount of waiting or money fixes", () => {
    expect(classifyEmbedderError("OpenAI embeddings error: 401 Unauthorized — invalid_api_key")).toBe("auth");
  });

  it("classifies network and timeout failures as transient", () => {
    expect(classifyEmbedderError("OpenAI embeddings fetch failed: The operation was aborted due to timeout")).toBe("transient");
    expect(classifyEmbedderError("OpenAI embeddings fetch failed: ECONNRESET")).toBe("transient");
  });

  it("treats an explicit billing message as quota even without a 429", () => {
    expect(classifyEmbedderError("OpenAI embeddings error: 400 — billing hard limit reached")).toBe("quota");
  });

  it("never returns null -- an unrecognised failure is still a failure", () => {
    expect(classifyEmbedderError("something entirely unexpected")).toBe("transient");
  });
});
