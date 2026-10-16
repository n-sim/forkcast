import { useEffect, useRef, useState } from 'react';
import { formatQuantity, unitLabels } from './domain';
import { shoppingComplete } from './shopping';
import {
  checkShoppingItem,
  completeShoppingList,
  type EditableShoppingList,
} from './shopping-store';
import { useShoppingList } from './use-shopping-list';
import { ShoppingProgress } from './ShoppingProgress';

export function ShoppingChecklistView() {
  const { list, setList, loaded, error, setError } = useShoppingList();
  const [saving, setSaving] = useState(false);
  const [pendingCheck, setPendingCheck] = useState<{
    id: string;
    checked: boolean;
  } | null>(null);
  const errorSummary = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);

  async function update(operation: () => Promise<EditableShoppingList>) {
    setSaving(true);
    setError('');
    try {
      setList(await operation());
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
      setPendingCheck(null);
    }
  }

  const complete = list ? shoppingComplete(list) : false;
  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your household’s groceries</p>
          <h1>Shopping checklist</h1>
          <p>Check off groceries as you shop.</p>
        </div>
        <a className="button secondary" href="#/shopping-list">
          Review shopping list
        </a>
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
      {!loaded && !error && <p role="status">Loading shopping list…</p>}
      {loaded && !list && <p>Generate and review a shopping list first.</p>}
      {list && (
        <>
          <p>
            Cooking period: {list.startDate} through {list.endDate} (inclusive).
          </p>
          <ShoppingProgress list={list} />
          {[
            { title: 'Generated requirements', items: list.items },
            { title: 'Manual shopping items', items: list.manualItems },
          ].map(({ title, items }) => (
            <section className="panel" aria-label={title} key={title}>
              <h2>{title}</h2>
              {!items.length && <p>No {title.toLowerCase()}.</p>}
              {items.map((item) => (
                <label className="shopping-check" key={item.id}>
                  <input
                    type="checkbox"
                    checked={
                      pendingCheck?.id === item.id
                        ? pendingCheck.checked
                        : (item.checked ?? false)
                    }
                    disabled={saving}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setPendingCheck({ id: item.id, checked });
                      void update(() =>
                        checkShoppingItem(
                          list.id,
                          item.id,
                          checked,
                          list.editBase,
                        ),
                      );
                    }}
                  />
                  <span>
                    {item.name}, {formatQuantity(item.quantity)}{' '}
                    {unitLabels[item.unit]}
                  </span>
                </label>
              ))}
            </section>
          ))}
          <div className="shopping-completion">
            <button
              className="button secondary"
              disabled={saving || complete}
              onClick={() =>
                void update(() => completeShoppingList(list.id, list.editBase))
              }
            >
              Complete shopping
            </button>
          </div>
        </>
      )}
    </article>
  );
}
