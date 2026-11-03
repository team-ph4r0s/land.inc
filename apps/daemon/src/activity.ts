import { basename } from 'node:path';
import type { Activity } from '@land/protocol';

type Input = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const file = (v: unknown): string => (str(v) ? basename(str(v)) : '');
export const clip = (s: string, n = 60): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

/** Read-only shell commands: the agent is browsing the archive, not running jobs. */
const READ_CMD = /^\s*(cat|type|head|tail|less|ls|dir|tree|find|fd|rg|grep|sed\s+-n|wc|git\s+(log|show|diff|status|blame)|Get-Content|Get-ChildItem|Select-String)\b/i;

export function shellActivity(command: string): Activity {
  return READ_CMD.test(command) ? 'read' : 'bash';
}

/** Commands that run a test suite; their outcome sets the agent's mood. */
const TEST_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+(--[\w-]+\s+)*--test\b|\b(vitest|jest|pytest|mocha|playwright\s+test)\b|\b(cargo|go|dotnet|gradlew?|mvn)\s+test\b/i;

export interface ToolInfo {
  activity: Activity;
  detail: string;
  /** The call runs tests, so its result is worth a reaction. */
  test?: boolean;
}

/** Map a tool call (Claude or Codex naming) to an office activity and a short caption. */
export function describeTool(name: string, input: Input = {}): ToolInfo {
  const info = describe(name, input);
  const raw = input.command ?? input.cmd ?? input.code;
  if (TEST_CMD.test(Array.isArray(raw) ? raw.join(' ') : str(raw))) info.test = true;
  return info;
}

function describe(name: string, input: Input): ToolInfo {
  const n = name;
  switch (true) {
    case /^(Read|NotebookRead)$/.test(n):
      return { activity: 'read', detail: `Читает ${file(input.file_path) || 'файл'}` };
    case /^(Grep|Glob|LS|ToolSearch)$/.test(n):
      return { activity: 'read', detail: `Ищет ${clip(str(input.pattern) || str(input.query), 40)}` };
    case /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(n):
      return { activity: 'write', detail: `Правит ${file(input.file_path) || file(input.notebook_path) || 'файл'}` };
    case n === 'apply_patch':
      return { activity: 'write', detail: 'Применяет патч' };
    case /^(Bash|PowerShell)$/.test(n): {
      const cmd = str(input.command);
      return { activity: shellActivity(cmd), detail: clip(str(input.description) || cmd) };
    }
    case /^(shell|exec_command|local_shell|container\.exec)$/.test(n): {
      const raw = input.command ?? input.cmd;
      const cmd = Array.isArray(raw) ? raw.join(' ') : str(raw);
      const body = cmd.replace(/^(bash|powershell(\.exe)?|pwsh|cmd)\s+(-lc|-c|-Command|\/c)\s+/i, '');
      return { activity: shellActivity(body), detail: clip(body) };
    }
    case n === 'exec' && typeof input.code === 'string':
      return describeCodeMode(input.code as string);
    case /^(wait|sleep)$/.test(n):
      return { activity: 'bash', detail: 'Ждёт завершения команды' };
    case /^(Monitor|BashOutput|KillShell|TaskStop)$/.test(n):
      return { activity: 'bash', detail: 'Следит за процессом' };
    case /^(WebSearch|web_search)$/.test(n):
      return { activity: 'web', detail: `Гуглит «${clip(str(input.query), 40)}»` };
    case n === 'WebFetch':
      return { activity: 'web', detail: `Открывает ${clip(str(input.url), 40)}` };
    case /browser|chrome|playwright|puppeteer/i.test(n):
      return { activity: 'web', detail: 'Работает в браузере' };
    case /^(Agent|Task|spawn_agent)$/.test(n):
      return { activity: 'talk', detail: `Ставит задачу: ${clip(str(input.description) || str(input.message) || 'сабагенту', 40)}` };
    case /^(SendMessage|send_input)$/.test(n):
      return { activity: 'talk', detail: 'Пишет коллеге' };
    case /(TodoWrite|update_plan|ExitPlanMode|EnterPlanMode|Task(Create|Update|List|Get))/.test(n):
      return { activity: 'plan', detail: 'Обновляет план' };
    case /^(AskUserQuestion|request_user_input)$/.test(n):
      return { activity: 'wait', detail: 'Задаёт вам вопрос' };
    case n.startsWith('mcp__'):
      return { activity: 'write', detail: `Инструмент ${clip(n.split('__').pop() ?? n, 30)}` };
    default:
      return { activity: 'write', detail: clip(n, 40) };
  }
}

/**
 * Whether a Claude Code `Notification` hook means the agent is blocked on the user.
 * The same hook also reports idling ("waiting for your input"), logins and the like.
 */
export function needsUser(h: { notification_type?: unknown; message?: unknown }): boolean {
  if (typeof h.notification_type === 'string') return h.notification_type === 'permission_prompt' || h.notification_type === 'elicitation_dialog';
  return /permission|approv/i.test(str(h.message));
}

/**
 * Codex in code mode sends one `exec` tool whose input is JavaScript calling the
 * real tools (`tools.exec_command({cmd: ...})`, `tools.web__run`, `tools.apply_patch`).
 * The first recognisable call says what the agent is doing.
 */
function describeCodeMode(code: string): ToolInfo {
  if (/tools\.apply_patch\s*\(/.test(code)) return { activity: 'write', detail: 'Применяет патч' };
  const cmd = code.match(/\bcmd\s*:\s*"((?:\\.|[^"\\])*)"/) ?? code.match(/\bcmd\s*:\s*'((?:\\.|[^'\\])*)'/);
  if (cmd) {
    const body = cmd[1].replace(/\\(["'\\])/g, '$1');
    return { activity: shellActivity(body), detail: clip(body) };
  }
  if (/tools\.web__run\s*\(/.test(code)) {
    const q = code.match(/"q"\s*:\s*"((?:\\.|[^"\\])*)"|\bq\s*:\s*"((?:\\.|[^"\\])*)"/);
    const query = q?.[1] ?? q?.[2];
    return { activity: 'web', detail: query ? `Гуглит «${clip(query, 40)}»` : 'Ищет в интернете' };
  }
  if (/tools\.mcp__\w+/.test(code)) return { activity: 'web', detail: 'Работает в приложении' };
  return { activity: 'think', detail: 'Размышляет' };
}

/** Did a test run pass, judging by its output? undefined when the output does not say. */
export function testOutcome(text: string): boolean | undefined {
  if (/still running|session id|yield(ed)?\b/i.test(text)) return undefined;
  if (/\b[1-9]\d*\s+(failed|failing|failures?)\b|ℹ fail [1-9]|\bnot ok\b|\bFAILED\b|test result: FAILED|exit(ed with)? code:?\s*[1-9]/i.test(text)) return false;
  // A summary of the whole run: node --test, jest/vitest "Tests: N passed", pytest "N passed", cargo "test result: ok".
  if (/ℹ fail 0\b|\b0 fail(ed|ures?)?\b|Tests?:\s+\d+ passed|=+ \d+ passed|test result: ok\b|\b\d+ passing\b/i.test(text)) return true;
  return undefined;
}
