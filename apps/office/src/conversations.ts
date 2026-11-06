import type { ConversationMeta, Task } from '@land/protocol';

export const isLive = (t: Task): boolean => ['starting', 'running', 'cancelling'].includes(t.status);

export interface ConversationThread {
  id: string;
  title?: string;
  pinned?: boolean;
  turns: Task[];
}

/** Group by explicit continuation links, never by provider, title or folder. */
export function conversations(tasks: Task[], metaList: ConversationMeta[] = []): ConversationThread[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const metaMap = new Map(metaList.map((m) => [m.id, m]));
  const groups = new Map<string, Task[]>();

  for (const task of tasks) {
    let root = task;
    const seen = new Set<string>();
    while (root.continues && byId.has(root.continues) && !seen.has(root.id)) {
      seen.add(root.id);
      root = byId.get(root.continues)!;
    }
    // Even when an old parent has expired from retention, siblings stay together.
    const id = root.continues && !byId.has(root.continues) ? root.continues : root.id;
    groups.set(id, [...(groups.get(id) ?? []), task]);
  }

  const threads: ConversationThread[] = [...groups].map(([id, turns]) => {
    const meta = metaMap.get(id);
    return {
      id,
      title: meta?.title,
      pinned: meta?.pinned ?? false,
      turns: turns.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    };
  });

  // Pinned at the top, then by latest turn time
  return threads.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aTime = a.turns.at(-1)?.createdAt ?? 0;
    const bTime = b.turns.at(-1)?.createdAt ?? 0;
    return bTime - aTime;
  });
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Small, escaped Markdown subset. Raw HTML from an agent is always text. */
export function messageHtml(text: string): string {
  return text
    .split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g)
    .map((part) => {
      if (part.startsWith('```')) {
        return `<pre><code>${escape(part.replace(/^```[^\n]*\n/, '').replace(/```$/, ''))}</code></pre>`;
      }
      return escape(part)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6} (.+)$/gm, '<strong class="message-heading">$1</strong>');
    })
    .join('');
}

/** Export entire conversation history as single Markdown string */
export function exportConversationToMarkdown(thread: ConversationThread): string {
  const root = thread.turns[0];
  const title = thread.title || root?.prompt.slice(0, 60).replace(/\n/g, ' ') || 'Без названия';
  let md = `# Разговор: ${title}\n\n`;
  md += `- **ID:** \`${thread.id}\`\n`;
  md += `- **Проект:** \`${root?.cwd ?? 'unknown'}\`\n`;
  md += `- **Создан:** ${new Date(root?.createdAt ?? Date.now()).toLocaleString()}\n`;
  md += `- **Количество ходов:** ${thread.turns.length}\n\n`;
  md += `---\n\n`;

  for (let i = 0; i < thread.turns.length; i++) {
    const t = thread.turns[i];
    md += `## Ход ${i + 1} (${t.executor.toUpperCase()} · ${t.model}${t.effort ? ` · ${t.effort}` : ''})\n`;
    md += `*Статус:* \`${t.status}\` | *Доступ:* \`${t.access}\` | *Время:* ${new Date(t.createdAt).toLocaleTimeString()}\n\n`;
    md += `### Пользователь:\n\n${t.prompt}\n\n`;

    if (t.result) {
      md += `### Исполнитель (${t.executor}):\n\n${t.result}\n\n`;
    } else if (t.status === 'running' || t.status === 'starting') {
      md += `*(Задача в процессе выполнения...)*\n\n`;
    }

    md += `---\n\n`;
  }

  return md;
}
