if (process.argv.includes('models')) {
  process.stdout.write('Fetching available models...\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n');
  process.exit(0);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const prompt = JSON.parse(input.trim()).message.content;
const id = process.argv.includes('--conversation') ? process.argv[process.argv.indexOf('--conversation') + 1] : '87654321-1234-4234-8234-123456789abc';
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: id }) + '\n');
const result = { conversation_id: id, status: 'SUCCESS', response: JSON.stringify({ args: process.argv.slice(2), prompt }) + '\n## Коллеге\nПроверено' };
process.stdout.write(JSON.stringify({ event: 'result', result }));
