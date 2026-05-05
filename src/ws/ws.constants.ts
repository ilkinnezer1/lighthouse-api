export const deploymentRoom = (id: string) => `deploy:${id}`;
export const userRoom = (id: string) => `user:${id}`;
export const logsStreamKey = (id: string) => `deploy:${id}:logs`;

export const WS_EVENT_LOG = 'log';
export const WS_EVENT_SUBSCRIBE = 'subscribe';
export const WS_EVENT_UNSUBSCRIBE = 'unsubscribe';

// Short enough to react to abort; long enough to not pound Redis.
export const XREAD_BLOCK_MS = 5000;
