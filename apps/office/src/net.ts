import { DAEMON_PORT, type ServerMessage } from '@land/protocol';

const URL = import.meta.env.VITE_DAEMON_URL ?? `ws://127.0.0.1:${DAEMON_PORT}`;

/** WebSocket to land-daemon with automatic reconnect. */
export function connect(onMessage: (m: ServerMessage) => void, onStatus: (online: boolean) => void): void {
  let delay = 500;
  const open = () => {
    const ws = new WebSocket(URL);
    ws.onopen = () => {
      delay = 500;
      onStatus(true);
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      onStatus(false);
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
  };
  open();
}
