import { useEffect, useRef, useState } from 'react';
import {
  calculateRecipe,
  validateRecipe,
  formatQuantity,
  unitLabels,
  stepTimerRemaining,
  updateStepTimer,
  type TimerAction,
  type Recipe,
} from './domain';
import {
  progressSummary,
  type CookingSession,
  type SessionProgress,
} from './cooking';
import { StepTimer } from './StepTimer';

export function CookingView({
  session,
  currentRecipe,
  onSave,
  onFinish,
  onCancel,
  onSuspend,
  onResolve,
}: {
  session: CookingSession;
  currentRecipe?: Recipe;
  onSave: (session: CookingSession) => Promise<void>;
  onFinish: () => Promise<void>;
  onCancel: () => Promise<void>;
  onSuspend: () => Promise<void>;
  onResolve: (keep: 'current' | 'alternative') => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
  const cancelDialog = useRef<HTMLDialogElement>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const interval = window.setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  const quantities = calculateRecipe(
    session.recipe,
    session.portions,
    session.displayUnits,
  );
  const step = quantities.steps[session.currentStep]!;
  const lastStep = session.currentStep === quantities.steps.length - 1;

  async function persist(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await action();
      setNow(Date.now());
    } catch (error) {
      setError(
        typeof error === 'string'
          ? error
          : 'Cooking progress could not be saved. Keep this view open and try again.',
      );
    } finally {
      setSaving(false);
      busy.current = false;
    }
  }

  function changeTimer(action: TimerAction) {
    void persist(() =>
      onSave({
        ...session,
        timers: {
          ...session.timers,
          [step.id]: updateStepTimer(
            session.timers[step.id] ?? null,
            action,
            Date.now(),
          ),
        },
      }),
    );
  }

  if (session.conflict) {
    return (
      <article>
        <div className="page-heading">
          <div>
            <p className="eyebrow">Guided cooking</p>
            <h1>{session.recipe.name}</h1>
            <p>
              Cooking {session.portions}{' '}
              {session.portions === 1 ? 'portion' : 'portions'}
            </p>
          </div>
        </div>
        <section
          className="panel"
          role="region"
          aria-labelledby="cooking-progress-conflict-title"
        >
          <h2 id="cooking-progress-conflict-title">
            Cooking changed on two devices
          </h2>
          <p>
            This cooking session was changed on another of your devices at the
            same time. Choose which progress to keep. Both use the ingredients
            and instructions captured when cooking started.
          </p>
          <ul aria-label="Competing cooking progress">
            <li>Current: {describe(session, session.recipe.steps.length)}</li>
            <li>
              Other device:{' '}
              {describe(session.conflict.progress, session.recipe.steps.length)}
            </li>
          </ul>
          {error && (
            <p className="error-banner" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => void persist(() => onResolve('current'))}
            >
              Keep current progress
            </button>
            <button
              className="button primary"
              disabled={saving}
              onClick={() => void persist(() => onResolve('alternative'))}
            >
              Use other device’s progress
            </button>
          </div>
        </section>
      </article>
    );
  }

  return (
    <article>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Guided cooking</p>
          <h1>{session.recipe.name}</h1>
          <p>
            Cooking {session.portions}{' '}
            {session.portions === 1 ? 'portion' : 'portions'}
          </p>
        </div>
        <div
          className="cooking-session-actions"
          role="group"
          aria-label="Cooking session actions"
        >
          <button
            className="button secondary"
            disabled={saving}
            onClick={() => void persist(onSuspend)}
          >
            Suspend cooking
          </button>
          <button
            className="button secondary"
            disabled={saving}
            onClick={() => {
              setError('');
              cancelDialog.current?.showModal();
            }}
          >
            Cancel cooking
          </button>
        </div>
      </div>
      <dialog
        ref={cancelDialog}
        aria-labelledby="cancel-cooking-title"
        aria-describedby="cancel-cooking-description"
        className="cancel-cooking-dialog"
        onCancel={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <h2 id="cancel-cooking-title">Cancel cooking?</h2>
        <p id="cancel-cooking-description">
          End the cooking session for <strong>{session.recipe.name}</strong>? It
          will no longer be available to resume, and the recipe will not be
          marked cooked.
        </p>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <button
            className="button secondary"
            autoFocus
            disabled={saving}
            onClick={() => cancelDialog.current?.close()}
          >
            Keep cooking
          </button>
          <button
            className="button primary"
            disabled={saving}
            aria-busy={saving}
            onClick={() => void persist(onCancel)}
          >
            Cancel cooking
          </button>
        </div>
      </dialog>
      {session.recipeArchived && (
        <p
          className="allocation-checks"
          role="status"
          aria-label="Archived recipe"
        >
          This recipe has been archived. You can still finish cooking with the
          ingredients and instructions captured when you started.
        </p>
      )}
      {currentRecipe &&
        JSON.stringify(validateRecipe(currentRecipe).recipe) !==
          JSON.stringify(validateRecipe(session.recipe).recipe) && (
          <p
            className="allocation-checks"
            role="status"
            aria-label="Recipe changes"
          >
            Recipe changed since this cooking session started. You’re cooking
            with the captured ingredients and instructions.
          </p>
        )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <section className="panel" aria-label="Current cooking step">
        <p className="eyebrow">
          Step {session.currentStep + 1} of {quantities.steps.length}
        </p>
        <h2 className="cooking-instruction">{step.instruction}</h2>
        {step.allocations.length ? (
          <ul className="ingredient-list" aria-label="Step ingredients">
            {step.allocations.map((allocation) => (
              <li key={allocation.ingredientId}>
                <strong>
                  {formatQuantity(allocation.quantity!)}{' '}
                  {unitLabels[allocation.unit]}
                </strong>{' '}
                {
                  session.recipe.ingredients.find(
                    (ingredient) => ingredient.id === allocation.ingredientId,
                  )?.name
                }
              </li>
            ))}
          </ul>
        ) : (
          <p className="section-note">No ingredients allocated to this step.</p>
        )}
      </section>
      <StepTimer
        key={step.id}
        timer={session.timers[step.id]}
        stepNumber={session.currentStep + 1}
        now={now}
        saving={saving}
        onChange={changeTimer}
      />
      <p className="section-note">
        No alarms while the application is closed or suspended.
      </p>
      <div role="status" aria-label="Timer notifications">
        {session.recipe.steps.map((step, index) => {
          const timer = session.timers[step.id];
          return timer && stepTimerRemaining(timer, now) === 0 ? (
            <p key={step.id}>Step {index + 1} timer finished.</p>
          ) : null;
        })}
      </div>
      <div className="form-actions">
        <button
          className="button secondary"
          disabled={saving || session.currentStep === 0}
          aria-keyshortcuts="ArrowLeft"
          onClick={() =>
            void persist(() =>
              onSave({
                ...session,
                currentStep: session.currentStep - 1,
              }),
            )
          }
        >
          Back step
        </button>
        <button
          className="button primary"
          disabled={saving}
          aria-busy={saving}
          // Finishing marks the recipe cooked, so it is never one keypress.
          aria-keyshortcuts={lastStep ? undefined : 'ArrowRight'}
          onClick={() =>
            lastStep
              ? void persist(onFinish)
              : void persist(() =>
                  onSave({
                    ...session,
                    currentStep: session.currentStep + 1,
                  }),
                )
          }
        >
          {lastStep ? 'Finish cooking' : 'Next step'}
        </button>
      </div>
      <p className="section-note cooking-save-note">
        Progress is saved on this device as you go.
      </p>
    </article>
  );
}

function describe(progress: SessionProgress, stepCount: number) {
  const timers = Object.keys(progress.timers ?? {}).length;
  return (
    progressSummary(progress, stepCount) +
    (timers ? ` · ${timers} ${timers === 1 ? 'timer' : 'timers'}` : '')
  );
}
