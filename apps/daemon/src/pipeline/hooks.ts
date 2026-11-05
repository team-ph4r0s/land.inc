import { profileContext, strategicCompact } from './context.ts';
import { containsPromptInjection, redactSecrets } from '../security/shield.ts';

export interface PreIterationResult { prompt: string; context: ReturnType<typeof profileContext>; documents: string[]; }
export interface PostIterationResult { text: string; compacted: string; context: ReturnType<typeof profileContext>; }

export function preIteration(prompt: string, budget = 8_000): PreIterationResult {
  const safe = redactSecrets(prompt);
  if (containsPromptInjection(safe)) throw new Error('Входной промпт заблокирован agentic-shield');
  const documents = [...safe.matchAll(/(?:^|\s)([^\s]+\.(?:docx|pdf|xlsx|epub|html))(?:\s|$)/gi)].map((match) => match[1]);
  return { prompt: safe, context: profileContext(safe, budget), documents };
}

export function postIteration(text: string, budget = 8_000): PostIterationResult {
  const safe = redactSecrets(text);
  return { text: safe, compacted: strategicCompact(safe, budget * 4), context: profileContext(safe, budget) };
}
