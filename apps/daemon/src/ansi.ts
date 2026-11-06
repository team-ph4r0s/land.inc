import { stripVTControlCharacters } from 'node:util';
import type { RunResult } from './executors/types.ts';

export const stripAnsi = stripVTControlCharacters;

export function cliFailure(cli: string, ...output: (string | undefined)[]): RunResult | undefined {
  const text = output.filter(Boolean).map((value) => stripAnsi(value!)).join('\n');
  if (/\b(?:not logged in|not authenticated|unauthenticated|authentication (?:failed|required)|unauthorized|invalid (?:api key|token)|(?:token|session|credentials?) (?:has |have )?expired|please (?:run |use )?(?:\/login|log ?in|sign in)|401 Unauthorized|logged out|sign in to view)\b/i.test(text))
    return { ok: false, signedOut: true, text: 'CLI не авторизован: сессия авторизации истекла — выполните ' + cli + ' login' };
  if (/\b(?:rate[_ -]?limit(?:ed| exceeded)?|too many requests|resource[_ -]exhausted|quota (?:exceeded|exhausted)|usage limit|(?:http|status(?: code)?)\s*[:=]?\s*429)\b/i.test(text))
    return { ok: false, text: 'Исчерпан лимит запросов' };
  return undefined;
}
