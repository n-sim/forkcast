import { useLayoutEffect, useRef } from 'react';
import { CancelCookingButton } from './CancelCookingButton';
import { cookingUrl, progressSummary, type CookingSession } from './cooking';

export function SuspendedCookingBar({
  session,
  onCancel,
}: {
  session: CookingSession;
  onCancel: () => Promise<void>;
}) {
  const bar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = bar.current!;
    const reserveSpace = () =>
      document.documentElement.style.setProperty(
        '--cooking-bar-height',
        `${element.getBoundingClientRect().height}px`,
      );
    reserveSpace();
    const observer = new ResizeObserver(reserveSpace);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty('--cooking-bar-height');
    };
  }, []);
  return (
    <section
      ref={bar}
      className="suspended-cooking-bar"
      aria-label="Suspended cooking"
    >
      <div className="suspended-cooking-summary">
        <p className="eyebrow">
          {session.conflict ? 'Cooking needs a decision' : 'Cooking suspended'}
        </p>
        <p className="suspended-cooking-title">{session.recipe.name}</p>
        <p className="section-note">
          {session.portions} {session.portions === 1 ? 'portion' : 'portions'} ·{' '}
          {session.conflict
            ? 'Changed on two devices'
            : progressSummary(session, session.recipe.steps.length)}
        </p>
      </div>
      <div className="suspended-cooking-actions">
        {/* A conflicted session is decided first; only then can it be canceled. */}
        {!session.conflict && (
          <CancelCookingButton
            recipeName={session.recipe.name}
            onCancel={onCancel}
          />
        )}
        <a className="button primary" href={cookingUrl(session.id)}>
          {session.conflict ? 'Review cooking' : 'Resume cooking'}
        </a>
      </div>
    </section>
  );
}
