export interface CostInputs {
  durationS: number;
  ttsChars: number;
  voiceId?: string; // determines the TTS rate
  sttMinutes?: number; // billed STT minutes (0 when STT runs in the browser)
  llmTokens?: number;
}

// Deepgram TTS rates (USD per 1000 characters).
const TTS_RATE_PER_1K: Record<string, number> = {
  aura1: 0.015,
  aura2: 0.03,
};
const RATE = {
  sttPerMinWs: 0.0092, // Deepgram Flux/Nova-3 over WebSocket
  llmPer1kTokens: 0.0001, // rough Llama-on-Workers-AI estimate
};

function ttsRatePer1kChars(voiceId?: string): number {
  if (!voiceId) return TTS_RATE_PER_1K.aura1!;
  if (voiceId.startsWith('aura2en:') || voiceId.startsWith('aura2es:')) return TTS_RATE_PER_1K.aura2!;
  return TTS_RATE_PER_1K.aura1!;
}

export function estimateCallCost(i: CostInputs): number {
  const tts = (i.ttsChars / 1000) * ttsRatePer1kChars(i.voiceId);
  const stt = (i.sttMinutes ?? 0) * RATE.sttPerMinWs;
  const llm = ((i.llmTokens ?? 0) / 1000) * RATE.llmPer1kTokens;
  return Math.round((tts + stt + llm) * 1e6) / 1e6;
}
