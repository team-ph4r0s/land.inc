import type { Activity } from '@land/protocol';
import type { Store } from './store.ts';

const CAST = [
  { id: 'demo:1', title: 'Рефакторинг авторизации', project: 'api-server', source: 'demo' as const },
  { id: 'demo:2', title: 'Лендинг для релиза', project: 'website', source: 'demo' as const },
  { id: 'demo:3', title: 'Починить флейки тесты', project: 'api-server', source: 'demo' as const },
  { id: 'demo:4', title: 'Миграция БД', project: 'billing', source: 'demo' as const },
  { id: 'demo:5', title: 'Ресёрч конкурентов', project: 'website', source: 'demo' as const },
];

const STEPS: [Activity, string][] = [
  ['think', 'Размышляет'],
  ['read', 'Читает auth.ts'],
  ['read', 'Ищет «useSession»'],
  ['write', 'Правит login.tsx'],
  ['bash', 'npm test'],
  ['web', 'Гуглит «oauth pkce»'],
  ['plan', 'Обновляет план'],
  ['talk', 'Ставит задачу: проверить типы'],
  ['wait', 'Ждёт разрешения: Bash'],
  ['idle', 'Ждёт следующую задачу'],
];

/** Fake agents that wander through every activity, for working on the office without real sessions. */
export function startDemo(store: Store): void {
  for (const c of CAST) store.update(c.id, { ...c, cwd: `~/dev/${c.project}`, activity: 'think', detail: 'Размышляет' });
  let n = 0;
  setInterval(() => {
    const c = CAST[Math.floor(Math.random() * CAST.length)];
    const [activity, detail] = STEPS[Math.floor(Math.random() * STEPS.length)];
    const now = Date.now();
    if (activity === 'idle') store.turnEnd(c.id, now);
    else if (activity === 'wait') store.waiting(c.id, detail, now);
    else store.tool(c.id, 'Demo', activity, detail, now);
    if (activity === 'talk') {
      const sub = `${c.id}:sub${++n}`;
      store.update(sub, { source: 'demo', parentId: c.id, title: 'Сабагент: проверка типов', project: c.project, cwd: '' });
      store.tool(sub, 'Demo', 'read', 'Читает tsconfig.json', now);
      setTimeout(() => store.tool(sub, 'Demo', 'bash', 'tsc --noEmit', Date.now()), 6_000);
      setTimeout(() => store.remove(sub), 14_000);
    }
  }, 2_500).unref();
}
