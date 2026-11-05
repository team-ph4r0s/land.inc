export interface ContextBudgetState { used: number; budget: number; remaining: number; ratio: number; }

export function estimateTokens(text: string): number { return Math.ceil(text.length / 4); }

export function profileContext(text: string, budget: number): ContextBudgetState {
  const safeBudget = Math.max(1, Math.floor(budget));
  const used = estimateTokens(text);
  return { used, budget: safeBudget, remaining: Math.max(0, safeBudget - used), ratio: used / safeBudget };
}

/** Deterministic local fallback for strategic-compact when the MCP is unavailable. */
export function strategicCompact(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.max(200, Math.floor(maxChars * 0.35));
  const tail = Math.max(200, maxChars - head - 80);
  return `${text.slice(0, head)}\n\n[СЖАТО strategic-compact: середина доступна в артефакте]\n\n${text.slice(-tail)}`;
}
