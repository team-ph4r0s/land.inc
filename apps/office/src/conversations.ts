import type { Task } from '@land/protocol';

export const isLive = (t: Task): boolean => ['starting', 'running', 'cancelling'].includes(t.status);

/** Group by explicit continuation links, never by provider, title or folder. */
export function conversations(tasks: Task[]): { id: string; turns: Task[] }[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
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
  return [...groups].map(([id, turns]) => ({ id, turns: turns.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)) }))
    .sort((a, b) => b.turns.at(-1)!.createdAt - a.turns.at(-1)!.createdAt);
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Small, escaped Markdown subset. Raw HTML from an agent is always text. */
export function messageHtml(text: string): string {
  return text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/g).map((part) => {
    if (part.startsWith('```')) return `<pre><code>${escape(part.replace(/^```[^\n]*\n/, '').replace(/```$/, ''))}</code></pre>`;
    return escape(part).replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^#{1,6} (.+)$/gm, '<strong class="message-heading">$1</strong>');
  }).join('');
}
