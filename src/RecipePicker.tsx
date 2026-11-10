import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { Recipe } from './domain';

/** Folds case and accents so "creme" finds "Crème brûlée". */
function searchable(text: string) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();
}

/** Recipes whose name contains the query, ignoring case and accents. */
export function matchingRecipes(recipes: Recipe[], query: string) {
  const needle = searchable(query.trim());
  return recipes.filter((recipe) => searchable(recipe.name).includes(needle));
}

/** The smallest list that stays usable; below it the list opens upwards. */
const minimumListHeight = 160;
const maximumListHeight = 288;

/**
 * A type-to-filter recipe combobox following the WAI-ARIA combobox pattern
 * with list autocompletion. Focus stays in the text field; the highlighted
 * option is announced through `aria-activedescendant`.
 */
export function RecipePicker({
  recipes,
  value,
  onChange,
  id,
  autoFocus,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
}: {
  recipes: Recipe[];
  /** The chosen recipe id, or an empty string. */
  value: string;
  onChange: (recipeId: string) => void;
  id: string;
  autoFocus?: boolean;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const listId = useId();
  const sorted = useMemo(
    () => [...recipes].sort((a, b) => a.name.localeCompare(b.name, 'en')),
    [recipes],
  );
  const chosen = sorted.find((recipe) => recipe.id === value);
  // While the person types, the field shows their text instead of the choice.
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<{
    above: boolean;
    maxHeight: number;
  }>({ above: false, maxHeight: maximumListHeight });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const matches = query ? matchingRecipes(sorted, query) : sorted;
  const optionId = (index: number) => `${listId}-option-${index}`;

  function show(highlight: number) {
    setOpen(true);
    setActive(highlight);
  }

  function close() {
    setOpen(false);
    setActive(-1);
    setQuery(null);
  }

  function choose(recipe: Recipe) {
    onChange(recipe.id);
    close();
  }

  // Keep the list inside the visible viewport, above the field if needed.
  useLayoutEffect(() => {
    if (!open || !input.current) return;
    const field = input.current.getBoundingClientRect();
    // Bars fixed to the bottom of the screen cover whatever lies beneath.
    const bottom = Math.min(
      window.visualViewport?.height ?? window.innerHeight,
      ...[
        ...document.querySelectorAll('.bottom-nav, .suspended-cooking-bar'),
      ].flatMap((bar) => {
        const rect = bar.getBoundingClientRect();
        return rect.height > 0 ? [rect.top] : [];
      }),
    );
    const below = bottom - field.bottom - 12;
    const above = field.top - 12;
    const upwards = below < minimumListHeight && above > below;
    setPlacement({
      above: upwards,
      maxHeight: Math.max(
        Math.min(maximumListHeight, upwards ? above : below),
        96,
      ),
    });
  }, [open]);

  // Keep the highlighted option in view without scrolling the page.
  useLayoutEffect(() => {
    const option =
      active >= 0 ? document.getElementById(optionId(active)) : null;
    const container = list.current;
    if (!option || !container) return;
    if (option.offsetTop < container.scrollTop)
      container.scrollTop = option.offsetTop;
    else if (
      option.offsetTop + option.offsetHeight >
      container.scrollTop + container.clientHeight
    )
      container.scrollTop =
        option.offsetTop + option.offsetHeight - container.clientHeight;
  });

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.altKey && event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) show(-1);
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const down = event.key === 'ArrowDown';
        if (!open) {
          const current = matches.findIndex((recipe) => recipe.id === value);
          show(current >= 0 ? current : down ? 0 : matches.length - 1);
          return;
        }
        if (!matches.length) return;
        setActive((index) =>
          down
            ? index + 1 >= matches.length
              ? 0
              : index + 1
            : index <= 0
              ? matches.length - 1
              : index - 1,
        );
        return;
      }
      case 'Enter':
        // Enter in a closed field submits the form as any text field would.
        if (!open) return;
        event.preventDefault();
        if (matches[active]) choose(matches[active]);
        return;
      case 'Escape':
        // An open list owns Escape; the form's Cancel shortcut must not fire.
        if (!open) return;
        event.preventDefault();
        close();
        return;
    }
  }

  function onBlur() {
    // Clearing the text clears the choice; any other unfinished text is
    // dropped in favour of the recipe already chosen.
    if (query !== null && query.trim() === '' && value) onChange('');
    close();
  }

  return (
    <div className="recipe-picker">
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        aria-label="Recipe"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && active >= 0 && matches[active] ? optionId(active) : undefined
        }
        aria-invalid={invalid}
        aria-describedby={describedBy}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder="Choose a recipe"
        value={query ?? chosen?.name ?? ''}
        onChange={(event) => {
          const text = event.target.value;
          setQuery(text);
          show(text.trim() ? 0 : -1);
        }}
        onClick={() => {
          if (open) close();
          else show(matches.findIndex((recipe) => recipe.id === value));
        }}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      <div
        className="recipe-picker-popup"
        data-placement={placement.above ? 'above' : 'below'}
        hidden={!open}
        // Choosing with the mouse or a finger must not move focus away.
        onMouseDown={(event) => event.preventDefault()}
      >
        <ul
          ref={list}
          id={listId}
          role="listbox"
          aria-label="Recipes"
          style={{ maxHeight: placement.maxHeight }}
        >
          {open &&
            matches.map((recipe, index) => (
              <li
                key={recipe.id}
                id={optionId(index)}
                role="option"
                aria-selected={index === active}
                data-chosen={recipe.id === value || undefined}
                onClick={() => choose(recipe)}
                onMouseMove={() => {
                  if (active !== index) setActive(index);
                }}
              >
                {recipe.name}
              </li>
            ))}
        </ul>
        {open && matches.length === 0 && (
          <p className="recipe-picker-empty" aria-hidden="true">
            No recipes match
          </p>
        )}
      </div>
      {/* Always present, so screen readers announce when it fills. */}
      <p className="sr-only" role="status">
        {open && matches.length === 0 ? 'No recipes match' : ''}
      </p>
    </div>
  );
}
