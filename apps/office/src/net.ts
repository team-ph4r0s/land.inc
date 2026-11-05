import { assertServerMessage, DAEMON_PORT, type ClientMessage, type ServerMessage } from '@land/protocol';

const URL = import.meta.env.VITE_DAEMON_URL ?? `ws://127.0.0.1:${DAEMON_PORT}`;
const HTTP_URL = URL.replace(/^ws/, 'http');

/** WebSocket to land-daemon with automatic reconnect. Returns a sender for client commands. */
export function connect(onMessage: (m: ServerMessage) => void, onStatus: (online: boolean) => void): (m: ClientMessage) => boolean {
  let delay = 500;
  let ws: WebSocket | undefined;
  let token = import.meta.env.VITE_LAND_TOKEN ?? '';
  const open = () => {
    const connectSocket = () => {
      const target = new URL(URL);
      if (token) target.searchParams.set('token', token);
      ws = new WebSocket(target);
      ws.onopen = () => {
        delay = 500;
        onStatus(true);
      };
      ws.onmessage = (e) => {
        const message = assertServerMessage(JSON.parse(e.data));
        if (message.type === 'security.session') token = message.token;
        onMessage(message);
      };
      ws.onclose = () => {
        onStatus(false);
        setTimeout(open, delay);
        delay = Math.min(delay * 2, 5000);
      };
    };
    if (token) return connectSocket();
    void fetch(`${HTTP_URL}/health`, { headers: token ? { 'X-Land-Token': token } : undefined }).then((response) => response.ok ? response.json() as Promise<{ token?: string }> : Promise.reject(new Error('daemon unavailable')))
      .then((health) => { token = health.token ?? ''; connectSocket(); })
      .catch(() => connectSocket());
  };
  open();
  return (m) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };
}
