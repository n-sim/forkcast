// Hands a generated file (a recipe or shopping-list PDF) to the person: either
// saved where they choose, or shared to another app through the platform's
// share sheet. Sharing is detected here and nowhere else, so journeys can stub
// it: in a browser through `navigator.canShare`/`navigator.share` (Web Share
// with files), in the installed app through the host's `share_file` command,
// which only Android implements.

import { hostStatus, isNative, saveFile } from './core';

export interface GeneratedFile {
  name: string;
  bytes: Uint8Array;
  type: string;
  /** Shown by the share sheet and used as the message subject. */
  title: string;
}

/**
 * - `shared`: the receiving app accepted the file (Web Share).
 * - `opened`: the share sheet is open; the platform does not report the outcome (Android).
 * - `cancelled`: the person dismissed the share sheet.
 * - `needs-gesture`: the browser refused because preparing the file took too long
 *   after the tap; the same file can be shared on the next tap.
 */
export type ShareOutcome = 'shared' | 'opened' | 'cancelled' | 'needs-gesture';

function asFile(
  file: Pick<GeneratedFile, 'name' | 'type'> & { bytes?: Uint8Array },
) {
  return new File(
    [(file.bytes ?? new Uint8Array()).slice().buffer],
    file.name,
    {
      type: file.type,
    },
  );
}

let nativeShare: Promise<boolean> | undefined;

/** Whether this platform can share a file of `type` to other apps. */
export async function canShareFiles(
  type = 'application/pdf',
): Promise<boolean> {
  if (isNative) {
    nativeShare ??= hostStatus()
      .then((status) => status.platform === 'android')
      .catch(() => false);
    return nativeShare;
  }
  try {
    return (
      typeof navigator.share === 'function' &&
      typeof navigator.canShare === 'function' &&
      navigator.canShare({ files: [asFile({ name: 'forkcast.pdf', type })] })
    );
  } catch {
    return false;
  }
}

/** Opens the share sheet with `file` attached. */
export async function shareGeneratedFile(
  file: GeneratedFile,
): Promise<ShareOutcome> {
  if (isNative) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('share_file', {
      suggestedName: file.name,
      data: Array.from(file.bytes),
      title: file.title,
    });
    return 'opened';
  }
  try {
    await navigator.share({ files: [asFile(file)], title: file.title });
    return 'shared';
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      return 'cancelled';
    // Web Share needs a recent tap; generating a large PDF can outlast it.
    if (error instanceof DOMException && error.name === 'NotAllowedError')
      return 'needs-gesture';
    throw error;
  }
}

/** Saves `file` as before sharing existed: a save dialog in the app, a download in a browser. False when cancelled. */
export async function saveGeneratedFile(file: GeneratedFile): Promise<boolean> {
  return (await saveFile(file.name, file.bytes, file.type)) !== null;
}
