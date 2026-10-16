import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatQuantity, unitLabels, type Unit } from './domain';
import type { ShoppingItem } from './shopping';
import type { PlanningEditBase } from './planning-sync-store';

export function ShoppingItemEditor({
  item,
  disabled,
  onSave,
  onRemove,
  onCheck,
  editBase,
  children,
}: {
  item: ShoppingItem;
  disabled: boolean;
  onSave: (item: ShoppingItem, editBase?: PlanningEditBase) => Promise<unknown>;
  onRemove: () => Promise<unknown>;
  onCheck: (checked: boolean) => Promise<unknown>;
  editBase?: PlanningEditBase;
  children?: ReactNode;
}) {
  const [quantity, setQuantity] = useState(String(item.quantity));
  const [checked, setChecked] = useState(item.checked ?? false);
  const [dirty, setDirty] = useState(false);
  const original = useRef<PlanningEditBase | undefined>(undefined);
  useEffect(() => {
    if (!dirty) setQuantity(String(item.quantity));
  }, [item.quantity, dirty]);
  useEffect(() => setChecked(item.checked ?? false), [item.checked]);
  return (
    <article className="shopping-item" aria-label={item.name}>
      <h3>{item.name}</h3>
      <p>
        {formatQuantity(item.quantity)} {unitLabels[item.unit]}
      </p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(
            { ...item, quantity: Number(quantity) },
            original.current,
          ).then((saved) => {
            if (saved !== false) setDirty(false);
          });
        }}
      >
        <fieldset className="shopping-item-controls" disabled={disabled}>
          <label>
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => {
                const next = event.target.checked;
                setChecked(next);
                void onCheck(next)
                  .then((saved) => {
                    if (saved === false) setChecked(item.checked ?? false);
                  })
                  .catch(() => setChecked(item.checked ?? false));
              }}
            />
            Checked off
          </label>
          <label>
            Quantity
            <input
              type="number"
              step="any"
              min="0"
              value={quantity}
              onChange={(event) => {
                if (!dirty) original.current = editBase;
                setDirty(true);
                setQuantity(event.target.value);
              }}
            />
          </label>
          <button className="button secondary" type="submit">
            Save quantity
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => void onRemove()}
          >
            Remove item
          </button>
        </fieldset>
      </form>
      {children}
    </article>
  );
}

export function ManualShoppingItemForm({
  disabled,
  onSave,
  onCancel,
}: {
  disabled: boolean;
  onSave: (item: ShoppingItem) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unit, setUnit] = useState<Unit>('piece');
  return (
    <section className="panel" aria-label="Manual item details">
      <h2>Add manual shopping item</h2>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            id: crypto.randomUUID(),
            name,
            quantity: Number(quantity),
            unit,
          });
        }}
      >
        <fieldset disabled={disabled} className="shopping-item-controls">
          <label>
            Food item
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Quantity
            <input
              type="number"
              min="0"
              step="any"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </label>
          <label>
            Unit
            <select
              aria-label="Unit"
              value={unit}
              onChange={(event) => setUnit(event.target.value as Unit)}
            >
              {Object.entries(unitLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="button primary" type="submit">
            Save manual item
          </button>
          <button className="button secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
        </fieldset>
      </form>
    </section>
  );
}
