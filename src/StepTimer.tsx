import { useState } from 'react';
import {
  stepTimerRemaining,
  type StepTimer as Timer,
  type TimerAction,
} from './domain';

export function StepTimer({
  timer,
  stepNumber,
  now,
  saving,
  onChange,
}: {
  timer?: Timer;
  stepNumber: number;
  now: number;
  saving: boolean;
  onChange: (action: TimerAction) => void;
}) {
  const [minutes, setMinutes] = useState('5');
  const remaining = timer ? stepTimerRemaining(timer, now) : 0;
  const seconds = Math.ceil(remaining / 1000);
  const running = timer?.endsAt != null && remaining > 0;
  return (
    <section
      className="panel timer-panel"
      aria-label={`Step ${stepNumber} timer controls`}
    >
      <h2>Step timer</h2>
      {timer ? (
        <>
          <p
            role="timer"
            aria-label={`Step ${stepNumber} timer`}
            className="timer-display"
          >
            {String(Math.floor(seconds / 60)).padStart(2, '0')}:
            {String(seconds % 60).padStart(2, '0')}
          </p>
          <p className="section-note">
            {remaining === 0 ? 'Finished' : running ? 'Running' : 'Paused'}
          </p>
          <div className="form-actions">
            {remaining > 0 && (
              <button
                className="button primary"
                disabled={saving}
                onClick={() => onChange({ type: running ? 'pause' : 'resume' })}
              >
                {running ? 'Pause timer' : 'Resume timer'}
              </button>
            )}
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => onChange({ type: 'reset' })}
            >
              Reset timer
            </button>
          </div>
        </>
      ) : (
        <form
          className="timer-start"
          onSubmit={(event) => {
            event.preventDefault();
            onChange({ type: 'start', minutes: Number(minutes) });
          }}
          noValidate
        >
          <label>
            Timer minutes
            <input
              type="number"
              step="any"
              min="0"
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
            />
          </label>
          <button className="button primary" disabled={saving}>
            Start timer
          </button>
        </form>
      )}
    </section>
  );
}
