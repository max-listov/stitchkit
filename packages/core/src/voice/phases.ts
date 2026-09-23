/** The phases of a live voice conversation, one vocabulary for every side of it. */
export const LIVE_VOICE_PHASES = [
  'opening',
  'idle',
  'hearing',
  'thinking',
  'speaking',
] as const;
export type LiveVoicePhase = (typeof LIVE_VOICE_PHASES)[number];
