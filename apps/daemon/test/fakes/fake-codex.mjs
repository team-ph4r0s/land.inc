// A stand-in for `codex exec --json` in tests: no model, no network, no cost.
// It reads the prompt from stdin (the `-` argument) and prints Codex-style JSONL events:
// thread.started, an intermediate and a final agent message, turn.completed.
//
// Behaviour is chosen by markers in the prompt:
//   [fail]         exit 1 with an error on stderr
//   [turn-failed]  report turn.failed and exit 1
//   [sleep]        stay alive (until killed), for cancel tests
//   [child]        start a sleeping grandchild first, like a CLI starting a shell

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const configs = args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
// FAKE_DELAY_MS makes the answer take a while, so a UI can show the run in progress.
process.stdin.on('end', () => setTimeout(answer, Number(process.env.FAKE_DELAY_MS ?? 0)));
function answer() {
  emit({ type: 'thread.started', thread_id: randomUUID() });
  if (prompt.includes('[child]')) spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  if (prompt.includes('[sleep]')) return setTimeout(() => {}, 60_000);
  if (prompt.includes('[fail]')) {
    console.error('fake codex: boom');
    process.exit(1);
  }
  if (prompt.includes('[turn-failed]')) {
    emit({ type: 'turn.failed', error: { message: 'fake codex: model refused' } });
    process.exit(1);
  }
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'Смотрю проект…' } });
  const answer = `fake codex answer
ARGS ${JSON.stringify({ exec: args[0], json: args.includes('--json'), sandbox: flag('--sandbox'), cd: flag('-C'), model: flag('-m'), configs, stdin: args.at(-1) === '-' })}
PROMPT_CHARS ${prompt.length}

## Коллеге
Сообщение от codex (${flag('--sandbox')})`;
  emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
  // The last line has no newline on purpose: the parser must still read it.
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: {} }));
}
