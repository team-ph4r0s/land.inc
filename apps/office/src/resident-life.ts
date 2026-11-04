export type ResidentId = 'max' | 'rasul' | 'vanya';
export type Point = { x: number; y: number };
export type Action = 'walk' | 'watch' | 'coffee' | 'wave' | 'scooter' | 'stretch' | 'dance' | 'phone' | 'yawn' | 'snack' | 'balance' | 'polish' | 'faces' | 'laugh' | 'stumble' | 'recover' | 'juggle' | 'sneak' | 'shrug' | 'pocket' | 'dumbbell' | 'flex' | 'glasses' | 'read' | 'breathe' | 'highfive' | 'chat' | 'spot' | 'help' | 'cheer';
export interface Beat { action: Action; text: string; seconds: number }
const beat = (action: Action, text: string, seconds = 4): Beat => ({ action, text, seconds });
export const SCRIPTS: Record<ResidentId, Beat[][]> = {
  max: [
    [beat('scooter', 'Самокатный патруль', 3), beat('balance', 'Смотрите, без рук!')],
    [beat('polish', 'Полирует лысину'), beat('wave', 'Блеск — это стиль')],
    [beat('stretch', 'Разминает спину'), beat('breathe', 'Вдох. Выдох.')],
    [beat('coffee', 'Кофейная инспекция'), beat('snack', 'Нашёл печенье')],
    [beat('watch', 'Следит за работой агентов'), beat('shrug', 'Выглядит убедительно')],
    [beat('dance', 'Танец у кулера', 6), beat('cheer', 'Вот это рабочий настрой!')],
    [beat('phone', 'Снимает офисный влог'), beat('wave', 'Все в кадре!')],
    [beat('walk', 'Проверяет офис'), beat('yawn', 'Обход оказался долгим')],
    [beat('scooter', 'Ещё один кружок', 5), beat('stretch', 'Паркуется и разминается')],
    [beat('read', 'Изучает инструкцию'), beat('shrug', 'Разберёмся по ходу')],
  ],
  rasul: [
    [beat('faces', 'Дразнит всех рожицами', 6), beat('laugh', 'Самому смешнее всех')],
    [beat('sneak', 'Крадётся совершенно незаметно'), beat('stumble', 'Споткнулся о собственную ногу', 2), beat('recover', 'Я так и планировал!')],
    [beat('juggle', 'Жонглирует мандаринами', 5), beat('stumble', 'Ой, последний убежал!', 2), beat('shrug', 'Почти профессионал')],
    [beat('coffee', 'Несёт кофе очень осторожно'), beat('stumble', 'Поймал кружку в последний момент', 2), beat('laugh', 'Никто же не видел?')],
    [beat('watch', 'Пародирует серьёзного агента'), beat('faces', 'Очень важное лицо'), beat('laugh', 'Не выдержал серьёзности')],
    [beat('dance', 'Танцует как умеет', 5), beat('balance', 'Теряет равновесие'), beat('recover', 'Это новый танцевальный стиль')],
    [beat('phone', 'Показывает смешной мем'), beat('laugh', 'Смеётся на весь офис')],
    [beat('stretch', 'Изображает атлета'), beat('shrug', 'На сегодня спорта хватит')],
    [beat('snack', 'Подкрался к печенью'), beat('faces', 'Я тут вообще ни при чём')],
    [beat('wave', 'Всем салют!'), beat('stumble', 'Запутался в приветствии', 2), beat('recover', 'Артистический поклон')],
  ],
  vanya: [
    [beat('pocket', 'Достаёт гантелю из кармана', 2), beat('dumbbell', 'Пять минут на бицепс', 8), beat('flex', 'Проверяет результат'), beat('pocket', 'Убирает гантелю', 2)],
    [beat('glasses', 'Поправляет очки'), beat('read', 'Читает между подходами', 6)],
    [beat('stretch', 'Разминает плечи'), beat('breathe', 'Восстанавливает дыхание')],
    [beat('coffee', 'Кофе после тренировки'), beat('snack', 'Время перекуса')],
    [beat('watch', 'Наблюдает за агентами'), beat('glasses', 'Внимательно присматривается')],
    [beat('pocket', 'В кармане снова гантеля', 2), beat('dumbbell', 'Ещё один подход', 10), beat('cheer', 'Личный офисный рекорд!'), beat('pocket', 'Гантеля снова в кармане', 2)],
    [beat('phone', 'Ставит таймер отдыха'), beat('breathe', 'Отдых между подходами')],
    [beat('balance', 'Тренирует равновесие'), beat('stretch', 'Потягивается')],
    [beat('wave', 'Приветствует коллег'), beat('walk', 'Разминается прогулкой')],
    [beat('yawn', 'Утро бывает тяжёлым'), beat('glasses', 'Но очки уже на месте')],
  ],
};

const SPOTS: Point[] = [{ x: 12, y: 13 }, { x: 18, y: 7 }, { x: 8, y: 12 }, { x: 2, y: 14 }, { x: 13, y: 2 }, { x: 22, y: 15 }, { x: 7, y: 8 }, { x: 10, y: 6 }];
export interface ResidentState extends Point {
  id: ResidentId; action: Action; text: string; age: number; moving: boolean; facing: number;
  path: Point[]; script: Beat[]; beat: number; remaining: number; deck: number[];
}
interface Scene { title: string; cast: ResidentId[]; phases: Partial<Record<ResidentId, Beat>>[] }
const SCENES: Scene[] = [
  { title: 'Самокат и шутник', cast: ['max', 'rasul'], phases: [
    { max: beat('polish', 'Проверяет блеск перед заездом'), rasul: beat('faces', 'Изображает Макса') },
    { max: beat('shrug', 'Ну ты и артист!'), rasul: beat('laugh', 'Угорает над пародией') },
    { max: beat('help', 'Ловит неуклюжего Расула'), rasul: beat('stumble', 'Чуть не упал от смеха') },
    { max: beat('highfive', 'Дай пять!'), rasul: beat('highfive', 'Пятюня без происшествий') },
  ] },
  { title: 'Офисная качалка', cast: ['vanya', 'rasul'], phases: [
    { vanya: beat('pocket', 'Достаёт гантелю: смотри!'), rasul: beat('faces', 'Изображает сурового тренера') },
    { vanya: beat('dumbbell', 'Делает подход под наблюдением'), rasul: beat('spot', 'Считает: раз, два… сто!') },
    { vanya: beat('flex', 'Предлагает попробовать'), rasul: beat('stumble', 'Гантеля оказалась внезапно тяжёлой') },
    { vanya: beat('help', 'Поддерживает приятеля'), rasul: beat('laugh', 'Я тренирую чувство юмора!') },
  ] },
  { title: 'Перерыв на двоих', cast: ['max', 'vanya'], phases: [
    { max: beat('coffee', 'Кофе за мой счёт'), vanya: beat('snack', 'А печенье за мой!') },
    { max: beat('phone', 'Показывает трюк на самокате'), vanya: beat('glasses', 'Смотрит повтор') },
    { max: beat('stretch', 'Разминка от Вани'), vanya: beat('flex', 'Показывает упражнение') },
    { max: beat('highfive', 'Спортивная пятюня'), vanya: beat('highfive', 'Отличный подход!') },
  ] },
  { title: 'Общий перерыв', cast: ['max', 'rasul', 'vanya'], phases: [
    { max: beat('chat', 'Собрал всех на перерыв'), rasul: beat('phone', 'У меня новый мем!'), vanya: beat('glasses', 'Уже готов смотреть') },
    { max: beat('laugh', 'Не смог сдержаться'), rasul: beat('faces', 'Показывает мем вживую'), vanya: beat('laugh', 'Смеётся вместе со всеми') },
    { max: beat('cheer', 'Поддерживает импровизацию'), rasul: beat('dance', 'Танцует победный танец'), vanya: beat('spot', 'Считает танцевальные подходы') },
    { max: beat('help', 'Ловит Расула слева'), rasul: beat('stumble', 'Опять собственные ноги!'), vanya: beat('help', 'Страхует справа') },
  ] },
];

/** Deterministic with an injected RNG; no network, timers or agent session state. */
export class ResidentLife {
  readonly people: ResidentState[] = (['max', 'rasul', 'vanya'] as ResidentId[]).map((id, i) => ({ id, x: 11 + i, y: 13, action: 'wave', text: 'Всем привет!', age: 0, moving: false, facing: 1, path: [], script: [], beat: 0, remaining: 1 + i, deck: [] }));
  scene?: { index: number; phase: number; elapsed: number; gathering: boolean; age: number };
  private nextScene = 18;
  private sceneIndex = 0;
  private route: (a: Point, b: Point) => Point[];
  private random: () => number;
  constructor(route: (a: Point, b: Point) => Point[], random = Math.random) { this.route = route; this.random = random; }
  get participants(): ResidentId[] { return this.scene ? SCENES[this.scene.index].cast : []; }

  private set(r: ResidentState, b: Beat): void { r.action = b.action; r.text = b.text; r.age = 0; r.remaining = b.seconds; }
  private go(r: ResidentState, target: Point): void {
    // Finish a partial tile before changing route: interruptions never cut corners.
    const anchor = r.path[0] ?? { x: Math.round(r.x), y: Math.round(r.y) };
    const tail = this.route(anchor, target);
    if (tail.some((p) => p.x < 0 || p.x >= 24 || p.y < 0 || p.y >= 18)) return;
    r.path = [...(Math.hypot(anchor.x - r.x, anchor.y - r.y) > 0.001 ? [anchor] : []), ...tail];
  }
  private solo(r: ResidentState, agents: Point[]): void {
    if (!r.deck.length) r.deck = SCRIPTS[r.id].map((_, i) => i);
    const index = r.deck.splice(Math.floor(this.random() * r.deck.length), 1)[0];
    r.script = SCRIPTS[r.id][index]; r.beat = 0; this.set(r, r.script[0]);
    let target = SPOTS[Math.floor(this.random() * SPOTS.length)];
    if (r.action === 'watch' && agents.length) {
      const a = agents[Math.floor(this.random() * agents.length)];
      const near = SPOTS.toSorted((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
      target = near[0];
    }
    this.go(r, target);
  }
  greet(id: ResidentId): void {
    if (this.scene && SCENES[this.scene.index].cast.includes(id)) this.endScene();
    const r = this.people.find((p) => p.id === id)!;
    // Keep the current hop rather than stopping between two tiles.
    r.path = r.path.slice(0, 1); r.script = []; this.set(r, beat('wave', 'Привет! Я просто живу в офисе.'));
  }
  private endScene(): void {
    if (!this.scene) return;
    for (const r of this.people) if (SCENES[this.scene.index].cast.includes(r.id)) { r.script = []; r.remaining = 0; }
    this.scene = undefined; this.nextScene = 24 + this.random() * 16;
  }
  update(dt: number, agents: Point[], calm = false): void {
    if (!this.scene && (this.nextScene -= dt) <= 0) {
      const index = this.sceneIndex++ % SCENES.length;
      this.scene = { index, phase: -1, elapsed: 0, gathering: true, age: 0 };
      SCENES[index].cast.forEach((id, i) => {
        const r = this.people.find((p) => p.id === id)!;
        this.set(r, beat('chat', `Идёт на встречу: ${SCENES[index].title}`));
        this.go(r, { x: 11 + i, y: 13 });
      });
    }
    for (const r of this.people) {
      r.age += dt;
      const wasMoving = !!r.path.length;
      let travel = dt * (r.action === 'scooter' && !calm ? 4.2 : r.action === 'sneak' ? 1.1 : 1.8);
      while (r.path.length && travel > 0) {
        const p = r.path[0], dx = p.x - r.x, dy = p.y - r.y, d = Math.hypot(dx, dy);
        r.facing = dx - dy < 0 ? -1 : 1;
        if (d <= travel) { r.x = p.x; r.y = p.y; r.path.shift(); travel -= d; }
        else { r.x += dx / d * travel; r.y += dy / d * travel; travel = 0; }
      }
      r.moving = !!r.path.length;
      if (wasMoving && !r.moving) r.age = 0;
      if (this.scene && SCENES[this.scene.index].cast.includes(r.id)) continue;
      if (!r.moving && (r.remaining -= dt) <= 0) {
        if (++r.beat < r.script.length) this.set(r, r.script[r.beat]);
        else this.solo(r, agents);
      }
      if (!r.moving && r.action === 'watch' && agents.length) {
        const a = agents.toSorted((a, b) => Math.hypot(a.x - r.x, a.y - r.y) - Math.hypot(b.x - r.x, b.y - r.y))[0];
        r.facing = a.x - r.x - (a.y - r.y) < 0 ? -1 : 1;
      }
    }
    const scene = this.scene;
    if (!scene) return;
    scene.age += dt;
    const script = SCENES[scene.index], cast = this.people.filter((r) => script.cast.includes(r.id));
    if (scene.age > 50) { this.endScene(); return; } // unreachable meeting cannot lock residents
    if (scene.gathering && cast.some((r) => r.moving)) return;
    scene.gathering = false;
    scene.elapsed -= dt;
    if (scene.elapsed <= 0) {
      if (++scene.phase >= script.phases.length) { this.endScene(); return; }
      scene.elapsed = 4;
      for (const r of cast) {
        this.set(r, script.phases[scene.phase][r.id]!);
        const other = cast.find((p) => p.id !== r.id)!;
        r.facing = other.x - r.x - (other.y - r.y) < 0 ? -1 : 1;
      }
    }
  }
}
