import { isNative } from './core';

/**
 * Starts a countdown in the device's own clock app, which keeps running and
 * rings while Forkcast is closed or the screen is off. Resolves `true` when the
 * clock app took the timer, and `false` whenever it could not (no system timer
 * on this platform, no clock app, permission denied, any error), so the caller
 * can run the in-app timer instead.
 */
export type SystemTimer = (timer: {
  seconds: number;
  label: string;
}) => Promise<boolean>;

declare global {
  interface Window {
    /** Replaces the platform's system timer, for tests. */
    __forkcastSystemTimer?: SystemTimer;
  }
}

const platformTimer: SystemTimer = async ({ seconds, label }) => {
  // Only the Android app has a system timer; the desktop host reports that it
  // has none, and a browser has no way to reach one.
  if (!isNative) return false;
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('start_system_timer', { seconds, label });
  return true;
};

export async function startSystemTimer(timer: {
  seconds: number;
  label: string;
}): Promise<boolean> {
  try {
    return await (window.__forkcastSystemTimer ?? platformTimer)(timer);
  } catch {
    return false;
  }
}
