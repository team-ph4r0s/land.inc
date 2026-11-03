import { DAEMON_PORT, type ClientMessage, type ServerMessage } from '@land/protocol';

const URL = import.meta.env.VITE_DAEMON_URL ?? `ws://127.0.0.1:${DAEMON_PORT}`;

/** WebSocket to land-daemon with automatic reconnect. Returns a sender for client commands. */
export function connect(onMessage: (m: ServerMessage) => void, onStatus: (online: boolean) => void): (m: ClientMessage) => boolean {
  let delay = 500;
  let ws: WebSocket;
  const open = () => {
    ws = new WebSocket(URL);
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
  return (m) => {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(m));
    return true;
  };
}
