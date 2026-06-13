// EmotionalRAG (arXiv 2410.23041) retrieves on emotion proximity, not just topic. We approximate
// their separate "emotion embedding" with a fixed 2-D affect map (valence x arousal, each in [-1,1])
// keyed off the emotion LABEL we already store at ingest (embeddings.valence). This adds the arousal
// axis without a DB column and needs no re-ingest. Resonance is graded by distance and scaled to
// <= weight so it stays an additive nudge that reorders recall, never a gate.

type Coord = readonly [valence: number, arousal: number];

// Plutchik-ish layout. Keys are lowercased emotion labels (and common synonyms) our feelings layer
// emits. Unknown labels resonate with nothing (boost 0) -- safe by construction.
const EMOTION_COORDS: Record<string, Coord> = {
  joy: [0.8, 0.5], happy: [0.8, 0.5], happiness: [0.8, 0.5], delight: [0.85, 0.6],
  serenity: [0.6, -0.4], calm: [0.5, -0.6], peace: [0.6, -0.6], content: [0.6, -0.2], contentment: [0.6, -0.2],
  love: [0.9, 0.3], tender: [0.7, -0.1], tenderness: [0.7, -0.1], affection: [0.75, 0.2], warm: [0.7, 0.0], warmth: [0.7, 0.0],
  trust: [0.6, -0.1], safety: [0.55, -0.4], secure: [0.55, -0.4],
  excitement: [0.7, 0.85], anticipation: [0.4, 0.6], eager: [0.5, 0.7], hope: [0.5, 0.3],
  surprise: [0.1, 0.8], awe: [0.4, 0.7],
  curiosity: [0.4, 0.4], interest: [0.4, 0.3],
  pride: [0.6, 0.4], gratitude: [0.7, 0.1],
  neutral: [0.0, 0.0],
  boredom: [-0.3, -0.6], bored: [-0.3, -0.6], fatigue: [-0.2, -0.7], tired: [-0.2, -0.7],
  sadness: [-0.7, -0.4], sad: [-0.7, -0.4], grief: [-0.85, -0.3], sorrow: [-0.8, -0.3], melancholy: [-0.5, -0.4],
  loneliness: [-0.6, -0.2], lonely: [-0.6, -0.2],
  fear: [-0.7, 0.7], afraid: [-0.7, 0.7], anxiety: [-0.6, 0.6], anxious: [-0.6, 0.6], dread: [-0.7, 0.5], worry: [-0.5, 0.4],
  anger: [-0.7, 0.75], angry: [-0.7, 0.75], rage: [-0.85, 0.85], frustration: [-0.5, 0.6], frustrated: [-0.5, 0.6], irritation: [-0.4, 0.4],
  disgust: [-0.6, 0.3], shame: [-0.7, 0.0], guilt: [-0.6, 0.1],
  overwhelm: [-0.5, 0.7], overwhelmed: [-0.5, 0.7], stress: [-0.5, 0.6], stressed: [-0.5, 0.6],
};

// Max possible distance in this box is sqrt(2^2 + 2^2) = 2*sqrt(2). Normalize against it.
const MAX_DIST = 2 * Math.SQRT2;

function lookup(label: string | null | undefined): Coord | null {
  if (!label) return null;
  return EMOTION_COORDS[label.trim().toLowerCase()] ?? null;
}

/**
 * Graded affect resonance between a chunk's encoded emotion and the caller's current mood.
 * Returns a value in [0, weight]: weight at identical affect, decaying to ~0 for opposite affect,
 * exactly 0 when either label is unknown/null. Additive nudge only.
 */
export function emotionResonance(
  chunkValence: string | null | undefined,
  mood: string | null | undefined,
  weight: number,
): number {
  const a = lookup(chunkValence);
  const b = lookup(mood);
  if (!a || !b || weight <= 0) return 0;
  const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
  const linear = Math.max(0, 1 - dist / MAX_DIST); // 1 at same point, 0 at far corner
  // Square the falloff so resonance concentrates near genuine affect matches: near-neighbours keep a
  // real boost, opposite emotions decay to ~0. Monotonic, so it preserves nearer-ranks-higher order.
  return weight * linear * linear;
}

export const __test = { EMOTION_COORDS, MAX_DIST, lookup };
