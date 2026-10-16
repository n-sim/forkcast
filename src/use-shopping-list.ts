import { useEffect, useState } from 'react';
import {
  loadShoppingList,
  subscribeToShoppingChanges,
  type EditableShoppingList,
} from './shopping-store';

export function useShoppingList() {
  const [list, setList] = useState<EditableShoppingList | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
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
  return { list, setList, loaded, error, setError };
}
