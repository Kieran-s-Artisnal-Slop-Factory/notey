/**
 * The page's half of the service worker's offline-copy protocol.
 *
 * The worker downloads the whole build by itself on the first visit; this is
 * only how Settings can say whether that finished, and how someone who is
 * about to get on a plane can make it finish NOW rather than whenever the
 * worker next wakes up.
 *
 * Nothing here can be answered by the page on its own: `precache.json` is
 * the worker's list and the caches are the worker's caches, so every answer
 * is a round trip. `null` means there is no worker to ask — the dev server,
 * the desktop build, or a browser with service workers switched off — and
 * callers show nothing rather than an error.
 *
 * Browser-only (`navigator.serviceWorker`); the protocol is exercised by the
 * Playwright suite against a production build, where the worker actually
 * runs.
 */

export interface OfflineStatus {
  /** Every file the build emitted is in the cache. */
  ready: boolean;
  /** How many are not, of `total`. */
  missing: number;
  total: number;
}

/** Long enough for a slow disk, short enough not to hang the panel. */
const REPLY_TIMEOUT_MS = 20_000;

type Reply = { type: string } & Record<string, unknown>;

/**
 * Send one request and wait for the reply that answers it.
 *
 * `postMessage` has no request/response pairing, so the listener stays up
 * until a message of the expected type arrives — and is always removed,
 * including on the timeout, or a panel opened and closed repeatedly would
 * leave a listener behind each time.
 */
function ask(action: string, want: string, onProgress?: (done: number, total: number) => void) {
  const controller = navigator.serviceWorker?.controller;
  if (!controller) return Promise.resolve(null);
  return new Promise<Reply | null>((resolve) => {
    const finish = (value: Reply | null) => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), REPLY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Reply | undefined;
      if (!data || typeof data.type !== 'string') return;
      if (data.type === 'notey-offline-progress') {
        onProgress?.(Number(data.done), Number(data.total));
        return;
      }
      if (data.type === want) finish(data);
      else if (data.type === 'notey-offline-error') finish(null);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    controller.postMessage({ type: 'notey-offline', action });
  });
}

/** How much of the build is cached, or `null` when there is no worker. */
export async function offlineStatus(): Promise<OfflineStatus | null> {
  const reply = await ask('status', 'notey-offline-status');
  if (!reply) return null;
  return {
    ready: Boolean(reply.ready),
    missing: Number(reply.missing) || 0,
    total: Number(reply.total) || 0,
  };
}

/**
 * Download whatever is still missing, now.
 *
 * Resolves true only when the cache is complete afterwards; a run that hit
 * an unreachable file resolves false, and the worker will try again.
 */
export async function downloadOffline(
  onProgress?: (done: number, total: number) => void
): Promise<boolean> {
  const reply = await ask('download', 'notey-offline-done', onProgress);
  return Boolean(reply?.complete);
}

/** One line for a person: what the status means, not what it contains. */
export function describeOffline(status: OfflineStatus): string {
  if (status.ready) return `Ready to work offline — all ${status.total} files are here.`;
  if (status.total === 0) return 'Working out what this copy needs…';
  return `${status.missing} of ${status.total} files still to download.`;
}
