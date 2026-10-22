import { useState } from 'react';
import { formatQuantity } from './domain';
import {
  type ConversionOffer,
  type IngredientConversion,
  type ShoppingList,
} from './shopping';
import { estimateIngredientConversion } from './shopping-store';
import { AiModelNotice, type AiModelChoice } from './use-ai-model';

const references = { volume: '100 ml', count: '1 piece' };

/** Explains an item whose amount includes accepted, estimated conversions. */
export function AcceptedConversionNote({
  list,
  item,
}: {
  list: ShoppingList;
  item: ShoppingList['items'][number];
}) {
  if (!item.convertedFrom?.length) return null;
  return (
    <p className="section-note" aria-label="Estimated conversion">
      Estimated: includes{' '}
      {item.convertedFrom
        .map((origin) => `${formatQuantity(origin.quantity)} ${origin.unit}`)
        .join(' and ')}{' '}
      converted to grams with an accepted ChatGPT estimate (about{' '}
      {item.convertedFrom
        .map((origin) =>
          list.conversions?.find(
            (conversion) =>
              conversion.id === origin.conversionId &&
              conversion.status === 'accepted',
          ),
        )
        .filter((conversion) => conversion?.status === 'accepted')
        .map(
          (conversion) =>
            `${formatQuantity(conversion.grams)} g per ${references[conversion.dimension]}`,
        )
        .filter((text, index, all) => all.indexOf(text) === index)
        .join(', ')}
      ).
    </p>
  );
}

/**
 * Offers an AI estimate for an amount that cannot combine with the same
 * ingredient measured another way. Nothing combines until it is accepted.
 */
export function IngredientConversionReview({
  offer,
  ai,
  disabled,
  onAccept,
  onDecline,
}: {
  offer: ConversionOffer;
  ai: AiModelChoice;
  disabled: boolean;
  onAccept: (conversion: IngredientConversion) => Promise<boolean>;
  onDecline: () => Promise<boolean>;
}) {
  const [estimate, setEstimate] = useState<IngredientConversion | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [error, setError] = useState('');

  async function request() {
    setEstimating(true);
    setError('');
    try {
      setEstimate(
        await estimateIngredientConversion(
          ai.model,
          offer.name,
          offer.dimension,
        ),
      );
    } catch (failure) {
      setError(String(failure instanceof Error ? failure.message : failure));
    } finally {
      setEstimating(false);
    }
  }

  return (
    <div className="conversion-review">
      {!estimate && offer.declined && (
        <p role="status" aria-label="Conversion estimate status">
          Estimate declined. These quantities stay separate.
        </p>
      )}
      {!estimate && !ai.ready && (
        <p className="section-note">
          Without ChatGPT these quantities stay separate. Connect ChatGPT in{' '}
          <a href="#/settings">Settings</a> to estimate a conversion.
        </p>
      )}
      <AiModelNotice choice={ai} />
      {!estimate && ai.ready && (
        <button
          className="button secondary"
          type="button"
          disabled={disabled || estimating}
          onClick={() => void request()}
        >
          {estimating
            ? 'Estimating…'
            : offer.declined
              ? 'Estimate again'
              : 'Estimate conversion'}
        </button>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {estimate && (
        <section aria-label="Conversion estimate" className="panel">
          <p>
            ChatGPT estimates that {references[estimate.dimension]} of{' '}
            {estimate.name} weighs about {formatQuantity(estimate.grams)} g.
            {estimate.note ? ` ${estimate.note}` : ''}
          </p>
          <p className="section-note">
            This is an estimate, not an exact conversion. Accept it to add this
            amount to {estimate.name} in grams, or decline it to keep the
            quantities separate.
          </p>
          <button
            className="button primary"
            type="button"
            disabled={disabled}
            onClick={() =>
              void onAccept(estimate).then(
                (saved) => saved && setEstimate(null),
              )
            }
          >
            Accept estimate
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={disabled}
            onClick={() =>
              void onDecline().then((saved) => saved && setEstimate(null))
            }
          >
            Decline estimate
          </button>
        </section>
      )}
    </div>
  );
}
