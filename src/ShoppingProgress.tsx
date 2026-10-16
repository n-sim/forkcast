import { shoppingComplete, type ShoppingList } from './shopping';

export function ShoppingProgress({ list }: { list: ShoppingList }) {
  const items = [...list.items, ...list.manualItems];
  return (
    <p role="status" aria-label="Shopping progress">
      {shoppingComplete(list) ? 'Shopping complete.' : 'Shopping in progress.'}{' '}
      {items.filter((item) => item.checked).length} of {items.length} items
      checked.
    </p>
  );
}
