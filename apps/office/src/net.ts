import { DAEMON_PORT, type ClientMessage, type ServerMessage } from '@land/protocol';

const WS_BASE_URL = import.meta.env.VITE_DAEMON_URL ?? `ws://127.0.0.1:${DAEMON_PORT}`;

/** Derive HTTP base URL from WebSocket URL to fetch auth token if available. */
function getHttpBaseUrl(wsUrl: string): string {
  if (wsUrl.startsWith('ws://')) return wsUrl.replace('ws://', 'http://');
  if (wsUrl.startsWith('wss://')) return wsUrl.replace('wss://', 'https://');
  return `http://127.0.0.1:${DAEMON_PORT}`;
}

async function fetchDaemonToken(httpBase: string): Promise<string | null> {
  try {
    const res = await fetch(`${httpBase}/token`, { cache: 'no-store' });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { token?: unknown };
      if (typeof json === 'string') return json;
      if (json && typeof json.token === 'string') return json.token;
    } catch {
      // not JSON; use raw string
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** WebSocket to land-daemon with automatic reconnect and /token auth handling. */
export function connect(
  onMessage: (m: ServerMessage) => void,
  onStatus: (online: boolean) => void,
): (m: ClientMessage) => boolean {
  let delay = 500;
  let ws: WebSocket | null = null;
  let isConnecting = false;

  const open = async () => {
    if (isConnecting) return;
    isConnecting = true;

    const httpBase = getHttpBaseUrl(WS_BASE_URL);
    const token = await fetchDaemonToken(httpBase);

    let targetUrl = WS_BASE_URL;
    if (token) {
      const sep = targetUrl.includes('?') ? '&' : '?';
      targetUrl = `${targetUrl}${sep}token=${encodeURIComponent(token)}`;
    }

    ws = new WebSocket(targetUrl);
    isConnecting = false;

    ws.onopen = () => {
      delay = 500;
      onStatus(true);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as ServerMessage;
        onMessage(data);
      } catch {
        // invalid message ignored
      }
    };

    ws.onclose = () => {
      onStatus(false);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };

    ws.onerror = () => {
      // close event will trigger reconnect
    };
  };

  void open();

  return (m: ClientMessage) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };
}
