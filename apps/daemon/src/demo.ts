import type { Activity } from '@land/protocol';
import type { Store } from './store.ts';

const CAST = [
  { id: 'demo:1', title: 'Рефакторинг авторизации', project: 'api-server', model: 'claude-opus-5-5', effort: 'high' },
  { id: 'demo:2', title: 'Лендинг для релиза', project: 'website', model: 'claude-sonnet-5-5' },
  { id: 'demo:3', title: 'Починить флейки тесты', project: 'api-server', model: 'gpt-6.1-terra', effort: 'medium' },
  { id: 'demo:4', title: 'Миграция БД', project: 'billing', model: 'gpt-6.1-sol', effort: 'xhigh' },
  { id: 'demo:5', title: 'Ресёрч конкурентов', project: 'website', model: 'claude-haiku-5-5' },
  { id: 'demo:6', title: 'Сказка для онбординга', project: 'website', model: 'claude-fable-5-1' },
  { id: 'demo:7', title: 'Ночной прогон', project: 'billing', model: 'gpt-6-luna', effort: 'low' },
  { id: 'demo:8', title: 'Поиск по логам', project: 'api-server', model: 'gpt-6-astra' },
].map((c) => ({ ...c, source: 'demo' as const }));

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
    if (activity === 'bash' && Math.random() < 0.5) {
      // A test run that ends green or red after a few seconds.
      store.tool(c.id, 'Bash', 'bash', 'npm test', now, true);
      setTimeout(() => store.toolDone(c.id, Date.now(), Math.random() < 0.7), 4_000);
    }
    if (activity === 'talk') {
      const sub = `${c.id}:sub${++n}`;
      const reviewer = Math.random() < 0.5;
      store.update(sub, {
        source: 'demo',
        parentId: c.id,
        title: reviewer ? 'Auto Review' : 'Сабагент: проверка типов',
        model: reviewer ? 'codex-auto-review' : c.model,
        role: reviewer ? 'reviewer' : 'worker',
        project: c.project,
        cwd: '',
      });
      store.tool(sub, 'Demo', 'read', 'Читает tsconfig.json', now);
      setTimeout(() => store.tool(sub, 'Demo', 'bash', 'tsc --noEmit', Date.now()), 6_000);
      setTimeout(() => store.remove(sub), 14_000);
    }
  }, 2_500).unref();
}
