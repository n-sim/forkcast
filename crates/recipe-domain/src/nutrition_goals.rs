use crate::{calendar::valid_date, nutrition::Nutrition, recipe::FieldError};
use serde::{Deserialize, Serialize};

/// A person's daily nutrition targets from a local calendar date until the
/// next set takes effect. Earlier sets are kept, so a past day is always
/// compared against the targets that applied on it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NutritionGoals {
    pub effective_from: String,
    /// A blank target sets no goal for that nutrient.
    pub targets: Nutrition,
}

pub fn validate_goals(goals: NutritionGoals) -> Result<NutritionGoals, Vec<FieldError>> {
    let mut errors = vec![];
    if !valid_date(&goals.effective_from) {
        errors.push(FieldError {
            path: "effectiveFrom".into(),
            message: "Choose the date these goals apply from.".into(),
        });
    }
    let targets = [
        ("calories", "Calories", goals.targets.calories),
        ("protein", "Protein", goals.targets.protein),
        ("fat", "Fat", goals.targets.fat),
        (
            "carbohydrates",
            "Carbohydrates",
            goals.targets.carbohydrates,
        ),
    ];
    for (path, label, value) in targets {
        if value.is_some_and(|value| !value.is_finite() || value <= 0.0) {
            errors.push(FieldError {
                path: format!("targets.{path}"),
                message: format!("{label} goal must be greater than zero, or left blank."),
            });
        }
    }
    if targets.iter().all(|(_, _, value)| value.is_none()) {
        errors.push(FieldError {
            path: "targets.calories".into(),
            message: "Set at least one daily goal.".into(),
        });
    }
    if errors.is_empty() {
        Ok(goals)
    } else {
        Err(errors)
    }
}

/// The goals in effect on `date`: the set with the latest effective date on
/// or before it. Days before the first set have no goals.
pub fn applicable_goals<'a>(
    history: &'a [NutritionGoals],
    date: &str,
) -> Option<&'a NutritionGoals> {
    // ISO dates order chronologically as text.
    history
        .iter()
        .filter(|goals| goals.effective_from.as_str() <= date)
        .max_by(|a, b| a.effective_from.cmp(&b.effective_from))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goals(effective_from: &str, calories: f64) -> NutritionGoals {
        NutritionGoals {
            effective_from: effective_from.into(),
            targets: Nutrition {
                calories: Some(calories),
                ..Nutrition::default()
            },
        }
    }

    #[test]
    fn each_day_uses_the_latest_goals_that_had_taken_effect() {
        let history = [goals("2030-05-10", 1800.0), goals("2030-05-01", 2000.0)];
        assert_eq!(applicable_goals(&history, "2030-04-30"), None);
        assert_eq!(applicable_goals(&history, "2030-05-01"), Some(&history[1]));
        assert_eq!(applicable_goals(&history, "2030-05-09"), Some(&history[1]));
        assert_eq!(applicable_goals(&history, "2030-05-10"), Some(&history[0]));
        assert_eq!(applicable_goals(&history, "2031-01-01"), Some(&history[0]));
    }

    #[test]
    fn goals_need_a_date_and_at_least_one_positive_target() {
        assert!(validate_goals(goals("2030-05-01", 2000.0)).is_ok());
        let errors = validate_goals(goals("2030-02-30", 0.0)).unwrap_err();
        let paths: Vec<_> = errors.iter().map(|error| error.path.as_str()).collect();
        assert_eq!(paths, ["effectiveFrom", "targets.calories"]);
        let errors = validate_goals(NutritionGoals {
            effective_from: "2030-05-01".into(),
            targets: Nutrition::default(),
        })
        .unwrap_err();
        assert_eq!(errors[0].message, "Set at least one daily goal.");
    }
}
