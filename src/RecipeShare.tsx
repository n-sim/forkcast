import { useState } from 'react';
import type { DisplayUnits, Recipe } from './domain';
import { PdfShare } from './PdfShare';

export function RecipeShare({
  recipe,
  portions,
  displayUnits,
  photo,
  rating,
  disabled,
}: {
  recipe: Recipe;
  portions: number;
  displayUnits: DisplayUnits;
  photo?: Blob;
  rating?: number;
  disabled: boolean;
}) {
  const [includeAllocations, setIncludeAllocations] = useState(true);
  return (
    <PdfShare
      label="Share recipe"
      heading="Share recipe as PDF"
      description={
        <>
          For {portions} {portions === 1 ? 'portion' : 'portions'}, in the units
          shown on the recipe page.
        </>
      }
      statusLabel="Recipe PDF status"
      messages={{ subject: 'Recipe PDF' }}
      disabled={disabled}
      optionsKey={String(includeAllocations)}
      options={(busy) => (
        <label className="checkbox-option">
          <input
            type="checkbox"
            checked={includeAllocations}
            disabled={busy}
            onChange={(event) => setIncludeAllocations(event.target.checked)}
          />
          Include step allocations
        </label>
      )}
      create={async () => {
        const { createRecipePdf } = await import('./recipe-pdf');
        return createRecipePdf({
          recipe,
          portions,
          displayUnits,
          photo,
          rating,
          includeAllocations,
        });
      }}
    />
  );
}
