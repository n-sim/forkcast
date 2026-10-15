use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepTimer {
    duration_ms: f64,
    remaining_ms: f64,
    ends_at: Option<f64>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum TimerAction {
    Start { minutes: f64 },
    Pause,
    Resume,
    Reset,
}

impl StepTimer {
    fn validate(&self) -> Result<(), String> {
        if !self.duration_ms.is_finite()
            || self.duration_ms <= 0.0
            || !self.remaining_ms.is_finite()
            || !(0.0..=self.duration_ms).contains(&self.remaining_ms)
            || self.ends_at.is_some_and(|end| !end.is_finite())
        {
            return Err("This step timer could not be read.".to_owned());
        }
        Ok(())
    }

    /// Deadlines survive closing the view; only the foreground UI announces expiry.
    pub fn remaining(&self, now: f64) -> Result<f64, String> {
        self.validate()?;
        if !now.is_finite() {
            return Err("The current time could not be read.".to_owned());
        }
        Ok(self.ends_at.map_or(self.remaining_ms, |end| {
            (end - now).clamp(0.0, self.duration_ms)
        }))
    }
}

pub fn update_step_timer(
    timer: Option<StepTimer>,
    action: TimerAction,
    now: f64,
) -> Result<StepTimer, String> {
    if !now.is_finite() {
        return Err("The current time could not be read.".to_owned());
    }
    if let TimerAction::Start { minutes } = action {
        let duration_ms = minutes * 60_000.0;
        if !duration_ms.is_finite() || duration_ms <= 0.0 || !(now + duration_ms).is_finite() {
            return Err(
                "Timer minutes must be greater than zero and within the supported range."
                    .to_owned(),
            );
        }
        return Ok(StepTimer {
            duration_ms,
            remaining_ms: duration_ms,
            ends_at: Some(now + duration_ms),
        });
    }
    let mut timer = timer.ok_or("Start a timer for this step first.")?;
    let remaining = timer.remaining(now)?;
    match action {
        TimerAction::Pause => {
            timer.remaining_ms = remaining;
            timer.ends_at = None;
        }
        TimerAction::Resume => {
            if remaining <= 0.0 {
                return Err("Reset the finished timer before resuming it.".to_owned());
            }
            timer.remaining_ms = remaining;
            timer.ends_at = Some(now + remaining);
        }
        TimerAction::Reset => {
            timer.remaining_ms = timer.duration_ms;
            timer.ends_at = None;
        }
        TimerAction::Start { .. } => unreachable!(),
    }
    timer.validate()?;
    Ok(timer)
}
