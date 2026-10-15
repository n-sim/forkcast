import { useEffect, useRef, useState } from 'react';
import {
  calculateRecipe,
  formatQuantity,
  unitLabels,
  stepTimerRemaining,
  updateStepTimer,
  type TimerAction,
  type Recipe,
} from './domain';
import type { CookingSession } from './cooking';
import { StepTimer } from './StepTimer';

export function CookingView({
  session,
  currentRecipe,
  onSave,
}: {
  session: CookingSession;
  currentRecipe?: Recipe;
  onSave: (session: CookingSession) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false);
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
  const quantities = calculateRecipe(session.recipe, session.portions);
  const step = quantities.steps[session.currentStep]!;

  async function save(update: () => CookingSession) {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setError('');
    try {
      await onSave(update());
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
    void save(() => ({
      ...session,
      timers: {
        ...session.timers,
        [step.id]: updateStepTimer(
          session.timers[step.id] ?? null,
          action,
          Date.now(),
        ),
      },
    }));
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
        <a className="button secondary" href={`#/recipes/${session.recipe.id}`}>
          Close cooking
        </a>
      </div>
      {currentRecipe &&
        JSON.stringify(currentRecipe) !== JSON.stringify(session.recipe) && (
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
          onClick={() =>
            void save(() => ({
              ...session,
              currentStep: session.currentStep - 1,
            }))
          }
        >
          Back step
        </button>
        <button
          className="button primary"
          disabled={
            saving || session.currentStep === quantities.steps.length - 1
          }
          onClick={() =>
            void save(() => ({
              ...session,
              currentStep: session.currentStep + 1,
            }))
          }
        >
          Next step
        </button>
      </div>
      <p className="section-note cooking-save-note">
        Progress is saved on this device as you go.
      </p>
    </article>
  );
}
