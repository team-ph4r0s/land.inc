import { fileURLToPath } from 'node:url';
import { ClaudeExecutor } from './executors/claude.ts';
import { CodexExecutor } from './executors/codex.ts';
import type { Executor } from './executors/types.ts';

const fake = (name: string) => fileURLToPath(new URL(`../test/fakes/${name}`, import.meta.url));

export const FAKE_CODEX_MODELS = [
  { id: 'gpt-fake', label: 'GPT Fake', efforts: ['low', 'high'] },
  { id: 'gpt-fake-2', label: 'GPT Fake 2' },
];

/**
 * The real Claude and Codex executors, with only the binary swapped for a fake CLI
 * on node: tests exercise the real command lines and output parsing, but nothing
 * reaches a model, the network or the user's agent history.
 */
export function fakeExecutors(): Executor[] {
  return [
    new ClaudeExecutor({ command: { command: process.execPath, args: [fake('fake-claude.mjs')] } }),
    new CodexExecutor({ command: { command: process.execPath, args: [fake('fake-codex.mjs')] }, models: FAKE_CODEX_MODELS }),
  ];
}
