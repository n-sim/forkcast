import { useEffect, useState } from 'react';
import { formatQuantity, unitLabels } from './domain';
import { isNative, subscribeToTopics } from './core';
import { AiModelNotice, useAiModel } from './use-ai-model';
import {
  fillSupermarketCart,
  supermarketStatus,
  type CartHandoff,
  type CartItem,
  type SupermarketStatus,
} from './supermarket-client';

const outcomes: Record<CartItem['status'], string> = {
  added: 'Added',
  failed: 'Not added: Gurkerl refused it',
  not_added: 'Not added',
  skipped: 'Skipped: already checked off',
};

/**
 * Hands the reviewed list to the person's Gurkerl cart. The list stays as it
 * is: cart population is not shopping completion.
 */
export function GurkerlCart({
  listId,
  disabled,
}: {
  listId: string;
  disabled: boolean;
}) {
  const [connection, setConnection] = useState<SupermarketStatus | null>(null);
  const ai = useAiModel(isNative);
  const [filling, setFilling] = useState(false);
  const [handoff, setHandoff] = useState<CartHandoff | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isNative) return;
    let active = true;
    const load = () =>
      void supermarketStatus()
        .then((status) => active && setConnection(status))
        .catch(() => active && setConnection(null));
    load();
    const stop = subscribeToTopics(['supermarket'], load);
    return () => {
      active = false;
      stop();
    };
  }, []);

  async function fill() {
    setFilling(true);
    setError('');
    setHandoff(null);
    try {
      setHandoff(await fillSupermarketCart(listId, ai.model));
    } catch (failure) {
      setError(String(failure instanceof Error ? failure.message : failure));
    } finally {
      setFilling(false);
    }
  }

  const connected = connection?.state === 'connected';
  const shown = handoff?.listId === listId ? handoff : null;
  const added = shown?.items.filter((item) => item.status === 'added').length;

  return (
    <section className="panel" aria-label="Gurkerl cart">
      <h2>Gurkerl cart</h2>
      {!isNative ? (
        <p>
          Fill a Gurkerl cart from this list in the installed Forkcast app. Your
          Gurkerl sign-in stays on that device.
        </p>
      ) : (
        <>
          <p className="section-note">
            ChatGPT chooses Gurkerl products for the reviewed quantities,
            including manual items, following your product selection prompt
            (Settings, Gurkerl). Items already checked off are skipped. Forkcast
            never checks out or places an order, and your shopping list stays
            open.
          </p>
          {connection && !connected && (
            <p className="section-note">
              <a href="#/settings">Connect Gurkerl</a> in Settings to fill your
              cart.
            </p>
          )}
          {ai.loaded && !ai.ready && !ai.missing && (
            <p className="section-note">
              <a href="#/settings">Connect ChatGPT</a> in Settings to choose
              products.
            </p>
          )}
          <AiModelNotice choice={ai} />
          <button
            type="button"
            className="button secondary"
            disabled={disabled || filling || !connected || !ai.ready}
            onClick={() => void fill()}
          >
            {filling ? 'Filling Gurkerl cart…' : 'Fill Gurkerl cart'}
          </button>
        </>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {shown && (
        <div aria-label="Gurkerl cart results" role="region">
          <p role="status" aria-label="Gurkerl cart status">
            {shown.complete
              ? `Gurkerl confirmed ${added} of ${shown.items.length} items in your cart. Your shopping list is still available; check out in Gurkerl.`
              : 'The Gurkerl cart handoff did not finish.'}
          </p>
          {shown.message && (
            <p className="error-banner" role="alert">
              {shown.message}
            </p>
          )}
          <ul>
            {shown.items.map((item) => (
              <li key={item.itemId}>
                {item.name}
                {item.quantity !== null &&
                  `, ${formatQuantity(item.quantity)} ${unitLabels[item.unit]}`}
                : {outcomes[item.status]}
                {item.product && ` (${item.product})`}
                {item.note && item.status !== 'added' && `. ${item.note}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
