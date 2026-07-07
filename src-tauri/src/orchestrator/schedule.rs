//! Pure scheduling logic for automations: given a [`Schedule`], the current
//! time, and the last-run time, decide whether an automation is **due**.
//!
//! Kept free of I/O and Tauri so it is deterministic and unit-testable. The
//! scheduler loop ([`crate::service`]) supplies the clock and persists results.
//!
//! Timestamps use the CLI's format (`state::now_ts`, `%Y-%m-%dT%H:%M:%S%z`), so
//! this module parses/handles fixed-offset local timestamps.

use chrono::{DateTime, FixedOffset, Utc};
use saffron::Cron;

use crate::config::Schedule;

/// The CLI timestamp format used across the app (`state::now_ts`).
pub const TS_FORMAT: &str = "%Y-%m-%dT%H:%M:%S%z";

/// Errors from evaluating a schedule.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ScheduleError {
    #[error("invalid cron expression: {0}")]
    InvalidCron(String),
}

/// Parse a CLI-format timestamp (`%Y-%m-%dT%H:%M:%S%z`) into a fixed-offset time.
pub fn parse_ts(ts: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_str(ts, TS_FORMAT).ok()
}

/// Whether an automation with this `schedule` is due at `now`, given the time
/// of its last run (`None` = never run / not yet seeded).
///
/// - **Interval**: **not** due when never run — a fresh interval is *seeded*
///   (its `last_run` set to now) by the scheduler so "every N" means N from
///   now, and app restarts don't re-fire it. Once seeded, it is due every
///   `secs` from the last run.
/// - **Cron**: due when a scheduled occurrence falls in `(base, now]`, where
///   `base` is the last run (or `now` when never run — so a fresh cron waits
///   for its next occurrence rather than firing instantly).
pub fn is_due(
    schedule: &Schedule,
    now: DateTime<FixedOffset>,
    last_run: Option<DateTime<FixedOffset>>,
) -> Result<bool, ScheduleError> {
    match schedule {
        Schedule::IntervalSecs { secs } => Ok(match last_run {
            None => false,
            Some(lr) => (now - lr).num_seconds() >= *secs as i64,
        }),
        Schedule::Cron { expr } => {
            let cron: Cron = expr
                .parse()
                .map_err(|_| ScheduleError::InvalidCron(expr.clone()))?;
            // `saffron` evaluates cron fields in UTC. To honour local wall-clock
            // semantics (a "0 9 * * *" schedule should fire at 09:00 *local*,
            // not 09:00 UTC), feed it each instant's local wall-clock time
            // reinterpreted as UTC, and compare on the same basis.
            let as_local_utc = |dt: DateTime<FixedOffset>| {
                DateTime::<Utc>::from_naive_utc_and_offset(dt.naive_local(), Utc)
            };
            let base = last_run.unwrap_or(now);
            match cron.next_after(as_local_utc(base)) {
                Some(next) => Ok(next <= as_local_utc(now)),
                None => Ok(false),
            }
        }
    }
}

/// The subset of `automations` that are enabled and due at `now` (by id), in
/// input order. Invalid schedules are treated as not-due (skipped).
pub fn due_automation_ids(
    automations: &[crate::config::Automation],
    now: DateTime<FixedOffset>,
) -> Vec<String> {
    automations
        .iter()
        .filter(|a| a.enabled)
        .filter(|a| {
            let last = a.last_run.as_deref().and_then(parse_ts);
            is_due(&a.schedule, now, last).unwrap_or(false)
        })
        .map(|a| a.id.clone())
        .collect()
}

/// Validate a schedule (used when creating/updating an automation).
pub fn validate(schedule: &Schedule) -> Result<(), ScheduleError> {
    match schedule {
        Schedule::IntervalSecs { .. } => Ok(()),
        Schedule::Cron { expr } => {
            let _cron: Cron = expr
                .parse()
                .map_err(|_| ScheduleError::InvalidCron(expr.clone()))?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Automation, AutomationTarget, TrustMode};

    fn ts(s: &str) -> DateTime<FixedOffset> {
        parse_ts(s).unwrap()
    }

    #[test]
    fn interval_fresh_is_not_due_until_seeded() {
        // A never-run interval is not due — the scheduler seeds it first, so
        // "every N" measures from now (and restarts don't re-fire it).
        let s = Schedule::IntervalSecs { secs: 60 };
        assert!(!is_due(&s, ts("2026-07-07T10:00:00+0000"), None).unwrap());
    }

    #[test]
    fn interval_not_due_before_elapsed_then_due_after() {
        let s = Schedule::IntervalSecs { secs: 300 };
        let last = ts("2026-07-07T10:00:00+0000");
        // 299s later → not due.
        assert!(!is_due(&s, ts("2026-07-07T10:04:59+0000"), Some(last)).unwrap());
        // 300s later → due (boundary inclusive).
        assert!(is_due(&s, ts("2026-07-07T10:05:00+0000"), Some(last)).unwrap());
        // Well after → due.
        assert!(is_due(&s, ts("2026-07-07T11:00:00+0000"), Some(last)).unwrap());
    }

    #[test]
    fn cron_due_when_occurrence_crossed_since_last_run() {
        // Every day at 09:00.
        let s = Schedule::Cron {
            expr: "0 9 * * *".into(),
        };
        let last = ts("2026-07-07T08:00:00+0000");
        // Before 09:00 → not due.
        assert!(!is_due(&s, ts("2026-07-07T08:30:00+0000"), Some(last)).unwrap());
        // After 09:00 → the 09:00 occurrence falls in (08:00, 09:05] → due.
        assert!(is_due(&s, ts("2026-07-07T09:05:00+0000"), Some(last)).unwrap());
    }

    #[test]
    fn cron_fresh_waits_for_next_occurrence() {
        // With no last_run, a daily cron should not fire instantly.
        let s = Schedule::Cron {
            expr: "0 9 * * *".into(),
        };
        assert!(!is_due(&s, ts("2026-07-07T12:00:00+0000"), None).unwrap());
    }

    #[test]
    fn cron_is_evaluated_in_local_wall_clock_not_utc() {
        // "09:00 every day" at a +0200 offset must fire at 09:00 *local*
        // (07:00 UTC), not 09:00 UTC. Evaluating in UTC would report not-due
        // here because 09:00 UTC (11:00 local) hasn't been reached yet.
        let s = Schedule::Cron {
            expr: "0 9 * * *".into(),
        };
        let last = ts("2026-07-07T08:00:00+0200");
        // 09:05 local → the 09:00 local occurrence has passed → due.
        assert!(is_due(&s, ts("2026-07-07T09:05:00+0200"), Some(last)).unwrap());
        // 08:30 local → before 09:00 local → not due.
        assert!(!is_due(&s, ts("2026-07-07T08:30:00+0200"), Some(last)).unwrap());
    }

    #[test]
    fn cron_every_minute_matches() {
        let s = Schedule::Cron {
            expr: "* * * * *".into(),
        };
        let last = ts("2026-07-07T10:00:00+0000");
        // One minute later, a minute boundary has passed → due.
        assert!(is_due(&s, ts("2026-07-07T10:01:30+0000"), Some(last)).unwrap());
    }

    #[test]
    fn invalid_cron_errors() {
        let s = Schedule::Cron {
            expr: "not a cron".into(),
        };
        assert!(matches!(
            is_due(&s, ts("2026-07-07T10:00:00+0000"), None),
            Err(ScheduleError::InvalidCron(_))
        ));
        assert!(validate(&s).is_err());
        assert!(validate(&Schedule::IntervalSecs { secs: 10 }).is_ok());
        assert!(validate(&Schedule::Cron {
            expr: "0 9 * * *".into()
        })
        .is_ok());
    }

    fn automation(
        id: &str,
        enabled: bool,
        schedule: Schedule,
        last_run: Option<&str>,
    ) -> Automation {
        Automation {
            id: id.into(),
            name: id.into(),
            enabled,
            prompt: "p".into(),
            schedule,
            target: AutomationTarget::ExistingSession {
                session_id: "s".into(),
            },
            trust: TrustMode::Ask,
            last_run: last_run.map(str::to_string),
            created: "2026-07-07T00:00:00+0000".into(),
        }
    }

    #[test]
    fn due_selection_filters_disabled_and_not_due() {
        let now = ts("2026-07-07T10:10:00+0000");
        let items = vec![
            // Enabled interval, last run 10 min ago, 5 min interval → due.
            automation(
                "due-interval",
                true,
                Schedule::IntervalSecs { secs: 300 },
                Some("2026-07-07T10:00:00+0000"),
            ),
            // Enabled interval, never run → NOT due (seeded first, not fired).
            automation(
                "fresh-interval",
                true,
                Schedule::IntervalSecs { secs: 300 },
                None,
            ),
            // Disabled → skipped even though it'd be due.
            automation(
                "disabled",
                false,
                Schedule::IntervalSecs { secs: 60 },
                Some("2026-07-07T09:00:00+0000"),
            ),
            // Enabled interval, ran 1 min ago, 1h interval → not due.
            automation(
                "not-yet",
                true,
                Schedule::IntervalSecs { secs: 3600 },
                Some("2026-07-07T10:09:00+0000"),
            ),
        ];
        let due = due_automation_ids(&items, now);
        assert_eq!(due, vec!["due-interval".to_string()]);
    }
}
