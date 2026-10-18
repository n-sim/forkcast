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
