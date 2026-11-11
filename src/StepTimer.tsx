import { useState } from 'react';
import {
  stepTimerRemaining,
  type StepTimer as Timer,
  type TimerAction,
} from './domain';

/** A timer handed to the device's clock app, which this view cannot control. */
export interface ClockAppTimer {
  minutes: number;
  endsAt: number;
}

export function StepTimer({
  timer,
  clockAppTimer,
  stepNumber,
  now,
  saving,
  onStart,
  onChange,
  onUseInApp,
  onDismissClockApp,
}: {
  timer?: Timer;
  clockAppTimer?: ClockAppTimer;
  stepNumber: number;
  now: number;
  saving: boolean;
  onStart: (minutes: number) => void;
  onChange: (action: TimerAction) => void;
  onUseInApp: (minutes: number) => void;
  onDismissClockApp: () => void;
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
      ) : clockAppTimer ? (
        <>
          <p
            role="status"
            aria-label={`Step ${stepNumber} clock app timer`}
            className="timer-clock-app"
          >
            {clockAppTimer.endsAt > now
              ? `Timer started in your Clock app: ${formatMinutes(clockAppTimer.minutes)}, rings at about ${new Date(clockAppTimer.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
              : `Your Clock app timer of ${formatMinutes(clockAppTimer.minutes)} has finished.`}
          </p>
          <p className="section-note">
            It keeps counting and rings even when Forkcast is closed. Pause or
            stop it in the Clock app.
          </p>
          <div className="form-actions">
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => onUseInApp(clockAppTimer.minutes)}
            >
              Use in-app timer instead
            </button>
            <button
              className="button secondary"
              disabled={saving}
              onClick={onDismissClockApp}
            >
              Start another timer
            </button>
          </div>
        </>
      ) : (
        <form
          className="timer-start"
          onSubmit={(event) => {
            event.preventDefault();
            onStart(Number(minutes));
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

function formatMinutes(minutes: number) {
  const seconds = Math.round(minutes * 60);
  if (seconds % 60) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `${seconds / 60} min`;
}
