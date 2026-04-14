use crate::storage;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct CacheState(pub Mutex<Option<Connection>>);

impl CacheState {
    pub fn new() -> Self {
        CacheState(Mutex::new(None))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedSession {
    pub id: String,
    pub started_at: String,
    pub ended_at: String,
    pub duration_sec: i64,
    pub mode: String,
    pub tags: Vec<String>,
    pub questions_done: i64,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionDetail {
    #[serde(flatten)]
    pub session: CachedSession,
    pub intervals: Vec<IntervalView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntervalView {
    #[serde(rename = "type")]
    pub interval_type: String,
    pub start_sec: i64,
    pub end_sec: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TodayStats {
    pub focus_sec: i64,
    pub session_count: i64,
    pub questions_done: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DailyBucket {
    pub date: String,
    pub focus_sec: i64,
    pub session_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TagShare {
    pub tag: String,
    pub focus_sec: i64,
    pub session_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HeatmapCell {
    pub date: String,
    pub focus_sec: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct LifetimeTotals {
    pub longest_session_sec: i64,
    pub best_day_date: Option<String>,
    pub best_day_focus_sec: i64,
    pub all_time_focus_sec: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RangeStats {
    pub total_focus_sec: i64,
    pub total_sessions: i64,
    pub total_questions: i64,
    pub current_streak: i64,
    pub longest_streak: i64,
    pub daily: Vec<DailyBucket>,
    pub tags: Vec<TagShare>,
}

fn cache_path() -> Result<PathBuf, String> {
    Ok(storage::flint_dir()?.join("cache.db"))
}

fn sessions_dir() -> Result<PathBuf, String> {
    Ok(storage::flint_dir()?.join("sessions"))
}

fn open_connection() -> Result<Connection, String> {
    let conn = Connection::open(cache_path()?).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.pragma_update(None, "synchronous", "NORMAL").ok();
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            ended_at TEXT NOT NULL,
            duration_sec INTEGER NOT NULL,
            mode TEXT NOT NULL,
            tags TEXT NOT NULL,
            questions_done INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 1,
            intervals TEXT NOT NULL DEFAULT '[]'
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_tags ON sessions(tags);
        "#,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn count_session_files() -> Result<i64, String> {
    let dir = sessions_dir()?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(0);
    };
    let mut count: i64 = 0;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|s| s.to_str()) == Some("json") {
            count += 1;
        }
    }
    Ok(count)
}

fn row_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn parse_session_json(
    value: &serde_json::Value,
) -> Option<(CachedSession, Vec<IntervalView>)> {
    let id = value.get("id")?.as_str()?.to_string();
    let started_at = value.get("started_at")?.as_str()?.to_string();
    let ended_at = value
        .get("ended_at")
        .and_then(|v| v.as_str())
        .unwrap_or(&started_at)
        .to_string();
    let duration_sec = value
        .get("duration_sec")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let mode = value
        .get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("stopwatch")
        .to_string();
    let tags = value
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let questions_done = value
        .get("questions_done")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let completed = value
        .get("completed")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let intervals = value
        .get("intervals")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|iv| {
                    let interval_type = iv
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("focus")
                        .to_string();
                    let start_sec = iv.get("start_sec").and_then(|v| v.as_i64()).unwrap_or(0);
                    let end_sec = iv.get("end_sec").and_then(|v| v.as_i64()).unwrap_or(0);
                    Some(IntervalView {
                        interval_type,
                        start_sec,
                        end_sec,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some((
        CachedSession {
            id,
            started_at,
            ended_at,
            duration_sec,
            mode,
            tags,
            questions_done,
            completed,
        },
        intervals,
    ))
}

fn insert_session(
    conn: &Connection,
    session: &CachedSession,
    intervals: &[IntervalView],
) -> Result<(), String> {
    let tags_json = serde_json::to_string(&session.tags).unwrap_or_else(|_| "[]".into());
    let intervals_json = serde_json::to_string(intervals).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT OR REPLACE INTO sessions (id, started_at, ended_at, duration_sec, mode, tags, questions_done, completed, intervals) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            session.id,
            session.started_at,
            session.ended_at,
            session.duration_sec,
            session.mode,
            tags_json,
            session.questions_done,
            session.completed as i64,
            intervals_json,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn rebuild(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM sessions", [])
        .map_err(|e| e.to_string())?;
    let dir = sessions_dir()?;
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => {
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(());
        }
    };
    let mut inserted = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
            continue;
        };
        let Some((session, intervals)) = parse_session_json(&value) else {
            continue;
        };
        let tags_json = serde_json::to_string(&session.tags).unwrap_or_else(|_| "[]".into());
        let intervals_json = serde_json::to_string(&intervals).unwrap_or_else(|_| "[]".into());
        tx.execute(
            "INSERT OR REPLACE INTO sessions (id, started_at, ended_at, duration_sec, mode, tags, questions_done, completed, intervals) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                session.id,
                session.started_at,
                session.ended_at,
                session.duration_sec,
                session.mode,
                tags_json,
                session.questions_done,
                session.completed as i64,
                intervals_json,
            ],
        )
        .map_err(|e| e.to_string())?;
        inserted += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    println!("[flint] cache rebuilt: {} session(s)", inserted);
    Ok(())
}

pub fn initialize() -> Result<Connection, String> {
    let mut conn = open_connection()?;
    ensure_schema(&conn)?;
    let file_count = count_session_files()?;
    let rows = row_count(&conn)?;
    if file_count != rows {
        println!(
            "[flint] cache drift ({} files vs {} rows) — rebuilding",
            file_count, rows
        );
        rebuild(&mut conn)?;
    }
    Ok(conn)
}

pub fn upsert_from_file(
    conn: &Connection,
    session_json: &serde_json::Value,
) -> Result<(), String> {
    if let Some((session, intervals)) = parse_session_json(session_json) {
        insert_session(conn, &session, &intervals)?;
    }
    Ok(())
}

fn row_to_session(row: &rusqlite::Row<'_>) -> rusqlite::Result<CachedSession> {
    let tags_raw: String = row.get("tags")?;
    let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
    let completed_raw: i64 = row.get("completed")?;
    Ok(CachedSession {
        id: row.get("id")?,
        started_at: row.get("started_at")?,
        ended_at: row.get("ended_at")?,
        duration_sec: row.get("duration_sec")?,
        mode: row.get("mode")?,
        tags,
        questions_done: row.get("questions_done")?,
        completed: completed_raw != 0,
    })
}

pub fn list_sessions(
    conn: &Connection,
    limit: Option<i64>,
) -> Result<Vec<CachedSession>, String> {
    let sql = match limit {
        Some(_) => "SELECT id, started_at, ended_at, duration_sec, mode, tags, questions_done, completed FROM sessions ORDER BY started_at DESC LIMIT ?1".to_string(),
        None => "SELECT id, started_at, ended_at, duration_sec, mode, tags, questions_done, completed FROM sessions ORDER BY started_at DESC".to_string(),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = if let Some(l) = limit {
        stmt.query_map(params![l], row_to_session)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], row_to_session)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    Ok(rows)
}

pub fn get_session_detail(conn: &Connection, id: &str) -> Result<Option<SessionDetail>, String> {
    let mut stmt = conn
        .prepare("SELECT id, started_at, ended_at, duration_sec, mode, tags, questions_done, completed, intervals FROM sessions WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params![id]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let tags_raw: String = row.get("tags").map_err(|e| e.to_string())?;
        let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
        let completed_raw: i64 = row.get("completed").map_err(|e| e.to_string())?;
        let intervals_raw: String = row.get("intervals").map_err(|e| e.to_string())?;
        let intervals: Vec<IntervalView> =
            serde_json::from_str(&intervals_raw).unwrap_or_default();
        Ok(Some(SessionDetail {
            session: CachedSession {
                id: row.get("id").map_err(|e| e.to_string())?,
                started_at: row.get("started_at").map_err(|e| e.to_string())?,
                ended_at: row.get("ended_at").map_err(|e| e.to_string())?,
                duration_sec: row.get("duration_sec").map_err(|e| e.to_string())?,
                mode: row.get("mode").map_err(|e| e.to_string())?,
                tags,
                questions_done: row.get("questions_done").map_err(|e| e.to_string())?,
                completed: completed_raw != 0,
            },
            intervals,
        }))
    } else {
        Ok(None)
    }
}

fn parse_started(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

fn focus_sec_for_session(duration_sec: i64, intervals_raw: &str) -> i64 {
    // Sum focus intervals if present; fall back to total duration if not.
    let Ok(intervals) = serde_json::from_str::<Vec<IntervalView>>(intervals_raw) else {
        return duration_sec;
    };
    if intervals.is_empty() {
        return duration_sec;
    }
    let focus: i64 = intervals
        .iter()
        .filter(|i| i.interval_type == "focus")
        .map(|i| (i.end_sec - i.start_sec).max(0))
        .sum();
    if focus == 0 {
        duration_sec
    } else {
        focus
    }
}

pub fn today_stats(conn: &Connection, now: DateTime<Utc>) -> Result<TodayStats, String> {
    let start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();
    let end = start + Duration::days(1);
    let mut stmt = conn
        .prepare("SELECT duration_sec, questions_done, intervals FROM sessions WHERE started_at >= ?1 AND started_at < ?2 AND completed = 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![start.to_rfc3339(), end.to_rfc3339()])
        .map_err(|e| e.to_string())?;
    let mut out = TodayStats {
        focus_sec: 0,
        session_count: 0,
        questions_done: 0,
    };
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let duration_sec: i64 = row.get(0).map_err(|e| e.to_string())?;
        let questions_done: i64 = row.get(1).map_err(|e| e.to_string())?;
        let intervals_raw: String = row.get(2).map_err(|e| e.to_string())?;
        out.focus_sec += focus_sec_for_session(duration_sec, &intervals_raw);
        out.session_count += 1;
        out.questions_done += questions_done;
    }
    Ok(out)
}

fn compute_streaks(days_with_focus: &[NaiveDate], today: NaiveDate) -> (i64, i64) {
    if days_with_focus.is_empty() {
        return (0, 0);
    }
    let mut sorted: Vec<NaiveDate> = days_with_focus.to_vec();
    sorted.sort();
    sorted.dedup();

    let mut longest: i64 = 1;
    let mut run: i64 = 1;
    for i in 1..sorted.len() {
        let prev = sorted[i - 1];
        let cur = sorted[i];
        if cur == prev + Duration::days(1) {
            run += 1;
            if run > longest {
                longest = run;
            }
        } else {
            run = 1;
        }
    }

    // current streak: counts backward from today (or yesterday if nothing today yet)
    let set: std::collections::HashSet<NaiveDate> = sorted.iter().copied().collect();
    let mut current: i64 = 0;
    let mut cursor = today;
    if !set.contains(&cursor) {
        cursor = cursor - Duration::days(1);
    }
    while set.contains(&cursor) {
        current += 1;
        cursor = cursor - Duration::days(1);
    }
    (current, longest)
}

pub fn range_stats(
    conn: &Connection,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
) -> Result<RangeStats, String> {
    let mut stmt = conn
        .prepare("SELECT started_at, duration_sec, questions_done, tags, intervals FROM sessions WHERE started_at >= ?1 AND started_at < ?2 AND completed = 1 ORDER BY started_at ASC")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![start.to_rfc3339(), end.to_rfc3339()])
        .map_err(|e| e.to_string())?;

    let mut total_focus_sec: i64 = 0;
    let mut total_sessions: i64 = 0;
    let mut total_questions: i64 = 0;
    let mut daily_map: BTreeMap<NaiveDate, (i64, i64)> = BTreeMap::new();
    let mut tag_map: HashMap<String, (i64, i64)> = HashMap::new();
    let mut days_with_focus: Vec<NaiveDate> = Vec::new();

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let started_raw: String = row.get(0).map_err(|e| e.to_string())?;
        let duration_sec: i64 = row.get(1).map_err(|e| e.to_string())?;
        let questions_done: i64 = row.get(2).map_err(|e| e.to_string())?;
        let tags_raw: String = row.get(3).map_err(|e| e.to_string())?;
        let intervals_raw: String = row.get(4).map_err(|e| e.to_string())?;

        let Some(started) = parse_started(&started_raw) else {
            continue;
        };
        let focus = focus_sec_for_session(duration_sec, &intervals_raw);
        if focus <= 0 {
            continue;
        }
        let day = started.date_naive();

        total_focus_sec += focus;
        total_sessions += 1;
        total_questions += questions_done;

        let bucket = daily_map.entry(day).or_insert((0, 0));
        bucket.0 += focus;
        bucket.1 += 1;
        days_with_focus.push(day);

        let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
        if tags.is_empty() {
            let t = tag_map.entry("untagged".into()).or_insert((0, 0));
            t.0 += focus;
            t.1 += 1;
        } else {
            for tag in tags {
                let t = tag_map.entry(tag).or_insert((0, 0));
                t.0 += focus;
                t.1 += 1;
            }
        }
    }

    // Fill daily buckets across the range so the chart has zero-days too.
    let start_day = start.date_naive();
    let end_day = (end - Duration::seconds(1)).date_naive();
    let mut daily: Vec<DailyBucket> = Vec::new();
    let mut cursor = start_day;
    while cursor <= end_day {
        let (focus_sec, session_count) = daily_map.get(&cursor).copied().unwrap_or((0, 0));
        daily.push(DailyBucket {
            date: cursor.format("%Y-%m-%d").to_string(),
            focus_sec,
            session_count,
        });
        cursor = cursor + Duration::days(1);
    }

    let mut tags: Vec<TagShare> = tag_map
        .into_iter()
        .map(|(tag, (focus_sec, session_count))| TagShare {
            tag,
            focus_sec,
            session_count,
        })
        .collect();
    tags.sort_by(|a, b| b.focus_sec.cmp(&a.focus_sec));

    // Streaks computed against today, regardless of the range window.
    let today = Utc::now().date_naive();
    // Pull *all* session days up to today for an accurate streak, not just in-range.
    let all_days = all_session_days(conn)?;
    let (current_streak, longest_streak) = compute_streaks(&all_days, today);

    // Longest streak should also take into account the full history to be meaningful.
    let (_, longest_all) = compute_streaks(&days_with_focus, today);
    let longest_streak = longest_streak.max(longest_all);

    Ok(RangeStats {
        total_focus_sec,
        total_sessions,
        total_questions,
        current_streak,
        longest_streak,
        daily,
        tags,
    })
}

fn all_session_days(conn: &Connection) -> Result<Vec<NaiveDate>, String> {
    let mut stmt = conn
        .prepare("SELECT started_at, duration_sec, intervals FROM sessions WHERE completed = 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut out: Vec<NaiveDate> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let started_raw: String = row.get(0).map_err(|e| e.to_string())?;
        let duration_sec: i64 = row.get(1).map_err(|e| e.to_string())?;
        let intervals_raw: String = row.get(2).map_err(|e| e.to_string())?;
        if let Some(dt) = parse_started(&started_raw) {
            if focus_sec_for_session(duration_sec, &intervals_raw) > 0 {
                out.push(dt.date_naive());
            }
        }
    }
    Ok(out)
}

pub fn heatmap(conn: &Connection, days: i64) -> Result<Vec<HeatmapCell>, String> {
    let end_day = Utc::now().date_naive();
    let start_day = end_day - Duration::days(days - 1);
    let start_dt = start_day.and_hms_opt(0, 0, 0).unwrap().and_utc();
    let end_dt = (end_day + Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc();

    let mut stmt = conn
        .prepare("SELECT started_at, duration_sec, intervals FROM sessions WHERE started_at >= ?1 AND started_at < ?2 AND completed = 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(params![start_dt.to_rfc3339(), end_dt.to_rfc3339()])
        .map_err(|e| e.to_string())?;

    let mut by_day: BTreeMap<NaiveDate, i64> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let started_raw: String = row.get(0).map_err(|e| e.to_string())?;
        let duration_sec: i64 = row.get(1).map_err(|e| e.to_string())?;
        let intervals_raw: String = row.get(2).map_err(|e| e.to_string())?;
        let Some(dt) = parse_started(&started_raw) else {
            continue;
        };
        let focus = focus_sec_for_session(duration_sec, &intervals_raw);
        if focus <= 0 {
            continue;
        }
        *by_day.entry(dt.date_naive()).or_insert(0) += focus;
    }

    let mut cells: Vec<HeatmapCell> = Vec::with_capacity(days as usize);
    let mut cursor = start_day;
    while cursor <= end_day {
        cells.push(HeatmapCell {
            date: cursor.format("%Y-%m-%d").to_string(),
            focus_sec: by_day.get(&cursor).copied().unwrap_or(0),
        });
        cursor = cursor + Duration::days(1);
    }
    Ok(cells)
}

pub fn lifetime_totals(conn: &Connection) -> Result<LifetimeTotals, String> {
    let mut stmt = conn
        .prepare("SELECT started_at, duration_sec, intervals FROM sessions WHERE completed = 1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;

    let mut longest: i64 = 0;
    let mut total: i64 = 0;
    let mut by_day: HashMap<NaiveDate, i64> = HashMap::new();

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let started_raw: String = row.get(0).map_err(|e| e.to_string())?;
        let duration_sec: i64 = row.get(1).map_err(|e| e.to_string())?;
        let intervals_raw: String = row.get(2).map_err(|e| e.to_string())?;
        let focus = focus_sec_for_session(duration_sec, &intervals_raw);
        if focus <= 0 {
            continue;
        }
        if focus > longest {
            longest = focus;
        }
        total += focus;
        if let Some(dt) = parse_started(&started_raw) {
            *by_day.entry(dt.date_naive()).or_insert(0) += focus;
        }
    }

    let (best_day_date, best_day_focus_sec) = by_day
        .into_iter()
        .max_by_key(|(_, v)| *v)
        .map(|(date, focus)| (Some(date.format("%Y-%m-%d").to_string()), focus))
        .unwrap_or((None, 0));

    Ok(LifetimeTotals {
        longest_session_sec: longest,
        best_day_date,
        best_day_focus_sec,
        all_time_focus_sec: total,
    })
}

pub fn month_range(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let first = NaiveDate::from_ymd_opt(now.year(), now.month(), 1).unwrap();
    let next_month = if now.month() == 12 {
        NaiveDate::from_ymd_opt(now.year() + 1, 1, 1).unwrap()
    } else {
        NaiveDate::from_ymd_opt(now.year(), now.month() + 1, 1).unwrap()
    };
    (
        first.and_hms_opt(0, 0, 0).unwrap().and_utc(),
        next_month.and_hms_opt(0, 0, 0).unwrap().and_utc(),
    )
}

pub fn week_range(now: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    // Week = last 7 days including today, starting from today - 6.
    let end_day = now.date_naive() + Duration::days(1);
    let start_day = now.date_naive() - Duration::days(6);
    (
        start_day.and_hms_opt(0, 0, 0).unwrap().and_utc(),
        end_day.and_hms_opt(0, 0, 0).unwrap().and_utc(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaks_empty() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 15).unwrap();
        assert_eq!(compute_streaks(&[], today), (0, 0));
    }

    #[test]
    fn streaks_three_in_a_row_ending_today() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 15).unwrap();
        let days = vec![
            NaiveDate::from_ymd_opt(2026, 4, 13).unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 14).unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 15).unwrap(),
        ];
        let (current, longest) = compute_streaks(&days, today);
        assert_eq!(current, 3);
        assert_eq!(longest, 3);
    }

    #[test]
    fn streaks_broken_but_yesterday_ok() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 15).unwrap();
        let days = vec![
            NaiveDate::from_ymd_opt(2026, 4, 13).unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 14).unwrap(),
        ];
        let (current, longest) = compute_streaks(&days, today);
        assert_eq!(current, 2);
        assert_eq!(longest, 2);
    }

    #[test]
    fn streaks_gap_drops_run() {
        let today = NaiveDate::from_ymd_opt(2026, 4, 15).unwrap();
        let days = vec![
            NaiveDate::from_ymd_opt(2026, 4, 10).unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 11).unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 14).unwrap(),
            NaiveDate::from_ymd_opt(2026, 4, 15).unwrap(),
        ];
        let (current, longest) = compute_streaks(&days, today);
        assert_eq!(current, 2);
        assert_eq!(longest, 2);
    }

    #[test]
    fn focus_sec_falls_back_to_duration() {
        assert_eq!(focus_sec_for_session(1500, "[]"), 1500);
    }

    #[test]
    fn focus_sec_sums_focus_intervals() {
        let raw = r#"[{"type":"focus","start_sec":0,"end_sec":1500},{"type":"break","start_sec":1500,"end_sec":1800},{"type":"focus","start_sec":1800,"end_sec":2700}]"#;
        assert_eq!(focus_sec_for_session(2700, raw), 2400);
    }
}
