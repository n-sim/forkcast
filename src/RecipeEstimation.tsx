import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { validateRecipe, type RecipeDraft } from './domain';
import { estimateMetadata, estimateNutrition } from './recipe-estimation';
import { AiModelNotice, type AiModelChoice } from './use-ai-model';

type Kind = 'nutrition' | 'metadata';

/** What the estimates depend on: the raw amounts and the yield they are for. */
export function ingredientSignature(draft: RecipeDraft): string {
  return JSON.stringify([
    draft.basePortions,
    draft.ingredients.map(({ name, quantity, unit }) => [
      name.trim(),
      quantity,
      unit,
    ]),
  ]);
}

export function hasNutrition(draft: RecipeDraft): boolean {
  return (
    draft.nutrition !== undefined &&
    Object.values(draft.nutrition).some((value) => value !== null)
  );
}

function hasMetadata(draft: RecipeDraft): boolean {
  return (
    draft.difficulty !== null ||
    draft.activeMinutes !== null ||
    draft.totalMinutes !== null
  );
}

const wording = {
  nutrition: {
    title: 'Replace nutrition values?',
    existing: 'nutrition values',
    replace: 'Replace with AI estimate',
  },
  metadata: {
    title: 'Replace difficulty and time?',
    existing: 'difficulty or time values',
    replace: 'Replace with AI suggestion',
  },
};

function ConfirmDialog({
  kind,
  onCancel,
  onConfirm,
}: {
  kind: Kind;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="estimate-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="estimate-confirm-title">{wording[kind].title}</h2>
      <p>
        This recipe already has {wording[kind].existing}. The AI result replaces
        every value in this form, including the ones you entered. Nothing is
        saved until you save the recipe, and canceling the edit keeps the saved
        values.
      </p>
      <div className="form-actions">
        <button
          className="button secondary"
          type="button"
          autoFocus
          onClick={onCancel}
        >
          Keep my values
        </button>
        <button className="button primary" type="button" onClick={onConfirm}>
          {wording[kind].replace}
        </button>
      </div>
    </dialog>
  );
}

export interface RecipeEstimation {
  ai: AiModelChoice;
  available: boolean;
  busy: Kind | null;
  errors: Record<Kind, string>;
  notices: Record<Kind, string>;
  /** Starts an estimate, first asking when it would replace existing values. */
  request: (kind: Kind) => void;
  dialog: React.ReactNode;
}

export function useRecipeEstimation(
  draft: RecipeDraft,
  setDraft: Dispatch<SetStateAction<RecipeDraft>>,
  ai: AiModelChoice,
  available: boolean,
): RecipeEstimation {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [asking, setAsking] = useState<Kind | null>(null);
  const [errors, setErrors] = useState({ nutrition: '', metadata: '' });
  const [notices, setNotices] = useState({ nutrition: '', metadata: '' });
  const canceled = useRef(false);
  useEffect(
    () => () => {
      canceled.current = true;
    },
    [],
  );

  async function run(kind: Kind) {
    if (!ai.ready || busy) return;
    setErrors((current) => ({ ...current, [kind]: '' }));
    setNotices((current) => ({ ...current, [kind]: '' }));
    const { recipe } = validateRecipe(draft);
    if (!recipe) {
      setErrors((current) => ({
        ...current,
        [kind]:
          'Complete the recipe name, base portions, ingredient names and quantities, and steps before asking for an estimate.',
      }));
      return;
    }
    setBusy(kind);
    try {
      if (kind === 'nutrition') {
        const nutrition = await estimateNutrition(ai.model, recipe);
        if (canceled.current) return;
        setDraft((current) => ({ ...current, nutrition }));
        setNotices((current) => ({
          ...current,
          nutrition:
            'Nutrition estimated by ChatGPT. It is not measured: review and edit the values, then save the recipe to keep them.',
        }));
      } else {
        const metadata = await estimateMetadata(ai.model, recipe);
        if (canceled.current) return;
        setDraft((current) => ({ ...current, ...metadata }));
        setNotices((current) => ({
          ...current,
          metadata:
            'Difficulty and time suggested by ChatGPT. They are estimates, not measured timings: review and edit them, then save the recipe to keep them.',
        }));
      }
    } catch (failure) {
      if (canceled.current) return;
      setErrors((current) => ({
        ...current,
        [kind]:
          failure instanceof Error
            ? failure.message
            : 'The estimate could not be completed. Try again.',
      }));
    } finally {
      if (!canceled.current) setBusy(null);
    }
  }

  function request(kind: Kind) {
    if (kind === 'nutrition' ? hasNutrition(draft) : hasMetadata(draft))
      setAsking(kind);
    else void run(kind);
  }

  return {
    ai,
    available,
    busy,
    errors,
    notices,
    request,
    dialog: asking && (
      <ConfirmDialog
        kind={asking}
        onCancel={() => setAsking(null)}
        onConfirm={() => {
          setAsking(null);
          void run(asking);
        }}
      />
    ),
  };
}

/** The AI button of one form section, with its model notice and outcome. */
export function EstimateControl({
  kind,
  estimation,
  label,
  busyLabel,
  offer,
}: {
  kind: Kind;
  estimation: RecipeEstimation;
  label: string;
  busyLabel: string;
  /** An extra hint shown next to the button. */
  offer?: string;
}) {
  const { ai, available, busy } = estimation;
  const noun = kind === 'nutrition' ? 'estimate nutrition' : 'get suggestions';
  return (
    <div className="estimate-control">
      {!available && (
        <p className="section-note">
          Sign in to your backend account to {noun} with AI. Manual and unknown
          values stay valid without it.
        </p>
      )}
      {available && ai.loaded && ai.connection?.state !== 'connected' && (
        <p className="section-note">
          Connect ChatGPT in <a href="#/settings">Settings</a> to {noun} with
          AI. Manual and unknown values stay valid without it.
        </p>
      )}
      {ai.connection?.state === 'connected' && ai.error && !ai.ready && (
        <p role="alert" className="error-banner">
          {ai.error}
        </p>
      )}
      <AiModelNotice choice={ai} />
      {offer && (
        <p role="status" aria-label={`${kind} re-estimate offer`}>
          {offer}
        </p>
      )}
      {estimation.errors[kind] && (
        <p role="alert" className="error-banner">
          {estimation.errors[kind]}
        </p>
      )}
      {estimation.notices[kind] && (
        <p role="status" aria-label={`${kind} estimate status`}>
          {estimation.notices[kind]}
        </p>
      )}
      {ai.connection?.state === 'connected' && (
        <button
          className="button secondary"
          type="button"
          disabled={!ai.ready || busy !== null}
          onClick={() => estimation.request(kind)}
        >
          {busy === kind ? busyLabel : label}
        </button>
      )}
    </div>
  );
}
