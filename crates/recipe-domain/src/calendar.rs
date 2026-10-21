pub fn valid_date(date: &str) -> bool {
    let bytes = date.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = date[..4].parse().unwrap_or(0);
    let month: u32 = date[5..7].parse().unwrap_or(0);
    let day: u32 = date[8..].parse().unwrap_or(0);
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => 0,
    };
    year > 0 && day > 0 && day <= days
}

pub fn valid_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 2 || b.is_ascii_digit())
        && value[..2].parse::<u32>().is_ok_and(|hour| hour < 24)
        && value[3..].parse::<u32>().is_ok_and(|minute| minute < 60)
}

/// The coarse parts of the day a cooking can be planned for.
pub const COOKING_PERIODS: [&str; 3] = ["morning", "midday", "evening"];

/// A planned cooking time is a part of the day. Times of day saved by earlier
/// releases (`HH:MM`) remain valid so stored plans keep loading.
pub fn valid_cooking_time(value: &str) -> bool {
    COOKING_PERIODS.contains(&value) || valid_time(value)
}

/// Sort position of a planned cooking time within its day; unspecified last.
pub fn cooking_time_rank(value: Option<&str>) -> u8 {
    match value {
        Some("morning") => 1,
        Some("midday") => 2,
        Some("evening") => 3,
        Some(time) if valid_time(time) => match time[..2].parse::<u32>().unwrap_or(0) {
            0..=10 => 1,
            11..=15 => 2,
            _ => 3,
        },
        _ => 4,
    }
}

/// Days since 1970-01-01 of a valid local calendar date.
pub fn epoch_day(date: &str) -> Option<i64> {
    if !valid_date(date) {
        return None;
    }
    let (year, month, day): (i64, i64, i64) = (
        date[..4].parse().ok()?,
        date[5..7].parse().ok()?,
        date[8..].parse().ok()?,
    );
    // Howard Hinnant's days_from_civil.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some(era * 146_097 + day_of_era - 719_468)
}

/// The calendar date `days` after 1970-01-01, if it has a four-digit year.
pub fn date_of_epoch_day(days: i64) -> Option<String> {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (1..=9999)
        .contains(&year)
        .then(|| format!("{year:04}-{month:02}-{day:02}"))
}

/// The English weekday name of a valid calendar date.
pub fn weekday(date: &str) -> Option<&'static str> {
    const NAMES: [&str; 7] = [
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
    ];
    epoch_day(date).map(|day| NAMES[day.rem_euclid(7) as usize])
}

/// Every date from `start` to `end` inclusive, or `None` when either is
/// invalid, the period is reversed, or it is longer than `max_days`.
pub fn dates_between(start: &str, end: &str, max_days: usize) -> Option<Vec<String>> {
    let (first, last) = (epoch_day(start)?, epoch_day(end)?);
    if last < first || (last - first) as usize >= max_days {
        return None;
    }
    (first..=last).map(date_of_epoch_day).collect()
}
