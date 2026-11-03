// A stand-in for `claude` in tests: no model, no network, no cost.
// It reads the prompt from stdin like `claude -p` and answers with what it was given,
// so tests can check the real command line the board built.
//
// Behaviour is chosen by markers in the prompt:
//   [fail]        exit 1 with an error on stderr
//   [signed-out]  print Claude's sign-in error and exit 1
//   [sleep]       stay alive (until killed), for cancel tests
//   [child]       start a sleeping grandchild first, like a CLI starting a shell
// `claude auth status` prints {"loggedIn": true} unless FAKE_SIGNED_OUT=1.

import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status') {
  console.log(JSON.stringify({ loggedIn: process.env.FAKE_SIGNED_OUT !== '1', authMethod: 'fake' }));
  process.exit(0);
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
// FAKE_DELAY_MS makes the answer take a while, so a UI can show the run in progress.
process.stdin.on('end', () => setTimeout(answer, Number(process.env.FAKE_DELAY_MS ?? 0)));
function answer() {
  if (prompt.includes('[child]')) spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  if (prompt.includes('[sleep]')) return setTimeout(() => {}, 60_000);
  if (prompt.includes('[signed-out]')) {
    console.log('Not logged in · Please run /login');
    process.exit(1);
  }
  if (prompt.includes('[fail]')) {
    console.error('fake claude: boom');
    process.exit(1);
  }
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  console.log(`fake claude answer
ARGS ${JSON.stringify({ model: flag('--model'), mode: flag('--permission-mode'), effort: flag('--effort'), session: flag('--session-id'), print: args.includes('-p') })}
PROMPT_CHARS ${prompt.length}

## Коллеге
Сообщение от claude (${flag('--permission-mode')})`);
}
