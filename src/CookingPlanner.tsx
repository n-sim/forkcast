import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CoreError } from './core';
import {
  applyCookingPlan,
  generateCookingPlan,
  scheduleCookings,
  schedulingStrategyLabels,
  type CookingPlanProposal,
  type SchedulingStrategy,
} from './cooking-plans';
import {
  cookingPeriodLabels,
  cookingPeriodOf,
  cookingTimeRank,
  dateLabel,
  shiftDate,
  type PlannedCooking,
  type PlanningRecipe,
} from './planning';
import { AiModelNotice, useAiModel } from './use-ai-model';

export type PlannerMode = 'schedule' | 'generate';

/** The most days one proposal may fill; the core enforces the same limit. */
const maxDays = 31;

function datesBetween(start: string, end: string): string[] | null {
  if (!start || !end || end < start) return null;
  const dates = [start];
  while (dates[dates.length - 1]! < end) {
    if (dates.length === maxDays) return null;
    dates.push(shiftDate(dates[dates.length - 1]!, 1));
  }
  return dates;
}

function describe(cooking: PlannedCooking, recipes: PlanningRecipe[]) {
  const name =
    recipes.find((recipe) => recipe.id === cooking.recipeId)?.name ??
    'Recipe unavailable';
  const period = cookingPeriodOf(cooking.cookingTime);
  return [
    name,
    `${cooking.portions} ${cooking.portions === 1 ? 'portion' : 'portions'}`,
    ...(period ? [cookingPeriodLabels[period]] : []),
  ].join(' · ');
}

function byTime(a: PlannedCooking, b: PlannedCooking) {
  return (
    cookingTimeRank(a.cookingTime) - cookingTimeRank(b.cookingTime) ||
    a.id.localeCompare(b.id)
  );
}

function Proposal({
  proposal,
  recipes,
  applying,
  onApply,
  onDiscard,
}: {
  proposal: CookingPlanProposal;
  recipes: PlanningRecipe[];
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}) {
  const replacing = proposal.replaced.length;
  return (
    <section className="panel" aria-labelledby="cooking-plan-proposal-heading">
      <h2 id="cooking-plan-proposal-heading">Proposed cooking plan</h2>
      <p className="section-note">
        Nothing in your meal plan has changed yet. Days outside this proposal
        stay as they are.
      </p>
      <ul className="cooking-plan-days" aria-label="Proposed cookings">
        {proposal.dates.map((date) => {
          const entries = proposal.cookings
            .filter((cooking) => cooking.cookingDate === date)
            .sort(byTime);
          return (
            <li key={date}>
              <strong>{dateLabel(date)}</strong>
              {entries.length ? (
                <ul>
                  {entries.map((cooking) => (
                    <li key={cooking.id}>{describe(cooking, recipes)}</li>
                  ))}
                </ul>
              ) : (
                <p className="section-note">No cooking planned.</p>
              )}
            </li>
          );
        })}
      </ul>
      {replacing > 0 && (
        <div
          className="nutrition-version-notice"
          role="status"
          aria-label="Planned cookings to replace"
        >
          <p>
            Applying this plan replaces {replacing} planned{' '}
            {replacing === 1 ? 'cooking' : 'cookings'} on these days:
          </p>
          <ul>
            {proposal.replaced.map((cooking) => (
              <li key={cooking.id}>
                {dateLabel(cooking.cookingDate)}: {describe(cooking, recipes)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-actions">
        <button
          className="button primary"
          disabled={applying}
          onClick={onApply}
        >
          {applying
            ? 'Applying…'
            : replacing
              ? 'Replace and apply plan'
              : 'Apply plan'}
        </button>
        <button
          className="button secondary"
          disabled={applying}
          onClick={onDiscard}
        >
          {replacing ? 'Keep existing plan' : 'Discard proposal'}
        </button>
      </div>
    </section>
  );
}

export function CookingPlanner({
  mode,
  recipes,
  today,
  personalAvailable,
  onApplied,
  onCancel,
}: {
  mode: PlannerMode;
  recipes: PlanningRecipe[];
  today: string;
  personalAvailable: boolean;
  onApplied: (proposal: CookingPlanProposal) => Promise<void>;
  onCancel: () => void;
}) {
  const ai = useAiModel(mode === 'generate' && personalAvailable);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(() => shiftDate(today, 6));
  const [skipped, setSkipped] = useState<string[]>([]);
  const [portions, setPortions] = useState('2');
  const [minimumRating, setMinimumRating] = useState('');
  const [strategy, setStrategy] = useState<SchedulingStrategy>(
    'lastCookedLongestAgo',
  );
  const [request, setRequest] = useState('');
  const [proposal, setProposal] = useState<CookingPlanProposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canceled = useRef(false);
  useEffect(
    () => () => {
      canceled.current = true;
    },
    [],
  );

  const period = datesBetween(startDate, endDate);
  const days = period?.filter((date) => !skipped.includes(date)) ?? [];
  const portionCount = Number(portions);
  const connected = ai.connection?.state === 'connected';
  const generating = mode === 'generate';
  const canPropose =
    !busy &&
    !!period &&
    (generating
      ? connected && ai.ready && personalAvailable && !!request.trim()
      : days.length > 0 &&
        portions.trim() !== '' &&
        Number.isFinite(portionCount) &&
        portionCount > 0);

  async function propose(event: FormEvent) {
    event.preventDefault();
    if (!canPropose || !period) return;
    setBusy(true);
    setError('');
    setProposal(undefined);
    try {
      const result = generating
        ? await generateCookingPlan({
            model: ai.model,
            request,
            startDate: period[0]!,
            endDate: period[period.length - 1]!,
          })
        : await scheduleCookings({
            dates: days,
            portions: portionCount,
            minimumRating: minimumRating ? Number(minimumRating) : null,
            strategy,
          });
      if (!canceled.current) setProposal(result);
    } catch (failure) {
      if (!canceled.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'No cooking plan could be proposed. Try again.',
        );
    } finally {
      if (!canceled.current) setBusy(false);
    }
  }

  async function apply() {
    if (!proposal) return;
    setBusy(true);
    setError('');
    try {
      await applyCookingPlan(proposal);
      await onApplied(proposal);
    } catch (failure) {
      if (canceled.current) return;
      setProposal(undefined);
      setError(
        failure instanceof CoreError && failure.kind === 'conflict'
          ? 'The meal plan for these days changed meanwhile, so nothing was replaced. Propose again to review the current plan.'
          : `The cooking plan could not be applied, and your meal plan was not changed. ${failure instanceof Error ? failure.message : ''}`,
      );
    } finally {
      if (!canceled.current) setBusy(false);
    }
  }

  const heading = generating ? 'Generate a cooking plan' : 'Schedule cooking';
  return (
    <>
      <section className="panel" aria-labelledby="cooking-planner-heading">
        <h2 id="cooking-planner-heading">{heading}</h2>
        {generating ? (
          <>
            <p className="section-note">
              Describe what to cook in the period. ChatGPT chooses only recipes
              from your collection and sees your ratings, the household’s
              cooking history and nearby planned cookings. Your saved{' '}
              <a href="#/settings">cooking plan prompt</a> applies to each
              request.
            </p>
            {!personalAvailable && (
              <p>Sign in to your backend account to generate cooking plans.</p>
            )}
            {personalAvailable && ai.connection && !connected && (
              <p>
                Connect ChatGPT in <a href="#/settings">Settings</a> to generate
                cooking plans. You can also schedule cooking without AI.
              </p>
            )}
            {ai.error && (
              <p role="alert" className="error-banner">
                {ai.error} <a href="#/settings">ChatGPT settings</a>
              </p>
            )}
          </>
        ) : (
          <p className="section-note">
            Choose the days and portions. Each day gets one recipe from your
            collection, chosen by the strategy below.
          </p>
        )}
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <form noValidate onSubmit={(event) => void propose(event)}>
          <fieldset disabled={busy} className="food-entry-fields">
            <div className="metadata-fields">
              <label>
                First day
                <input
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                  value={startDate}
                  onChange={(event) => {
                    setStartDate(event.target.value);
                    setProposal(undefined);
                  }}
                />
              </label>
              <label>
                Last day
                <input
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                  value={endDate}
                  onChange={(event) => {
                    setEndDate(event.target.value);
                    setProposal(undefined);
                  }}
                />
              </label>
              {!generating && (
                <>
                  <label>
                    Portions per day
                    <input
                      type="number"
                      step="any"
                      min="0"
                      value={portions}
                      onChange={(event) => setPortions(event.target.value)}
                    />
                  </label>
                  <label>
                    Minimum rating
                    <select
                      aria-label="Minimum rating"
                      value={minimumRating}
                      disabled={!personalAvailable}
                      onChange={(event) => setMinimumRating(event.target.value)}
                    >
                      <option value="">Any, including unrated</option>
                      {[1, 2, 3, 4, 5].map((stars) => (
                        <option key={stars} value={stars}>
                          {stars === 5
                            ? '5 stars'
                            : `${stars} ${stars === 1 ? 'star' : 'stars'} or more`}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </div>
            {!period && (
              <p className="error-banner" role="alert">
                Choose a last day on or after the first day, at most {maxDays}{' '}
                days later.
              </p>
            )}
            {!generating && period && (
              <>
                <fieldset className="cooking-plan-choices">
                  <legend>Days to schedule</legend>
                  {period.map((date) => (
                    <label key={date} className="cooking-plan-choice">
                      <input
                        type="checkbox"
                        checked={!skipped.includes(date)}
                        onChange={(event) => {
                          setSkipped(
                            event.target.checked
                              ? skipped.filter((day) => day !== date)
                              : [...skipped, date],
                          );
                          setProposal(undefined);
                        }}
                      />
                      {dateLabel(date)}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="cooking-plan-choices">
                  <legend>Strategy</legend>
                  {(
                    Object.keys(
                      schedulingStrategyLabels,
                    ) as SchedulingStrategy[]
                  ).map((choice) => (
                    <label key={choice} className="cooking-plan-choice">
                      <input
                        type="radio"
                        name="scheduling-strategy"
                        checked={strategy === choice}
                        onChange={() => setStrategy(choice)}
                      />
                      {schedulingStrategyLabels[choice]}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
            {generating && (
              <label className="cooking-plan-request">
                Describe this cooking plan
                <textarea
                  value={request}
                  onChange={(event) => setRequest(event.target.value)}
                  maxLength={8000}
                  placeholder="For example: meals I liked and have not cooked for a while, something quick on weekdays."
                />
              </label>
            )}
            <div className="form-actions">
              <button className="button primary" disabled={!canPropose}>
                {busy && !proposal
                  ? generating
                    ? 'Generating…'
                    : 'Proposing…'
                  : generating
                    ? 'Generate plan'
                    : 'Propose schedule'}
              </button>
              <button
                className="button secondary"
                type="button"
                aria-keyshortcuts="Escape"
                onClick={onCancel}
              >
                Close
              </button>
            </div>
            {generating && <AiModelNotice choice={ai} />}
            {busy && generating && !proposal && (
              <p role="status">
                Generating your cooking plan… Keep this page open.
              </p>
            )}
          </fieldset>
        </form>
      </section>
      {proposal && (
        <Proposal
          proposal={proposal}
          recipes={recipes}
          applying={busy}
          onApply={() => void apply()}
          onDiscard={() => setProposal(undefined)}
        />
      )}
    </>
  );
}
