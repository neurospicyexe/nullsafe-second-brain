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

export const OWNER_PRONOUN_RULE =
  'PRONOUNS (hard rule): Raziel (also called Crash) uses he/him or they/them -- NEVER she/her. ' +
  "The same default applies to Raziel's system members (alters/headmates) unless a member has " +
  'explicitly stated otherwise. Everyone else keeps their own pronouns (Raziel\'s mother, Blue, ' +
  'Babita, anyone else): use what the source text uses for them.'

/**
 * Append OWNER_PRONOUN_RULE to a system prompt exactly once. Idempotent: a system string that
 * already carries the rule is returned unchanged rather than doubled.
 */
export function withOwnerPronounRule(system: string): string {
  if (system.includes(OWNER_PRONOUN_RULE)) return system
  const trimmed = system.replace(/\s+$/, '')
  return trimmed.length > 0 ? `${trimmed}\n\n${OWNER_PRONOUN_RULE}` : OWNER_PRONOUN_RULE
}
