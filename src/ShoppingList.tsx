import { useEffect, useRef, useState } from 'react';
import { formatQuantity, unitLabels } from './domain';
import { localDateTime } from './food-log';
import {
  generateShoppingList,
  loadShoppingLists,
  selectShoppingList,
  saveShoppingItem,
  removeShoppingItem,
  subscribeToShoppingChanges,
} from './shopping-store';
import type { ShoppingList } from './shopping';
import { ManualShoppingItemForm, ShoppingItemEditor } from './ShoppingItems';

export function ShoppingListView() {
  const [lists, setLists] = useState<ShoppingList[]>([]);
  const [selectedId, setSelectedId] = useState('');
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
      loadShoppingLists()
        .then(({ lists, selectedId }) => {
          if (active) {
            setLists(lists);
            setSelectedId((current) => current || selectedId || '');
            setLoaded(true);
          }
        })
        .catch(() => {
          if (active)
            setError(
              'Your shopping lists could not be loaded. Reload to try again. Your stored data has been kept.',
            );
        });
    const unsubscribe = subscribeToShoppingChanges(() => void refresh());
    void refresh();
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const list = lists.find((list) => list.id === selectedId) ?? lists[0];

  async function generate() {
    setSaving(true);
    setError('');
    try {
      const list = await generateShoppingList(startDate, endDate);
      setLists((current) => [list, ...current]);
      setSelectedId(list.id);
      setAdding(false);
      setMessage('Shopping list generated and saved on this device.');
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function update(operation: () => Promise<ShoppingList>) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const updated = await operation();
      setLists((current) =>
        current.map((list) => (list.id === updated.id ? updated : list)),
      );
      setMessage('Shopping list saved on this device.');
      return true;
    } catch (error) {
      setError(String(error));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function choose(id: string) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await selectShoppingList(id);
      setSelectedId(id);
    } catch {
      setError(
        'Your shopping list selection could not be saved. Please try again.',
      );
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
      {error && (
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
      {!loaded && !error && <p role="status">Loading shopping lists…</p>}
      <form
        className="panel quantity-controls"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
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
          Saves a new list. Your existing lists keep their reviewed quantities.
        </p>
      </form>
      {list && (
        <>
          <label>
            Saved shopping list
            <select
              aria-label="Saved shopping list"
              disabled={saving || adding}
              value={list.id}
              onChange={(event) => void choose(event.target.value)}
            >
              {lists.map((list, index) => (
                <option key={list.id} value={list.id}>
                  {list.startDate} – {list.endDate} · List{' '}
                  {lists.length - index}
                </option>
              ))}
            </select>
          </label>
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
                    .map(
                      (contribution) =>
                        `${contribution.recipeName} (${contribution.cookingDate}, ${contribution.portions} portions)`,
                    )
                    .join('; ')}
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
          <section className="panel" aria-label="Recipe contributions">
            <h2>Recipe contributions</h2>
            <p className="section-note">
              Captured when generated. Reviewing quantities keeps these original
              requirements available.
            </p>
            {!list.contributions.length && (
              <p>No planned cookings in this period.</p>
            )}
            {list.contributions.map((contribution) => (
              <article className="shopping-item" key={contribution.cookingId}>
                <h3>{contribution.recipeName}</h3>
                <p>
                  {contribution.cookingDate} · {contribution.portions} portions
                </p>
                <ul>
                  {contribution.ingredients.map((ingredient) => (
                    <li key={ingredient.id}>
                      {formatQuantity(ingredient.quantity)}{' '}
                      {unitLabels[ingredient.unit]} {ingredient.name}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        </>
      )}
    </article>
  );
}
