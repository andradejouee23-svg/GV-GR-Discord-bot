const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('../../config');

function createDatabase(databasePath = config.DATABASE_PATH) {
  const resolvedPath = path.resolve(databasePath);
  const db = new Database(resolvedPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      role_name TEXT NOT NULL,
      first_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES staff(user_id),
      username TEXT NOT NULL,
      role_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_shift_per_staff
      ON shifts(user_id) WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS shifts_user_started
      ON shifts(user_id, started_at);

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      host_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_seconds INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed'))
    );

    CREATE TABLE IF NOT EXISTS session_participants (
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (session_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      host_id TEXT NOT NULL,
      host_name TEXT NOT NULL,
      starts_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled', 'cancelled', 'completed')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_attendance (
      event_id INTEGER NOT NULL REFERENCES events(id),
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      response TEXT NOT NULL CHECK(response IN ('going', 'cant_go')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS event_reminders (
      event_id INTEGER NOT NULL REFERENCES events(id),
      reminder_type TEXT NOT NULL CHECK(reminder_type IN ('one_hour', 'fifteen_minutes', 'started')),
      attempted_at TEXT NOT NULL,
      delivery_status TEXT NOT NULL CHECK(delivery_status IN ('sent', 'failed')),
      PRIMARY KEY (event_id, reminder_type)
    );

    CREATE TABLE IF NOT EXISTS event_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL REFERENCES events(id),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS event_drafts (
      draft_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_drafts (
      draft_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS warnings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      moderator_id TEXT NOT NULL,
      moderator_name TEXT NOT NULL,
      reason TEXT NOT NULL,
      warning_number INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      author_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_id TEXT NOT NULL,
      reporter_name TEXT NOT NULL,
      reported_player TEXT NOT NULL,
      reason TEXT NOT NULL,
      description TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reviewing', 'resolved', 'rejected')),
      reviewer_id TEXT,
      channel_id TEXT,
      message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS moderation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      staff_id TEXT NOT NULL,
      staff_name TEXT NOT NULL,
      target_id TEXT,
      target_name TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_profiles (
      user_id TEXT PRIMARY KEY REFERENCES staff(user_id),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'break', 'suspended', 'demoted', 'removed')),
      status_until TEXT,
      status_reason TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_points_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES staff(user_id),
      amount INTEGER NOT NULL CHECK(amount != 0),
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      actor_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_hour_reward_per_shift
      ON staff_points_ledger(user_id, source_id) WHERE source_type = 'shift_hours';

    CREATE UNIQUE INDEX IF NOT EXISTS one_report_bonus_per_report
      ON staff_points_ledger(user_id, source_id) WHERE source_type = 'daily_report';

    CREATE INDEX IF NOT EXISTS points_user_created
      ON staff_points_ledger(user_id, created_at);

    CREATE TABLE IF NOT EXISTS daily_rp_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES staff(user_id),
      shift_id INTEGER NOT NULL UNIQUE REFERENCES shifts(id),
      report_date TEXT NOT NULL,
      shift_seconds INTEGER NOT NULL CHECK(shift_seconds >= 0),
      rating TEXT NOT NULL CHECK(rating IN ('great', 'good', 'okay', 'bad')),
      explanation TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(user_id, report_date)
    );

    CREATE TABLE IF NOT EXISTS staff_weekly_awards (
      week_start TEXT PRIMARY KEY,
      user_id TEXT REFERENCES staff(user_id),
      hours_seconds INTEGER NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      reports INTEGER NOT NULL DEFAULT 0,
      announcement_message_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_shift_reminders (
      shift_id INTEGER PRIMARY KEY REFERENCES shifts(id),
      last_attempt_at TEXT NOT NULL,
      message_id TEXT,
      delivery_status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_report_reminders (
      shift_id INTEGER PRIMARY KEY REFERENCES shifts(id),
      last_attempt_at TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT,
      delivery_status TEXT NOT NULL CHECK(delivery_status IN ('sent', 'failed', 'completed'))
    );

    CREATE TABLE IF NOT EXISTS staff_weekly_goal_reminders (
      user_id TEXT NOT NULL REFERENCES staff(user_id),
      week_start TEXT NOT NULL,
      last_attempt_at TEXT NOT NULL,
      message_id TEXT,
      delivery_status TEXT NOT NULL CHECK(delivery_status IN ('sent', 'failed')),
      PRIMARY KEY (user_id, week_start)
    );

    CREATE TABLE IF NOT EXISTS staff_streak_resets (
      user_id TEXT PRIMARY KEY REFERENCES staff(user_id),
      reset_before_date TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_pending_actions (
      action_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      target_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'cancelled', 'expired')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_temporary_roles (
      user_id TEXT NOT NULL REFERENCES staff(user_id),
      role_id TEXT NOT NULL,
      action TEXT NOT NULL,
      restore_at TEXT NOT NULL,
      PRIMARY KEY (user_id, role_id, action)
    );

    CREATE TABLE IF NOT EXISTS staff_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      previous_value TEXT,
      new_value TEXT,
      duration_seconds INTEGER,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS staff_audit_target_created
      ON staff_audit_logs(target_id, created_at);
  `);

  const addColumns = (table, columns) => {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  };
  addColumns('events', {
    event_code: 'TEXT', event_type: "TEXT NOT NULL DEFAULT 'Other'", duration_minutes: 'INTEGER NOT NULL DEFAULT 120',
    voice_channel_id: 'TEXT', announcement_channel_id: 'TEXT', announcement_message_id: 'TEXT', edited_at: 'TEXT',
    time_zone: "TEXT NOT NULL DEFAULT 'UTC'",
  });
  addColumns('sessions', {
    session_code: 'TEXT', rp_type: "TEXT NOT NULL DEFAULT 'General RP'", activity: "TEXT NOT NULL DEFAULT ''",
    expected_duration: "TEXT NOT NULL DEFAULT ''", voice_channel_id: 'TEXT', announcement_channel_id: 'TEXT',
    lifecycle_status: "TEXT NOT NULL DEFAULT 'active'", session_start_label: "TEXT NOT NULL DEFAULT ''",
    paused_at: 'TEXT', paused_seconds: 'INTEGER NOT NULL DEFAULT 0', time_zone: "TEXT NOT NULL DEFAULT 'UTC'",
  });
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS events_event_code_unique ON events(event_code);
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_code_unique ON sessions(session_code);
    CREATE INDEX IF NOT EXISTS events_status_starts_at ON events(status, starts_at);
    CREATE INDEX IF NOT EXISTS event_history_event_created ON event_history(event_id, created_at);
  `);
  for (const event of db.prepare('SELECT id FROM events WHERE event_code IS NULL').all()) {
    db.prepare('UPDATE events SET event_code = ? WHERE id = ?').run(`GV-EV-${String(event.id).padStart(4, '0')}`, event.id);
  }
  for (const session of db.prepare('SELECT id FROM sessions WHERE session_code IS NULL').all()) {
    db.prepare('UPDATE sessions SET session_code = ? WHERE id = ?').run(`GV-RP-${String(session.id).padStart(4, '0')}`, session.id);
  }

  return db;
}

module.exports = { createDatabase };