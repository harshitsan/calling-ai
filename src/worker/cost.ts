export interface CostInputs {
  durationS: number;
  ttsChars: number;
  sttMinutes?: number; // billed STT minutes (0 when STT runs in the browser)
  llmTokens?: number;
}

// Published / estimated Workers AI rates (USD).
const RATE = {
  ttsPer1kChars: 0.015, // Deepgram Aura
  sttPerMinWs: 0.0092, // Deepgram Flux/Nova-3 over WebSocket
  llmPer1kTokens: 0.0001, // rough Llama-on-Workers-AI estimate
};

export function estimateCallCost(i: CostInputs): number {
  const tts = (i.ttsChars / 1000) * RATE.ttsPer1kChars;
  const stt = (i.sttMinutes ?? 0) * RATE.sttPerMinWs;
  const llm = ((i.llmTokens ?? 0) / 1000) * RATE.llmPer1kTokens;
  return Math.round((tts + stt + llm) * 1e6) / 1e6;
}
