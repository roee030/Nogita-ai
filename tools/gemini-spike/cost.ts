/**
 * P7-1: dollars for a Gemini Live session from its token counts. Prices per million tokens as third-party price lists
 * gave them on 2026-11-03 for gemini-3.8-live (audio in $3, audio out $12, text in $0.75, text out $4.50); not
 * confirmed on Google's own pricing page, so the report marks the figure as an estimate.
 */
import type { LiveUsage } from './live.ts';

export const GEMINI_LIVE_PRICES = { audioIn: 3, audioOut: 12, textIn: 0.75, textOut: 4.5 };

export function estimateGeminiUsd(usage: LiveUsage, prices = GEMINI_LIVE_PRICES): number {
  const otherIn = Math.max(0, usage.promptTokens - usage.audioPromptTokens - usage.textPromptTokens);
  const otherOut = Math.max(0, usage.responseTokens - usage.audioResponseTokens);
  return (usage.audioPromptTokens * prices.audioIn + (usage.textPromptTokens + otherIn) * prices.textIn +
    usage.audioResponseTokens * prices.audioOut + otherOut * prices.textOut) / 1_000_000;
}
