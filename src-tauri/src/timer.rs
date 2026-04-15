use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TimerStatus {
    Idle,
    Running,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interval {
    #[serde(rename = "type")]
    pub interval_type: String,
    pub start_sec: u64,
    pub elapsed_sec: u64,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_sec: Option<u64>,
    #[serde(skip)]
    pub ended_emitted: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimerState {
    pub status: TimerStatus,
    pub session_id: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub elapsed_sec: u64,
    pub questions_done: u32,
    pub mode: String,
    pub tags: Vec<String>,
    pub current_interval: Option<Interval>,
    pub completed_intervals: Vec<Interval>,
    #[serde(skip)]
    pub recovery_pending: bool,
    // FIX 1: rate-limit guard for interval transitions — set on each
    // successful `next_interval` and checked on entry to reject re-entrant
    // calls from a misbehaving plugin that stacks up transition events.
    // Instant doesn't serialise, so it's runtime-only and lost on restart,
    // which is fine: after a relaunch there's no rapid-fire loop to guard
    // against.
    #[serde(skip)]
    pub last_interval_transition_at: Option<Instant>,
}

impl TimerState {
    pub fn idle() -> Self {
        Self {
            status: TimerStatus::Idle,
            session_id: None,
            started_at: None,
            elapsed_sec: 0,
            questions_done: 0,
            mode: String::new(),
            tags: Vec::new(),
            current_interval: None,
            completed_intervals: Vec::new(),
            recovery_pending: false,
            last_interval_transition_at: None,
        }
    }

    pub fn reset(&mut self) {
        *self = Self::idle();
    }
}
