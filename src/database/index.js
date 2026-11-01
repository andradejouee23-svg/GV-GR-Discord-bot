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
      last_work_at TEXT,
      last_daily_reward_at TEXT
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
      metadata_json TEXT NOT NULL DEFAULT '{}',
      idempotency_key TEXT
    );

    CREATE INDEX IF NOT EXISTS economy_transactions_user_created
      ON economy_transactions(user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS economy_transactions_type_created
      ON economy_transactions(type, created_at DESC);

    CREATE TABLE IF NOT EXISTS economy_shop_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL CHECK(price >= 0),
      category TEXT NOT NULL DEFAULT 'General',
      stock INTEGER NOT NULL DEFAULT 0 CHECK(stock >= 0),
      image_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
      purchase_limit INTEGER,
      deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1)),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS economy_shop_items_enabled
      ON economy_shop_items(enabled, category, price);

    CREATE TABLE IF NOT EXISTS economy_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      item_id TEXT NOT NULL REFERENCES economy_shop_items(id),
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      purchased_at TEXT NOT NULL,
      UNIQUE(user_id, item_id)
    );

    CREATE TABLE IF NOT EXISTS economy_purchase_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      item_id TEXT NOT NULL REFERENCES economy_shop_items(id),
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      price INTEGER NOT NULL CHECK(price >= 0),
      total_cost INTEGER NOT NULL CHECK(total_cost >= 0),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS economy_purchase_history_user_created
      ON economy_purchase_history(user_id, created_at DESC);

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

    CREATE TABLE IF NOT EXISTS economy_cash_drops (
      drop_id TEXT PRIMARY KEY,
      schedule_key TEXT UNIQUE,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      amount INTEGER NOT NULL CHECK(amount > 0),
      max_claims INTEGER NOT NULL CHECK(max_claims > 0),
      claim_count INTEGER NOT NULL DEFAULT 0 CHECK(claim_count >= 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'open', 'claimed', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS economy_cash_drops_status_expiry
      ON economy_cash_drops(status, expires_at);

    CREATE TABLE IF NOT EXISTS economy_shop_purchase_confirmations (
      confirmation_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      item_id TEXT NOT NULL REFERENCES economy_shop_items(id),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      quoted_price INTEGER NOT NULL CHECK(quoted_price > 0),
      status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'cancelled', 'expired')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS economy_shop_purchase_confirmations_user_status
      ON economy_shop_purchase_confirmations(user_id, status, expires_at);

    CREATE TABLE IF NOT EXISTS economy_cash_drop_claims (
      drop_id TEXT NOT NULL REFERENCES economy_cash_drops(drop_id),
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      amount INTEGER NOT NULL CHECK(amount > 0),
      claimed_at TEXT NOT NULL,
      PRIMARY KEY (drop_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS economy_games (
      game_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      game_type TEXT NOT NULL CHECK(game_type IN ('blackjack', 'coinflip', 'roulette', 'chicken')),
      bet INTEGER NOT NULL CHECK(bet > 0),
      status TEXT NOT NULL CHECK(status IN ('active', 'won', 'lost', 'push', 'expired')),
      state_json TEXT NOT NULL DEFAULT '{}',
      payout INTEGER NOT NULL DEFAULT 0 CHECK(payout >= 0),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS one_active_economy_game_per_player
      ON economy_games(user_id) WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS economy_games_user_created
      ON economy_games(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS blacklist_records (
      record_id TEXT PRIMARY KEY,
      roblox_username TEXT NOT NULL,
      roblox_user_id TEXT,
      discord_username TEXT NOT NULL,
      discord_user_id TEXT,
      reason TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      duration_hours INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'removed')),
      staff_notes TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      updated_at TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT
    );

    CREATE INDEX IF NOT EXISTS blacklist_records_status_created
      ON blacklist_records(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS blacklist_records_roblox_id
      ON blacklist_records(roblox_user_id);
    CREATE INDEX IF NOT EXISTS blacklist_records_discord_id
      ON blacklist_records(discord_user_id);
    CREATE INDEX IF NOT EXISTS blacklist_records_roblox_name
      ON blacklist_records(roblox_username COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS blacklist_records_discord_name
      ON blacklist_records(discord_username COLLATE NOCASE);

    CREATE UNIQUE INDEX IF NOT EXISTS blacklist_active_roblox_id
      ON blacklist_records(roblox_user_id) WHERE status = 'active' AND roblox_user_id IS NOT NULL AND roblox_user_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS blacklist_active_discord_id
      ON blacklist_records(discord_user_id) WHERE status = 'active' AND discord_user_id IS NOT NULL AND discord_user_id != '';

    CREATE TABLE IF NOT EXISTS blacklist_appeals (
      appeal_id TEXT PRIMARY KEY,
      record_id TEXT REFERENCES blacklist_records(record_id),
      applicant_id TEXT NOT NULL,
      roblox_username TEXT NOT NULL,
      roblox_user_id TEXT NOT NULL DEFAULT '',
      discord_username TEXT NOT NULL,
      blacklist_record_id TEXT NOT NULL DEFAULT '',
      reconsideration_reason TEXT NOT NULL,
      incident_explanation TEXT NOT NULL,
      return_reason TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'denied', 'info_requested')),
      reviewer_id TEXT,
      decision_reason TEXT NOT NULL DEFAULT '',
      management_notes TEXT NOT NULL DEFAULT '',
      applicant_response TEXT NOT NULL DEFAULT '',
      submitted_at TEXT NOT NULL,
      reviewed_at TEXT,
      review_channel_id TEXT,
      review_message_id TEXT
    );

    CREATE INDEX IF NOT EXISTS blacklist_appeals_status_submitted
      ON blacklist_appeals(status, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS blacklist_appeals_applicant
      ON blacklist_appeals(applicant_id, submitted_at DESC);
    CREATE INDEX IF NOT EXISTS blacklist_appeals_record
      ON blacklist_appeals(record_id, submitted_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS blacklist_one_open_appeal_per_applicant
      ON blacklist_appeals(record_id, applicant_id) WHERE status IN ('pending', 'info_requested');

    CREATE TABLE IF NOT EXISTS blacklist_form_drafts (
      draft_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      draft_type TEXT NOT NULL CHECK(draft_type IN ('blacklist', 'appeal', 'edit')),
      record_id TEXT,
      stage INTEGER NOT NULL DEFAULT 1,
      data_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS blacklist_form_drafts_expiry
      ON blacklist_form_drafts(expires_at);

    CREATE TABLE IF NOT EXISTS blacklist_record_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id TEXT NOT NULL REFERENCES blacklist_records(record_id),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      changes_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS blacklist_record_history_record
      ON blacklist_record_history(record_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS blacklist_appeal_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      appeal_id TEXT NOT NULL REFERENCES blacklist_appeals(appeal_id),
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS blacklist_appeal_history_appeal
      ON blacklist_appeal_history(appeal_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS panel_editor_configs (
      panel_key TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      footer_text TEXT,
      author_text TEXT,
      color_hex TEXT,
      header_image_url TEXT,
      header_image_position TEXT NOT NULL DEFAULT 'top' CHECK(header_image_position IN ('top', 'bottom')),
      fields_json TEXT NOT NULL DEFAULT '[]',
      button_labels_json TEXT NOT NULL DEFAULT '[]',
      header_channel_id TEXT,
      header_message_id TEXT,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS panel_editor_drafts (
      draft_id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      panel_key TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS panel_editor_drafts_expiry
      ON panel_editor_drafts(expires_at);

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

  const accountColumns = new Set(db.pragma('table_info(economy_accounts)').map((column) => column.name));
  if (!accountColumns.has('last_daily_reward_at')) {
    db.exec('ALTER TABLE economy_accounts ADD COLUMN last_daily_reward_at TEXT');
  }

  const transactionColumns = new Set(db.pragma('table_info(economy_transactions)').map((column) => column.name));
  if (!transactionColumns.has('idempotency_key')) {
    db.exec('ALTER TABLE economy_transactions ADD COLUMN idempotency_key TEXT');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS economy_transactions_idempotency
      ON economy_transactions(idempotency_key) WHERE idempotency_key IS NOT NULL;
  `);

  const cashDropColumns = new Set(db.pragma('table_info(economy_cash_drops)').map((column) => column.name));
  if (!cashDropColumns.has('claimed_by')) db.exec('ALTER TABLE economy_cash_drops ADD COLUMN claimed_by TEXT');
  if (!cashDropColumns.has('claimed_at')) db.exec('ALTER TABLE economy_cash_drops ADD COLUMN claimed_at TEXT');
  if (!cashDropColumns.has('claimed_message_updated_at')) db.exec('ALTER TABLE economy_cash_drops ADD COLUMN claimed_message_updated_at TEXT');
  db.exec(`
    UPDATE economy_cash_drops
    SET claimed_by = (
      SELECT user_id FROM economy_cash_drop_claims WHERE drop_id = economy_cash_drops.drop_id ORDER BY claimed_at LIMIT 1
    ), claimed_at = (
      SELECT claimed_at FROM economy_cash_drop_claims WHERE drop_id = economy_cash_drops.drop_id ORDER BY claimed_at LIMIT 1
    )
    WHERE status = 'claimed' AND claimed_by IS NULL;
  `);

  const shopColumns = new Set(db.pragma('table_info(economy_shop_items)').map((column) => column.name));
  if (!shopColumns.has('deleted')) {
    db.exec('ALTER TABLE economy_shop_items ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0, 1))');
  }

  const applicationColumns = new Set(db.pragma('table_info(temporary_admin_applications)').map((column) => column.name));
  const applicationMigrations = [
    ['review_state', "TEXT NOT NULL DEFAULT 'pending'"],
    ['management_notes', "TEXT NOT NULL DEFAULT ''"],
    ['trial_started_at', 'TEXT'],
    ['trial_duration_hours', 'INTEGER'],
    ['assigned_manager_id', 'TEXT'],
    ['trial_extensions', 'INTEGER NOT NULL DEFAULT 0'],
    ['trial_outcome', 'TEXT'],
    ['trial_reminder_sent_at', 'TEXT'],
  ];
  for (const [column, definition] of applicationMigrations) {
    if (!applicationColumns.has(column)) db.exec(`ALTER TABLE temporary_admin_applications ADD COLUMN ${column} ${definition}`);
  }
  const applicationDraftColumns = new Set(db.pragma('table_info(temporary_admin_application_drafts)').map((column) => column.name));
  if (!applicationDraftColumns.has('answers_json')) db.exec("ALTER TABLE temporary_admin_application_drafts ADD COLUMN answers_json TEXT NOT NULL DEFAULT '[]'");
  if (!applicationDraftColumns.has('current_page')) db.exec('ALTER TABLE temporary_admin_application_drafts ADD COLUMN current_page INTEGER NOT NULL DEFAULT 0');
  const panelEditorColumns = new Set(db.pragma('table_info(panel_editor_configs)').map((column) => column.name));
  if (!panelEditorColumns.has('fields_json')) db.exec("ALTER TABLE panel_editor_configs ADD COLUMN fields_json TEXT NOT NULL DEFAULT '[]'");
  if (!panelEditorColumns.has('header_image_position')) db.exec("ALTER TABLE panel_editor_configs ADD COLUMN header_image_position TEXT NOT NULL DEFAULT 'top'");
  const appealColumns = new Set(db.pragma('table_info(blacklist_appeals)').map((column) => column.name));
  if (!appealColumns.has('applicant_response')) db.exec("ALTER TABLE blacklist_appeals ADD COLUMN applicant_response TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE INDEX IF NOT EXISTS temporary_admin_trial_expiration
      ON temporary_admin_applications(status, expires_at, trial_reminder_sent_at);
  `);

  const defaultShopItems = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Town Job Upgrade Request',
      description: 'Request management review for a higher-paying configured Town Job. Purchase does not grant a role or guarantee a raise; staff approval is required.',
      price: 500,
      category: 'Town Jobs',
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Blacklisted Vehicle Exception Review',
      description: 'Request management review for an exception related to a blacklisted vehicle. This purchase does not bypass blacklist status; approval is required.',
      price: 750,
      category: 'Vehicle Services',
    },
  ];
  const seededAt = new Date().toISOString();
  db.transaction(() => {
    for (const item of defaultShopItems) {
      db.prepare(`
        INSERT INTO economy_shop_items (id, name, description, price, category, stock, enabled, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 100, 1, 'system', ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(item.id, item.name, item.description, item.price, item.category, seededAt, seededAt);
    }
  })();

  return db;
}

module.exports = { createDatabase };