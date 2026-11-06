import { execFileSync } from 'node:child_process';
import type { ModelOption, Task } from '@land/protocol';
import { findAgy } from './files.ts';
import { cliFailure, stripAnsi } from '../ansi.ts';
import { record } from '../json-store.ts';
import { parseAgyModels } from '../model-catalog.ts';
import type { Command, Executor, ExecutorStatus, OutputParser, PreparedRun } from './types.ts';

/** Official Antigravity CLI (`agy`), separate from the desktop editor launcher. */
export class AntigravityExecutor implements Executor {
  readonly id = 'antigravity' as const;
  private options: { command?: Command; models?: ModelOption[]; pathOverride?: () => string | undefined };
  private found?: Command | null;
  constructor(options: { command?: Command; models?: ModelOption[]; pathOverride?: () => string | undefined } = {}) { this.options = options; }

  refresh(): void { this.found = undefined; }

  command(): Command | undefined {
    if (this.options.command) return this.options.command;
    if (this.found !== undefined) return this.found ?? undefined;
    this.found = findAgy(this.options.pathOverride?.()) ?? null;
    return this.found ?? undefined;
  }

  status(catalogModels?: ModelOption[]): ExecutorStatus {
    const command = this.command();
    if (!command) return { available: false, models: [], note: 'Antigravity CLI (agy) не найден. Установите официальный CLI и войдите в аккаунт.' };
    if (catalogModels || this.options.models) return { available: true, models: catalogModels ?? this.options.models! };
    try {
      const output = execFileSync(command.command, [...command.args, 'models'], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 2000 });
      const models = parseAgyModels(output).map(({ id, label, efforts }) => ({ id, label, efforts }));
      return models.length ? { available: true, models } : { available: false, models: [], note: 'Не удалось получить список моделей Antigravity CLI. Проверьте вход в agy.' };
    } catch {
      return { available: false, models: [], note: 'Не удалось получить модели Antigravity CLI. Проверьте вход в agy.' };
    }
  }

  sessionOf(agentId: string): string | undefined {
    return agentId.match(/^antigravity:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  }

  prepare(task: Task, onAgent: (id: string) => void, resume?: string, captureLimit = 200_000): PreparedRun {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', task.access === 'read' ? 'plan' : 'accept-edits', '--model', task.model];
    if (task.effort) args.push('--effort', task.effort);
    if (resume) args.push('--conversation', resume);
    return {
      args,
      agentId: resume ? `antigravity:${resume}` : undefined,
      stdin: JSON.stringify({ event: 'user', message: { content: task.prompt } }) + '\n',
      output: events(onAgent, captureLimit),
    };
  }
}

function events(onAgent: (id: string) => void, captureLimit: number): OutputParser {
  let pending = '';
  let id: string | undefined;
  let result: Record<string, unknown> | undefined;
  let partial = '';
  const feed = (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = (lines.pop() ?? '').slice(-Math.max(8_000_000, captureLimit * 6));
    for (const line of lines) {
      let event: Record<string, unknown> | undefined;
      try { event = record(JSON.parse(stripAnsi(line))); } catch { continue; }
      if (!event) continue;
      const payload = record(event.result);
      const step = record(event.step_update);
      const candidate = event.conversation_id ?? payload?.conversation_id ?? step?.conversation_id;
      if (!id && typeof candidate === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
        id = candidate;
        onAgent(`antigravity:${id}`);
      }
      if (event.event === 'result') result = payload;
      if (event.event === 'step_update' && step?.step_type === 'agent_response' && typeof step.text_delta === 'string')
        partial = (partial + step.text_delta).slice(-captureLimit);
    }
  };
  return {
    onStdout: feed,
    last: () => stripAnsi((typeof result?.response === 'string' && result.response) || partial).trim() || undefined,
    finish(code, _stdout, stderr) {
      feed('\n');
      if (code === 0 && result?.status === 'SUCCESS' && typeof result.response === 'string') return { ok: true, text: stripAnsi(result.response) };
      const error = typeof result?.error === 'string' ? result.error : undefined;
      return cliFailure('agy', error, stderr, _stdout) ?? { ok: false, text: stripAnsi(error ?? stderr).trim().slice(-2000) || `Antigravity не вернул успешный результат (код ${code})` };
    },
  };
}
