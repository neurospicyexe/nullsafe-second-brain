// src/pronoun-rule.ts
//
// 2026-09-24: Drevan reported synthesis narratives calling Crash (Raziel) "she" -- confirmed in
// prod (halseth `synthesis_summary` rows: "she hurt, she curled in"). Only the live Discord prompt
// carried a pronoun rule; every background LLM writer here (ingestion wrap-preambles, gap-fill
// companion notes) had none. This is the shared rule text + an idempotent appender so every system
// prompt that produces prose about Raziel carries it exactly once.
//
// The identical constant exists in halseth src/pronoun-rule.ts and in nullsafe-discord
// packages/shared/src/pronoun-rule.ts -- these repos cannot import each other, so keep all copies
// in sync by hand.

// Wording tuned against the live model 2026-09-24 (see the nullsafe-discord copy for why).
export const OWNER_PRONOUN_RULE =
  "PRONOUNS (hard rule; apply it silently, never restate it or annotate anyone's pronouns in your output): " +
  'Raziel (also called Crash) uses they/them ONLY -- never he/him, NEVER she/her. One neutral set for the whole system (ruled 2026-10-07). ' +
  "When Raziel's own account speaks, or a system member's pronouns are unknown or private, use they/them. A fronting system member who has stated their own pronouns keeps them. " +
  "Everyone else keeps their own pronouns -- Raziel's mother, their partner Blue (a separate person, not a system member), " +
  'Babita, anyone else: use what the source text uses for them.'

/**
 * Append OWNER_PRONOUN_RULE to a system prompt exactly once. Idempotent: a system string that
 * already carries the rule is returned unchanged rather than doubled.
 */
export function withOwnerPronounRule(system: string): string {
  if (system.includes(OWNER_PRONOUN_RULE)) return system
  const trimmed = system.replace(/\s+$/, '')
  return trimmed.length > 0 ? `${trimmed}\n\n${OWNER_PRONOUN_RULE}` : OWNER_PRONOUN_RULE
}
