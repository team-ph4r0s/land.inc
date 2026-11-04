import { readFileSync, writeFileSync } from 'node:fs';
const version = process.env.RELEASE_VERSION ?? process.argv[2];
if (!/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/.test(version ?? '')) throw new Error('Версия должна иметь формат x.y, например 1.1');
const old = readFileSync('VERSION', 'utf8').trim().split('.').map(Number);
const next = version.split('.').map(Number);
if (next[0] < old[0] || (next[0] === old[0] && next[1] < old[1])) throw new Error('Нельзя выпустить более старую версию');
writeFileSync('VERSION', version + '\n');
for (const file of ['package.json', 'package-lock.json']) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  value.version = version + '.0';
  if (value.packages?.['']) value.packages[''].version = version + '.0';
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
