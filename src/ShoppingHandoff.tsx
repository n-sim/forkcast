import { useEffect, useRef, useState } from 'react';
import { formatQuantity, unitLabels } from './domain';
import { shoppingComplete } from './shopping';
import {
  checkShoppingItem,
  completeShoppingList,
  type EditableShoppingList,
} from './shopping-store';
import { useShoppingList } from './use-shopping-list';

export function ShoppingHandoffView({ checklist }: { checklist: boolean }) {
  const { list, setList, loaded, error, setError } = useShoppingList();
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState('');
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

  const items = list ? [...list.items, ...list.manualItems] : [];
  const complete = list ? shoppingComplete(list) : false;
  async function exportPdf() {
    if (!list) return;
    setExporting(true);
    setError('');
    setMessage('Preparing PDF…');
    try {
      const { exportShoppingPdf } = await import('./shopping-pdf');
      await exportShoppingPdf(list);
      setMessage('PDF exported. Your shopping list is still available.');
    } catch {
      setError(
        'The PDF could not be exported. Try again. Your shopping list has been kept.',
      );
      setMessage('');
    } finally {
      setExporting(false);
    }
  }
  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your household’s groceries</p>
          <h1>{checklist ? 'Shopping checklist' : 'Use your shopping list'}</h1>
          <p>
            {checklist
              ? 'Check off groceries as you shop.'
              : 'Choose how to shop from your reviewed list.'}
          </p>
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
      <p role="status" aria-label="PDF export status">
        {message}
      </p>
      {loaded && !list && <p>Generate and review a shopping list first.</p>}
      {list && (
        <>
          <p>
            Cooking period: {list.startDate} through {list.endDate} (inclusive).
          </p>
          <p role="status" aria-label="Shopping progress">
            {complete ? 'Shopping complete.' : 'Shopping in progress.'}{' '}
            {items.filter((item) => item.checked).length} of {items.length}{' '}
            items checked.
          </p>
          {!checklist && (
            <div className="shopping-options panel">
              <p>
                Export a PDF to take with you, or use the checklist here.
                Exporting leaves shopping progress unchanged.
              </p>
              <button
                className="button secondary"
                disabled={saving || exporting}
                onClick={() => void exportPdf()}
              >
                Export PDF
              </button>
              <a className="button primary" href="#/shopping-list/checklist">
                Open checklist
              </a>
            </div>
          )}
          {checklist && (
            <>
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
              <a className="button secondary" href="#/shopping-list/use">
                Shopping options
              </a>
            </>
          )}
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
