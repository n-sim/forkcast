import { Fragment, useEffect, useRef, useState } from 'react';
import { localDateTime } from './food-log';
import {
  generateShoppingList,
  loadShoppingList,
  saveShoppingItem,
  removeShoppingItem,
  subscribeToShoppingChanges,
} from './shopping-store';
import { generateShoppingRequirements, type ShoppingList } from './shopping';
import { ManualShoppingItemForm, ShoppingItemEditor } from './ShoppingItems';
import { ShoppingListReplacementDialog } from './ShoppingListReplacementDialog';

export function ShoppingListView() {
  const [list, setList] = useState<ShoppingList | null>(null);
  const [replacement, setReplacement] = useState<{
    startDate: string;
    endDate: string;
    listId: string;
  } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [startDate, setStartDate] = useState(() =>
    localDateTime().slice(0, 10),
  );
  const [endDate, setEndDate] = useState(startDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const errorSummary = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      loadShoppingList()
        .then((list) => {
          if (active) {
            setList(list);
            setLoaded(true);
          }
        })
        .catch(() => {
          if (active)
            setError(
              'Your shopping list could not be loaded. Reload to try again. Your stored data has been kept.',
            );
        });
    const unsubscribe = subscribeToShoppingChanges(() => void refresh());
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  async function generate(
    startDate: string,
    endDate: string,
    replacingListId: string | null,
  ) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const list = await generateShoppingList(
        startDate,
        endDate,
        replacingListId,
      );
      setList(list);
      setReplacement(null);
      setAdding(false);
      setMessage('Shopping list generated and saved on this device.');
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }

  function requestGeneration() {
    setError('');
    setMessage('');
    try {
      // Validate the period through Rust before asking to replace reviewed work.
      generateShoppingRequirements([], [], startDate, endDate);
      if (list?.items.length)
        setReplacement({ startDate, endDate, listId: list.id });
      else void generate(startDate, endDate, list?.id ?? null);
    } catch (error) {
      setError(String(error));
    }
  }

  async function update(operation: () => Promise<ShoppingList>) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const updated = await operation();
      setList((current) => (current?.id === updated.id ? updated : current));
      setMessage('Shopping list saved on this device.');
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your personal groceries</p>
          <h1>Shopping list</h1>
          <p>Choose a cooking period, then review what you need to buy.</p>
        </div>
      </div>
      {error && !replacement && (
        <p
          className="error-banner"
          role="alert"
          ref={errorSummary}
          tabIndex={-1}
        >
          {error}
        </p>
      )}
      <p role="status" aria-label="Shopping list status">
        {message}
      </p>
      {!loaded && !error && <p role="status">Loading shopping list…</p>}
      {replacement && (
        <ShoppingListReplacementDialog
          {...replacement}
          saving={saving}
          error={error}
          onKeep={() => {
            setReplacement(null);
            setError('');
          }}
          onReplace={() =>
            generate(
              replacement.startDate,
              replacement.endDate,
              replacement.listId,
            )
          }
        />
      )}
      <form
        className="panel quantity-controls"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          requestGeneration();
        }}
      >
        <label>
          Shopping from
          <input
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </label>
        <label>
          Shopping through
          <input
            type="date"
            min="0001-01-01"
            max="9999-12-31"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
          />
        </label>
        <button
          className="button primary"
          disabled={!loaded || saving || adding}
        >
          Generate shopping list
        </button>
        <p className="section-note">
          You’ll confirm before replacing existing generated items. Manual
          groceries are kept.
        </p>
      </form>
      {list && (
        <>
          <p>
            Cooking period: {list.startDate} through {list.endDate} (inclusive).
          </p>
          <section className="panel" aria-label="Generated requirements">
            <h2>Generated requirements</h2>
            {!list.items.length && (
              <p>No ingredient requirements for this period.</p>
            )}
            {list.items.map((item) => (
              <ShoppingItemEditor
                item={item}
                disabled={saving}
                key={`${list.id}:${item.id}`}
                onSave={(item) =>
                  update(() => saveShoppingItem(list.id, item, 'generated'))
                }
                onRemove={() =>
                  update(() =>
                    removeShoppingItem(list.id, item.id, 'generated'),
                  )
                }
              >
                {item.needsReview && (
                  <p className="nutrition-version-notice">
                    Review conversion: matching ingredients use mass, volume, or
                    pieces. These quantities stay separate because a density or
                    piece-weight conversion is unknown.
                  </p>
                )}
                <p className="section-note">
                  From:{' '}
                  {list.contributions
                    .filter((contribution) =>
                      item.sources.some(
                        (source) => source.cookingId === contribution.cookingId,
                      ),
                    )
                    .map((contribution, index) => (
                      <Fragment key={contribution.cookingId}>
                        {index > 0 && '; '}
                        <a href={`#/recipes/${contribution.recipeId}`}>
                          {contribution.recipeName}
                        </a>{' '}
                        ({contribution.cookingDate}, {contribution.portions}{' '}
                        portions)
                      </Fragment>
                    ))}
                </p>
              </ShoppingItemEditor>
            ))}
          </section>
          <section className="panel" aria-label="Manual shopping items">
            <h2>Manual shopping items</h2>
            <p className="section-note">
              Extra groceries, kept separately from recipe contributions.
            </p>
            {!list.manualItems.length && <p>No manual shopping items.</p>}
            {list.manualItems.map((item) => (
              <ShoppingItemEditor
                item={item}
                disabled={saving}
                key={`${list.id}:${item.id}`}
                onSave={(item) =>
                  update(() => saveShoppingItem(list.id, item, 'manual'))
                }
                onRemove={() =>
                  update(() => removeShoppingItem(list.id, item.id, 'manual'))
                }
              />
            ))}
            <button
              className="button secondary"
              disabled={saving || adding}
              onClick={() => {
                setAdding(true);
                setError('');
              }}
            >
              Add manual item
            </button>
          </section>
          {adding && (
            <ManualShoppingItemForm
              key={list.id}
              disabled={saving}
              onSave={async (item) => {
                const saved = await update(() =>
                  saveShoppingItem(list.id, item, 'manual'),
                );
                if (saved) setAdding(false);
                return saved;
              }}
              onCancel={() => setAdding(false)}
            />
          )}
        </>
      )}
    </article>
  );
}
