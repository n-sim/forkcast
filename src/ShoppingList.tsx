import { Fragment, useEffect, useRef, useState } from 'react';
import { localDateTime } from './food-log';
import {
  generateShoppingList,
  saveShoppingItem,
  removeShoppingItem,
  completeShoppingList,
  type EditableShoppingList,
} from './shopping-store';
import {
  generateShoppingRequirements,
  shoppingComplete,
  type ShoppingItem,
} from './shopping';
import { ManualShoppingItemForm, ShoppingItemEditor } from './ShoppingItems';
import { ShoppingListReplacementDialog } from './ShoppingListReplacementDialog';
import type { PlanningEditBase } from './planning-sync-store';
import { useShoppingList } from './use-shopping-list';
import { ShoppingProgress } from './ShoppingProgress';

const sourceMessages = {
  changed:
    'The meal plan changed within this cooking period. Your reviewed items and quantities are kept until you regenerate.',
  unchanged: 'The meal plan is unchanged within this cooking period.',
  unknown:
    'The source status of this saved list is unavailable. Regenerate to review the current meal plan. Your reviewed items and quantities are kept until you regenerate.',
};

export function ShoppingListView() {
  const { list, setList, loaded, error, setError } = useShoppingList();
  const [replacement, setReplacement] = useState<{
    startDate: string;
    endDate: string;
    listId: string;
    editBase?: PlanningEditBase;
  } | null>(null);
  const [startDate, setStartDate] = useState(() =>
    localDateTime().slice(0, 10),
  );
  const [endDate, setEndDate] = useState(startDate);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [message, setMessage] = useState('');
  const [adding, setAdding] = useState(false);
  const errorSummary = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorSummary.current?.focus();
  }, [error]);
  async function generate(
    startDate: string,
    endDate: string,
    replacingListId: string | null,
    editBase?: PlanningEditBase,
  ) {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const list = await generateShoppingList(
        startDate,
        endDate,
        replacingListId,
        editBase,
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

  function requestGeneration(from = startDate, through = endDate) {
    setError('');
    setMessage('');
    try {
      // Validate the period through Rust before asking to replace reviewed work.
      generateShoppingRequirements([], [], from, through);
      if (list?.items.length)
        setReplacement({
          startDate: from,
          endDate: through,
          listId: list.id,
          editBase: list.editBase,
        });
      else void generate(from, through, list?.id ?? null, list?.editBase);
    } catch (error) {
      setError(String(error));
    }
  }

  async function update(operation: () => Promise<EditableShoppingList>) {
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

  function itemActions(
    currentList: EditableShoppingList,
    item: ShoppingItem,
    kind: 'generated' | 'manual',
  ) {
    return {
      editBase: currentList.editBase,
      onSave: (draft: ShoppingItem, base?: PlanningEditBase) =>
        update(() => saveShoppingItem(currentList.id, draft, kind, base)),
      onRemove: () =>
        update(() =>
          removeShoppingItem(
            currentList.id,
            item.id,
            kind,
            currentList.editBase,
          ),
        ),
    };
  }

  async function exportPdf() {
    if (!list) return;
    setExporting(true);
    setError('');
    setExportMessage('Preparing PDF…');
    try {
      const { exportShoppingPdf } = await import('./shopping-pdf');
      await exportShoppingPdf(list);
      setExportMessage('PDF exported. Your shopping list is still available.');
    } catch {
      setError(
        'The PDF could not be exported. Try again. Your shopping list has been kept.',
      );
      setExportMessage('');
    } finally {
      setExporting(false);
    }
  }

  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Your household’s groceries</p>
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
      <p role="status" aria-label="PDF export status">
        {exportMessage}
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
              replacement.editBase,
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
          <div
            className={
              list.sourceStatus !== 'unchanged'
                ? 'shopping-source-status nutrition-version-notice'
                : 'shopping-source-status'
            }
          >
            <p role="status" aria-label="Shopping source status">
              {sourceMessages[list.sourceStatus]}
            </p>
            {list.sourceStatus !== 'unchanged' && (
              <button
                className="button secondary"
                disabled={!loaded || saving || adding}
                onClick={() => requestGeneration(list.startDate, list.endDate)}
              >
                {list.sourceStatus === 'unknown'
                  ? 'Regenerate from current plan'
                  : 'Regenerate from updated plan'}
              </button>
            )}
          </div>
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
                {...itemActions(list, item, 'generated')}
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
                {...itemActions(list, item, 'manual')}
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
          {!adding && (
            <>
              <ShoppingProgress list={list} />
              <div className="shopping-options panel">
                <p>
                  Export a PDF to take with you, or open the checklist.
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
                <button
                  className="button secondary"
                  disabled={saving || shoppingComplete(list)}
                  onClick={() =>
                    void update(() =>
                      completeShoppingList(list.id, list.editBase),
                    )
                  }
                >
                  Complete shopping
                </button>
              </div>
            </>
          )}
        </>
      )}
    </article>
  );
}
