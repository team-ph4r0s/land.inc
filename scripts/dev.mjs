// Starts the daemon and the office client together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const demo = process.argv.includes('--demo');
const run = (args) => spawn('npm', args, { stdio: 'inherit', shell: true });
const procs = [
  run(['run', demo ? 'demo' : 'start', '-w', '@land/daemon']),
  run(['run', 'dev', '-w', '@land/office']),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', stop);
