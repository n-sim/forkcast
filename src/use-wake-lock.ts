import { useEffect } from 'react';

/**
 * Keeps the screen on while `active` is true, through the Screen Wake Lock
 * API. Browsers release the lock when the page is hidden, so it is requested
 * again whenever the page becomes visible. Where the API is missing or the
 * request is refused, nothing happens.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    const wakeLock = navigator.wakeLock;
    if (!active || !wakeLock) return;
    let released = false;
    let sentinel: WakeLockSentinel | null = null;
    let pending = false;

    async function acquire() {
      if (released || pending || sentinel || document.hidden) return;
      pending = true;
      try {
        const lock = await wakeLock.request('screen');
        if (released) {
          void lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      } catch {
        // Unsupported here, refused, or the page was hidden meanwhile.
      } finally {
        pending = false;
      }
    }

    function onVisibilityChange() {
      if (!document.hidden) void acquire();
    }

    void acquire();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      void sentinel?.release().catch(() => {});
      sentinel = null;
    };
  }, [active]);
}
