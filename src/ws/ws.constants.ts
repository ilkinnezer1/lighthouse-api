export const deploymentRoom = (id: string) => `deploy:${id}`;
export const userRoom = (id: string) => `user:${id}`;
export const logsStreamKey = (id: string) => `deploy:${id}:logs`;

export const WS_EVENT_LOG = 'log';
export const WS_EVENT_SUBSCRIBE = 'subscribe';
export const WS_EVENT_UNSUBSCRIBE = 'unsubscribe';

// Interactive terminal (`/exec` namespace). Client → server: start a shell,
// feed keystrokes, resize, stop. Server → client: ready, raw pty output, exit.
export const WS_EXEC_NAMESPACE = '/exec';
export const WS_EXEC_START = 'exec:start';
export const WS_EXEC_INPUT = 'exec:input';
export const WS_EXEC_RESIZE = 'exec:resize';
export const WS_EXEC_STOP = 'exec:stop';
export const WS_EXEC_READY = 'exec:ready';
export const WS_EXEC_OUTPUT = 'exec:output';
export const WS_EXEC_EXIT = 'exec:exit';
export const WS_EXEC_ERROR = 'exec:error';

// In-app inbox (`/notifications` namespace). Server → client only: the room is
// the authenticated user, known at handshake, so there is nothing to subscribe to.
export const WS_NOTIFICATIONS_NAMESPACE = '/notifications';
export const WS_EVENT_NOTIFICATION_CREATED = 'notification.created';

// Short enough to react to abort; long enough to not pound Redis.
export const XREAD_BLOCK_MS = 5000;
