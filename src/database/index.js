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

    CREATE TABLE IF NOT EXISTS announcement_drafts (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('draft', 'publishing', 'published', 'failed', 'cancelled', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT
    );

    CREATE INDEX IF NOT EXISTS announcement_drafts_expiry
      ON announcement_drafts(status, expires_at);

    CREATE TABLE IF NOT EXISTS vehicle_application_drafts (
      id TEXT PRIMARY KEY,
      applicant_id TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS vehicle_application_drafts_expiry
      ON vehicle_application_drafts(expires_at);

    CREATE TABLE IF NOT EXISTS vehicle_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      make_model TEXT NOT NULL,
      plate TEXT NOT NULL,
      plate_normalized TEXT NOT NULL,
      plate_key TEXT NOT NULL,
      registration_state TEXT NOT NULL,
      color TEXT NOT NULL,
      vehicle_year INTEGER NOT NULL,
      image_url TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'revoked', 'expired')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewer_id TEXT,
      decision_reason TEXT,
      registration_code TEXT UNIQUE,
      expires_at TEXT,
      review_channel_id TEXT,
      review_message_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_vehicle_per_applicant
      ON vehicle_applications(applicant_id) WHERE status = 'pending';

    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_or_active_vehicle_plate
      ON vehicle_applications(plate_key) WHERE status IN ('pending', 'approved');

    CREATE INDEX IF NOT EXISTS vehicle_applications_applicant_status
      ON vehicle_applications(applicant_id, status, created_at);

    CREATE TABLE IF NOT EXISTS vehicle_registration_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES vehicle_applications(id),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS vehicle_registration_history_application
      ON vehicle_registration_history(application_id, created_at);

    CREATE TABLE IF NOT EXISTS temporary_admin_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      applicant_id TEXT NOT NULL,
      applicant_name TEXT NOT NULL,
      application_title TEXT NOT NULL,
      application_description TEXT NOT NULL,
      questions_json TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      requested_role_id TEXT NOT NULL,
      duration_hours INTEGER NOT NULL CHECK(duration_hours BETWEEN 1 AND 8760),
      status TEXT NOT NULL CHECK(status IN ('pending', 'approving', 'approved', 'expiring', 'denied', 'expired')),
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewer_id TEXT,
      decision_reason TEXT,
      expires_at TEXT,
      review_channel_id TEXT,
      review_message_id TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_temporary_admin_application_per_applicant
      ON temporary_admin_applications(applicant_id) WHERE status IN ('pending', 'approving', 'approved', 'expiring');

    CREATE INDEX IF NOT EXISTS temporary_admin_applications_history
      ON temporary_admin_applications(applicant_id, created_at);

    CREATE TABLE IF NOT EXISTS temporary_admin_application_drafts (
      id TEXT PRIMARY KEY,
      applicant_id TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS temporary_admin_application_drafts_expiry
      ON temporary_admin_application_drafts(expires_at);

    CREATE TABLE IF NOT EXISTS temporary_admin_application_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES temporary_admin_applications(id),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS temporary_admin_application_history_application
      ON temporary_admin_application_history(application_id, created_at);

    CREATE TABLE IF NOT EXISTS economy_accounts (
      user_id TEXT PRIMARY KEY,
      wallet_balance INTEGER NOT NULL DEFAULT 0 CHECK(wallet_balance >= 0),
      bank_balance INTEGER NOT NULL DEFAULT 0 CHECK(bank_balance >= 0),
      lifetime_earnings INTEGER NOT NULL DEFAULT 0 CHECK(lifetime_earnings >= 0),
      total_spent INTEGER NOT NULL DEFAULT 0 CHECK(total_spent >= 0),
      total_transferred INTEGER NOT NULL DEFAULT 0 CHECK(total_transferred >= 0),
      created_at TEXT NOT NULL,
      last_work_at TEXT
    );

    CREATE TABLE IF NOT EXISTS economy_transactions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      related_user_id TEXT,
      type TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount > 0),
      wallet_after INTEGER NOT NULL CHECK(wallet_after >= 0),
      bank_after INTEGER NOT NULL DEFAULT 0 CHECK(bank_after >= 0),
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS economy_transactions_user_created
      ON economy_transactions(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS economy_transactions_type_created
      ON economy_transactions(type, created_at DESC);

    CREATE TABLE IF NOT EXISTS economy_job_salaries (
      role_id TEXT PRIMARY KEY,
      salary INTEGER NOT NULL CHECK(salary > 0),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS economy_job_salaries_enabled
      ON economy_job_salaries(enabled, role_id);

    CREATE TABLE IF NOT EXISTS economy_salary_schedules (
      user_id TEXT PRIMARY KEY REFERENCES economy_accounts(user_id),
      next_due_at TEXT NOT NULL,
      last_paid_at TEXT,
      last_role_ids_json TEXT NOT NULL DEFAULT '[]',
      last_policy TEXT NOT NULL DEFAULT 'highest' CHECK(last_policy IN ('highest', 'combined'))
    );

    CREATE INDEX IF NOT EXISTS economy_salary_schedules_due
      ON economy_salary_schedules(next_due_at);

    CREATE TABLE IF NOT EXISTS economy_delivery_games (
      game_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      scenario TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      route TEXT,
      result_type TEXT,
      reward INTEGER NOT NULL DEFAULT 0 CHECK(reward >= 0),
      resolved_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_delivery_game_per_player
      ON economy_delivery_games(user_id) WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS economy_delivery_games_user_created
      ON economy_delivery_games(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS economy_delivery_cooldowns (
      user_id TEXT PRIMARY KEY REFERENCES economy_accounts(user_id),
      last_started_at TEXT NOT NULL
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

  return db;
}

module.exports = { createDatabase };