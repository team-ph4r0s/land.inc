import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelOption, Task } from '@land/protocol';
import { locateCli, probeCommand } from './locator.ts';
import type { Command, Executor, ExecutorStatus, OutputParser, PreparedRun } from './types.ts';

/** Official Antigravity CLI (`agy`), separate from the desktop editor launcher. */
export class AntigravityExecutor implements Executor {
  readonly id = 'antigravity' as const;
  private options: { command?: Command; models?: ModelOption[] };
  constructor(options: { command?: Command; models?: ModelOption[] } = {}) { this.options = options; }

  command(): Command | undefined {
    if (this.options.command) return this.options.command;
    const installed = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe') : join(homedir(), '.local', 'bin', 'agy');
    const candidate = locateCli('agy', '@antigravity-ai/cli', installed).find((entry) => probeCommand(entry.command).ok);
    const bin = candidate?.command.command;
    // Node cannot spawn a Windows batch wrapper directly without a shell.
    return bin && !/\.(cmd|bat)$/i.test(bin) ? candidate?.command ?? { command: bin, args: [] } : undefined;
  }

  status(): ExecutorStatus {
    const command = this.command();
    if (!command) return { available: false, models: [], note: 'Antigravity CLI (agy) не найден. Установите официальный CLI и войдите в аккаунт.' };
    if (this.options.models) return { available: true, models: this.options.models };
    try {
      const output = execFileSync(command.command, [...command.args, 'models'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
      const models = output.split(/\r?\n/).flatMap((line): ModelOption[] => {
        const m = line.trim().match(/^([a-z0-9][a-z0-9._-]+)(?:\t+| {2,})(.+)$/i);
        return m ? [{ id: m[1], label: m[2].trim(), efforts: ['low', 'medium', 'high'] }] : [];
      });
      return models.length ? { available: true, models } : { available: true, models: ANTIGRAVITY_FALLBACK_MODELS, note: 'CLI не вернул список моделей, используются безопасные пресеты.' };
    } catch {
      return { available: true, models: ANTIGRAVITY_FALLBACK_MODELS, note: 'Не удалось получить модели Antigravity CLI, используются безопасные пресеты.' };
    }
  }

  sessionOf(agentId: string): string | undefined {
    return agentId.match(/^antigravity:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  }

  prepare(task: Task, onAgent: (id: string) => void, resume?: string): PreparedRun {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', task.access === 'read' ? 'plan' : 'accept-edits', '--model', task.model];
    if (task.effort) args.push('--effort', task.effort);
    if (task.mcpConfigPath) args.push('--mcp-config', task.mcpConfigPath);
    if (resume) args.push('--conversation', resume);
    return {
      args,
      agentId: resume ? `antigravity:${resume}` : undefined,
      stdin: JSON.stringify({ event: 'user', message: { content: task.systemPrompt ? `${task.systemPrompt}\n\n${task.prompt}` : task.prompt } }) + '\n',
      output: events(onAgent),
    };
  }
}

const ANTIGRAVITY_FALLBACK_MODELS: ModelOption[] = [
  { id: 'agy-default', label: 'Antigravity Default', efforts: ['low', 'medium', 'high'] },
];

function events(onAgent: (id: string) => void): OutputParser {
  let pending = '';
  let id: string | undefined;
  let result: { status?: string; response?: string; error?: string } | undefined;
  const feed = (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      let event: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        event = parsed as Record<string, unknown>;
      } catch { continue; }
      const nested = event.result && typeof event.result === 'object' && !Array.isArray(event.result) ? event.result as Record<string, unknown> : undefined;
      const candidate = event.conversation_id ?? nested?.conversation_id;
      if (!id && typeof candidate === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
        id = candidate;
        onAgent(`antigravity:${id}`);
      }
      if (event.event === 'result' && nested) result = nested as typeof result;
    }
  };
  return {
    onStdout: feed,
    last: () => result?.response,
    finish(code, _stdout, stderr) {
      feed('\n');
      if (code === 0 && result?.status === 'SUCCESS' && typeof result.response === 'string') return { ok: true, text: result.response };
      return { ok: false, text: result?.error || stderr.trim().slice(-2000) || `Antigravity не вернул успешный результат (код ${code})` };
    },
  };
}
