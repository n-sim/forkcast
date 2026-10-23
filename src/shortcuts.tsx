import { useEffect, useRef } from 'react';

// Shortcuts are single unmodified keys that activate a visible control
// carrying the same key in `aria-keyshortcuts`. Each operation therefore stays
// one ordinary button or link for pointer and touch, and a shortcut never
// reaches a control that is disabled, hidden, or absent from the current page.

export const shortcutGroups: {
  name: string;
  shortcuts: { keys: string[]; label: string; description: string }[];
}[] = [
  {
    name: 'Anywhere',
    shortcuts: [
      { keys: ['1'], label: '1', description: 'Recipe collection' },
      { keys: ['2'], label: '2', description: 'Meal plan' },
      { keys: ['3'], label: '3', description: 'Food log' },
      { keys: ['4'], label: '4', description: 'Shopping list' },
      { keys: ['5'], label: '5', description: 'Settings' },
      { keys: ['?'], label: '?', description: 'Show keyboard shortcuts' },
    ],
  },
  {
    name: 'Recipe collection',
    shortcuts: [
      { keys: ['N'], label: 'N', description: 'New recipe' },
      { keys: ['G'], label: 'G', description: 'Generate recipe' },
    ],
  },
  {
    name: 'Meal plan',
    shortcuts: [
      { keys: ['P'], label: 'P', description: 'Plan cooking' },
      { keys: ['ArrowLeft'], label: '←', description: 'Previous week' },
      { keys: ['ArrowRight'], label: '→', description: 'Next week' },
    ],
  },
  {
    name: 'Food log',
    shortcuts: [
      { keys: ['M'], label: 'M', description: 'Add manual entry' },
      { keys: ['R'], label: 'R', description: 'Log recipe portions' },
    ],
  },
  {
    name: 'Guided cooking',
    shortcuts: [
      { keys: ['ArrowRight'], label: '→', description: 'Next step' },
      { keys: ['ArrowLeft'], label: '←', description: 'Back step' },
    ],
  },
];

const known = new Set(
  shortcutGroups.flatMap((group) =>
    group.shortcuts.flatMap((shortcut) => shortcut.keys),
  ),
);

function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"]',
    ),
  );
}

function shortcutKey(event: KeyboardEvent) {
  // Modified keys belong to the browser and operating system (copy, reload,
  // tab switching, AltGr characters); held keys must not repeat an action.
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return null;
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  // Shift only counts where it produces the character itself, such as `?`.
  if (event.shiftKey && /^[A-Z0-9]$|^Arrow/.test(key)) return null;
  return known.has(key) ? key : null;
}

function visible(element: Element) {
  return (
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== 'hidden'
  );
}

/** Activates the visible control for an unmodified key outside text entry. */
export function useKeyboardShortcuts() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = shortcutKey(event);
      if (!key || isEditable(event.target)) return;
      // An open modal dialog owns the keyboard until it closes.
      if (document.querySelector('dialog[open]')) return;
      const control = [
        ...document.querySelectorAll<HTMLElement>('[aria-keyshortcuts]'),
      ].find(
        (element) =>
          element.getAttribute('aria-keyshortcuts')!.split(' ').includes(key) &&
          visible(element),
      );
      if (
        !control ||
        control.matches(':disabled, [aria-disabled="true"], [aria-busy="true"]')
      )
        return;
      event.preventDefault();
      control.click();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}

export function KeyboardShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="keyboard-shortcuts-title"
      className="shortcuts-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <h2 id="keyboard-shortcuts-title">Keyboard shortcuts</h2>
      <p>
        Press a key while you are not typing in a field. Everything stays
        available with pointer and touch.
      </p>
      {shortcutGroups.map((group) => (
        <section key={group.name} aria-label={`${group.name} shortcuts`}>
          <h3>{group.name}</h3>
          <dl className="shortcut-list">
            {group.shortcuts.map((shortcut) => (
              <div key={shortcut.description}>
                <dt>
                  <kbd>{shortcut.label}</kbd>
                </dt>
                <dd>{shortcut.description}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <div className="form-actions">
        <button className="button primary" autoFocus onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}
