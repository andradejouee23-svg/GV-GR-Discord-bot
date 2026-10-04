const config = require('../../config');

function getWeekStart(date = new Date()) {
  const start = new Date(date);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start.toISOString().slice(0, 10);
}

function getNextWeekStart(weekStart) {
  const next = new Date(`${weekStart}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
}

function ensureProfile(db, userId, now = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO staff_profiles (user_id, updated_at)
    SELECT user_id, ? FROM staff WHERE user_id = ?
    ON CONFLICT(user_id) DO NOTHING
  `).run(now, userId);
}

function currentStatus(db, userId, now = new Date().toISOString()) {
  const profile = db.prepare('SELECT * FROM staff_profiles WHERE user_id = ?').get(userId);
  if (!profile) return { status: 'active', status_until: null, status_reason: '' };
  if (['break', 'suspended'].includes(profile.status) && profile.status_until && profile.status_until <= now) {
    db.prepare(`
      UPDATE staff_profiles SET status = 'active', status_until = NULL, status_reason = '', updated_at = ?
      WHERE user_id = ?
    `).run(now, userId);
    db.prepare(`
      INSERT INTO staff_audit_logs (action, target_id, actor_id, reason, previous_value, new_value, created_at)
      VALUES ('status_expired', ?, ?, 'Scheduled status duration ended', ?, 'active', ?)
    `).run(userId, userId, profile.status, now);
    return { status: 'active', status_until: null, status_reason: '' };
  }
  return profile;
}

function checkInStaff(db, member, now = new Date().toISOString()) {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id, started_at FROM shifts WHERE user_id = ? AND status = 'active'").get(member.id);
    if (existing) return { alreadyOnDuty: true, shift: existing };

    db.prepare(`
      INSERT INTO staff (user_id, username, role_name, first_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, role_name = excluded.role_name
    `).run(member.id, member.username, member.roleName, now);
    ensureProfile(db, member.id, now);
    const status = currentStatus(db, member.id, now);
    if (status.status !== 'active') return { unavailable: true, status: status.status, statusUntil: status.status_until };

    const result = db.prepare(`
      INSERT INTO shifts (user_id, username, role_name, started_at)
      VALUES (?, ?, ?, ?)
    `).run(member.id, member.username, member.roleName, now);
    return { alreadyOnDuty: false, shift: { id: Number(result.lastInsertRowid), started_at: now } };
  })();
}

function checkOutStaff(db, userId, now = new Date().toISOString()) {
  return db.transaction(() => {
    const shift = db.prepare("SELECT * FROM shifts WHERE user_id = ? AND status = 'active'").get(userId);
    if (!shift) return null;

    const durationSeconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(shift.started_at)) / 1000));
    const hourlyPoints = Math.floor(durationSeconds / 3600);
    db.prepare(`
      UPDATE shifts SET ended_at = ?, duration_seconds = ?, status = 'completed'
      WHERE id = ? AND status = 'active'
    `).run(now, durationSeconds, shift.id);

    if (hourlyPoints > 0) {
      db.prepare(`
        INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, created_at)
        VALUES (?, ?, 'shift_hours', ?, 'One point per completed shift hour', ?)
        ON CONFLICT DO NOTHING
      `).run(userId, hourlyPoints, String(shift.id), now);
    }

    return { ...shift, ended_at: now, duration_seconds: durationSeconds, status: 'completed', hourly_points: hourlyPoints };
  })();
}

function submitDailyReport(db, { userId, shiftId, rating, explanation = '', now = new Date().toISOString() }) {
  if (!['great', 'good', 'okay', 'bad'].includes(rating)) throw new Error('Choose a valid RP rating.');
  if (explanation.length > 1000) throw new Error('Report explanation must be 1000 characters or fewer.');

  return db.transaction(() => {
    const shift = db.prepare("SELECT * FROM shifts WHERE id = ? AND user_id = ? AND status = 'completed'").get(shiftId, userId);
    if (!shift) return { saved: false, reason: 'shift_not_found' };
    const reportDate = shift.ended_at.slice(0, 10);
    const previous = db.prepare('SELECT id FROM daily_rp_reports WHERE user_id = ? AND report_date = ?').get(userId, reportDate);
    if (previous) return { saved: false, reason: 'already_reported', reportId: previous.id };

    const result = db.prepare(`
      INSERT INTO daily_rp_reports (user_id, shift_id, report_date, shift_seconds, rating, explanation, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, shiftId, reportDate, shift.duration_seconds, rating, explanation.trim(), now);
    const reportId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, created_at)
      VALUES (?, 1, 'daily_report', ?, 'Daily checkout RP report bonus', ?)
      ON CONFLICT DO NOTHING
    `).run(userId, String(reportId), now);
    const reminders = db.prepare(`
      SELECT r.channel_id, r.message_id FROM staff_report_reminders r
      JOIN shifts sh ON sh.id = r.shift_id
      WHERE sh.user_id = ? AND substr(sh.ended_at, 1, 10) = ? AND r.delivery_status = 'sent'
    `).all(userId, reportDate);
    db.prepare(`
      UPDATE staff_report_reminders SET delivery_status = 'completed'
      WHERE shift_id IN (
        SELECT id FROM shifts WHERE user_id = ? AND substr(ended_at, 1, 10) = ?
      ) AND delivery_status = 'sent'
    `).run(userId, reportDate);
    const totalPoints = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM staff_points_ledger WHERE user_id = ?').get(userId).total;
    return { saved: true, reportId, reportDate, bonusPoints: 1, totalPoints, reminders };
  })();
}

function secondsInRange(db, userId, start, end) {
  return db.prepare(`
    SELECT COALESCE(SUM(
      MAX(0, MIN(strftime('%s', COALESCE(ended_at, ?)), strftime('%s', ?))
      - MAX(strftime('%s', started_at), strftime('%s', ?)))
    ), 0) AS seconds
    FROM shifts
    WHERE user_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
  `).get(end, end, start, userId, end, start).seconds;
}

function getCurrentStreak(db, userId, now = new Date()) {
  const reset = db.prepare('SELECT reset_before_date FROM staff_streak_resets WHERE user_id = ?').get(userId);
  const dates = db.prepare(`
    SELECT DISTINCT substr(ended_at, 1, 10) AS work_date
    FROM shifts
    WHERE user_id = ? AND status = 'completed' AND duration_seconds >= ? AND ended_at IS NOT NULL
      AND (? IS NULL OR substr(ended_at, 1, 10) > ?)
    ORDER BY work_date DESC
  `).all(userId, config.STREAK_MIN_SHIFT_MINUTES * 60, reset?.reset_before_date ?? null, reset?.reset_before_date ?? null)
    .map((entry) => entry.work_date);

  const currentDate = now.toISOString().slice(0, 10);
  const previousDate = new Date(`${currentDate}T00:00:00.000Z`);
  previousDate.setUTCDate(previousDate.getUTCDate() - 1);
  let expected = dates[0] === currentDate ? currentDate : previousDate.toISOString().slice(0, 10);
  if (dates[0] !== expected) return 0;

  let streak = 0;
  for (const date of dates) {
    if (date !== expected) break;
    streak += 1;
    const prior = new Date(`${expected}T00:00:00.000Z`);
    prior.setUTCDate(prior.getUTCDate() - 1);
    expected = prior.toISOString().slice(0, 10);
  }
  return streak;
}

function getStaffStats(db, userId, now = new Date()) {
  const nowIso = now.toISOString();
  const weekStart = getWeekStart(now);
  const nextWeekStart = getNextWeekStart(weekStart);
  const totalPoints = db.prepare('SELECT COALESCE(SUM(amount), 0) AS points FROM staff_points_ledger WHERE user_id = ?').get(userId).points;
  const weeklyPoints = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS points FROM staff_points_ledger
    WHERE user_id = ? AND created_at >= ? AND created_at < ?
  `).get(userId, `${weekStart}T00:00:00.000Z`, `${nextWeekStart}T00:00:00.000Z`).points;
  const currentShift = db.prepare("SELECT id, started_at FROM shifts WHERE user_id = ? AND status = 'active'").get(userId);
  const shiftCounts = db.prepare(`
    SELECT COUNT(*) AS count FROM shifts WHERE user_id = ? AND status = 'completed'
  `).get(userId).count;
  const reports = db.prepare('SELECT COUNT(*) AS count FROM daily_rp_reports WHERE user_id = ?').get(userId).count;
  const allStart = '1970-01-01T00:00:00.000Z';
  const weekEnd = new Date(Math.min(now.getTime(), Date.parse(`${nextWeekStart}T00:00:00.000Z`))).toISOString();
  const weekSeconds = secondsInRange(db, userId, `${weekStart}T00:00:00.000Z`, weekEnd);
  const allSeconds = secondsInRange(db, userId, allStart, nowIso);
  const activeShiftSeconds = currentShift ? Math.max(0, Math.floor((now.getTime() - Date.parse(currentShift.started_at)) / 1000)) : 0;
  return {
    totalPoints,
    weeklyPoints,
    weeklySeconds: weekSeconds,
    weeklyGoalHours: config.WEEKLY_GOAL_HOURS,
    totalSeconds: allSeconds,
    completedShifts: shiftCounts,
    activeShift: currentShift ? { ...currentShift, durationSeconds: activeShiftSeconds } : null,
    currentStreak: getCurrentStreak(db, userId, now),
    reportCount: reports,
  };
}

function getPointsLeaderboard(db, { start, end } = {}) {
  if (start && end) {
    return db.prepare(`
      SELECT s.user_id, s.username, COALESCE(SUM(p.amount), 0) AS points
      FROM staff s LEFT JOIN staff_points_ledger p ON p.user_id = s.user_id AND p.created_at >= ? AND p.created_at < ?
      GROUP BY s.user_id ORDER BY points DESC, s.username ASC LIMIT 10
    `).all(start, end);
  }
  return db.prepare(`
    SELECT s.user_id, s.username, COALESCE(SUM(p.amount), 0) AS points
    FROM staff s LEFT JOIN staff_points_ledger p ON p.user_id = s.user_id
    GROUP BY s.user_id ORDER BY points DESC, s.username ASC LIMIT 10
  `).all();
}

function getWeeklySummary(db, now = new Date()) {
  const weekStart = getWeekStart(now);
  const nextWeekStart = getNextWeekStart(weekStart);
  const from = `${weekStart}T00:00:00.000Z`;
  const until = `${nextWeekStart}T00:00:00.000Z`;
  const leaderboard = getPointsLeaderboard(db, { start: from, end: until });
  const points = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS points FROM staff_points_ledger WHERE created_at >= ? AND created_at < ?
  `).get(from, until).points;
  const currentTime = now.toISOString();
  const hours = db.prepare(`
    SELECT COALESCE(SUM(
      MAX(0, MIN(strftime('%s', COALESCE(ended_at, ?)), strftime('%s', ?))
      - MAX(strftime('%s', started_at), strftime('%s', ?)))
    ), 0) AS seconds
    FROM shifts WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
  `).get(currentTime, currentTime, from, currentTime, from).seconds;
  const award = db.prepare('SELECT * FROM staff_weekly_awards ORDER BY week_start DESC LIMIT 1').get();
  return { weekStart, nextWeekStart, goalHours: config.WEEKLY_GOAL_HOURS, leaderboard, points, hours, award };
}

function getManagementRoster(db, now = new Date()) {
  const rows = db.prepare(`
    SELECT s.user_id, s.username, s.role_name, p.status, p.status_until,
      (SELECT started_at FROM shifts sh WHERE sh.user_id = s.user_id AND sh.status = 'active') AS active_started_at,
      COALESCE((SELECT SUM(duration_seconds) FROM shifts sh WHERE sh.user_id = s.user_id AND sh.status = 'completed'), 0) AS completed_seconds,
      COALESCE((SELECT SUM(amount) FROM staff_points_ledger l WHERE l.user_id = s.user_id), 0) AS total_points,
      (SELECT COUNT(*) FROM daily_rp_reports r WHERE r.user_id = s.user_id) AS reports,
      (SELECT MAX(ended_at) FROM shifts sh WHERE sh.user_id = s.user_id AND sh.status = 'completed') AS last_active_at
    FROM staff s LEFT JOIN staff_profiles p ON p.user_id = s.user_id
    ORDER BY active_started_at IS NULL, active_started_at ASC, s.username ASC
  `).all();
  return rows.map((row) => ({ ...row, current_streak: getCurrentStreak(db, row.user_id, now) }));
}

function getStaffReports(db, userId, limit = 20) {
  return db.prepare(`
    SELECT r.*, s.username FROM daily_rp_reports r JOIN staff s ON s.user_id = r.user_id
    WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT ?
  `).all(userId, limit);
}

function getRecentReports(db, limit = 20) {
  return db.prepare(`
    SELECT r.*, s.username FROM daily_rp_reports r JOIN staff s ON s.user_id = r.user_id
    ORDER BY r.created_at DESC LIMIT ?
  `).all(limit);
}

function getAuditLogs(db, limit = 25) {
  return db.prepare('SELECT * FROM staff_audit_logs ORDER BY id DESC LIMIT ?').all(limit);
}

function getPunishments(db, userId, limit = 20) {
  return db.prepare(`
    SELECT * FROM staff_audit_logs WHERE target_id = ?
      AND action IN ('warning', 'point_adjustment', 'admin_break', 'suspension', 'demotion', 'staff_removal', 'staff_note')
    ORDER BY id DESC LIMIT ?
  `).all(userId, limit);
}

function getRecentShiftActivity(db, limit = 20) {
  return db.prepare(`
    SELECT id, user_id, username, role_name, started_at, ended_at, duration_seconds, status
    FROM shifts ORDER BY COALESCE(ended_at, started_at) DESC LIMIT ?
  `).all(limit);
}

function awardStaffOfWeek(db, now = new Date()) {
  const currentWeekStart = getWeekStart(now);
  const weekStart = new Date(`${currentWeekStart}T00:00:00.000Z`);
  weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  const previousStart = weekStart.toISOString().slice(0, 10);
  const nextStart = currentWeekStart;
  const from = `${previousStart}T00:00:00.000Z`;
  const until = `${nextStart}T00:00:00.000Z`;

  return db.transaction(() => {
    if (db.prepare('SELECT week_start FROM staff_weekly_awards WHERE week_start = ?').get(previousStart)) return null;
    const winner = db.prepare(`
      SELECT s.user_id,
        COALESCE((SELECT SUM(sh.duration_seconds) FROM shifts sh WHERE sh.user_id = s.user_id AND sh.status = 'completed' AND sh.ended_at >= ? AND sh.ended_at < ?), 0) AS hours_seconds,
        COALESCE((SELECT SUM(l.amount) FROM staff_points_ledger l WHERE l.user_id = s.user_id AND l.created_at >= ? AND l.created_at < ?), 0) AS points,
        (SELECT COUNT(*) FROM daily_rp_reports r WHERE r.user_id = s.user_id AND r.created_at >= ? AND r.created_at < ?) AS reports
      FROM staff s
      ORDER BY hours_seconds DESC, reports DESC, points DESC, s.username ASC LIMIT 1
    `).get(from, until, from, until, from, until);
    if (!winner || (winner.hours_seconds === 0 && winner.reports === 0 && winner.points === 0)) {
      db.prepare('INSERT INTO staff_weekly_awards (week_start, created_at) VALUES (?, ?)').run(previousStart, now.toISOString());
      return { weekStart: previousStart, winner: null };
    }

    db.prepare(`
      INSERT INTO staff_weekly_awards (week_start, user_id, hours_seconds, points, reports, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(previousStart, winner.user_id, winner.hours_seconds, winner.points, winner.reports, now.toISOString());
    db.prepare(`
      INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, created_at)
      VALUES (?, ?, 'staff_of_week', ?, 'Staff of the Week award', ?)
      ON CONFLICT DO NOTHING
    `).run(winner.user_id, config.STAFF_OF_WEEK_BONUS_POINTS, previousStart, now.toISOString());
    return { weekStart: previousStart, winner };
  })();
}

function logAudit(db, entry) {
  const result = db.prepare(`
    INSERT INTO staff_audit_logs (
      action, target_id, actor_id, reason, previous_value, new_value, duration_seconds, details_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.action,
    entry.targetId,
    entry.actorId,
    entry.reason ?? '',
    entry.previousValue == null ? null : String(entry.previousValue),
    entry.newValue == null ? null : String(entry.newValue),
    entry.durationSeconds ?? null,
    JSON.stringify(entry.details ?? {}),
    entry.createdAt ?? new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

function adjustStaffPoints(db, { userId, amount, actorId, reason, now = new Date().toISOString() }) {
  if (!Number.isInteger(amount) || amount === 0) throw new Error('Point adjustment must be a nonzero whole number.');
  if (!reason?.trim()) throw new Error('A reason is required for point adjustments.');
  return db.transaction(() => {
    const before = db.prepare('SELECT COALESCE(SUM(amount), 0) AS points FROM staff_points_ledger WHERE user_id = ?').get(userId).points;
    const after = before + amount;
    if (after < 0) throw new Error('Staff points cannot be reduced below zero.');
    const auditId = logAudit(db, {
      action: 'point_adjustment', targetId: userId, actorId, reason,
      previousValue: before, newValue: after, createdAt: now,
    });
    db.prepare(`
      INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, actor_id, created_at)
      VALUES (?, ?, 'manual_adjustment', ?, ?, ?, ?)
    `).run(userId, amount, `audit-${auditId}`, reason.trim(), actorId, now);
    return { before, after, amount };
  })();
}

function applyStaffStatus(db, { userId, actorId, action, reason, durationSeconds = null, now = new Date().toISOString() }) {
  const statusForAction = { break: 'break', suspend: 'suspended', demote: 'demoted', remove: 'removed' };
  const newStatus = statusForAction[action];
  if (!newStatus) throw new Error('Unsupported staff status action.');
  if (!reason?.trim()) throw new Error('A reason is required for this staff action.');
  if (['break', 'suspend'].includes(action) && (!Number.isInteger(durationSeconds) || durationSeconds <= 0)) {
    throw new Error('Choose a valid duration for this action.');
  }

  return db.transaction(() => {
    const previous = currentStatus(db, userId, now);
    const until = durationSeconds ? new Date(Date.parse(now) + durationSeconds * 1000).toISOString() : null;
    db.prepare(`
      INSERT INTO staff_profiles (user_id, status, status_until, status_reason, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, status_until = excluded.status_until,
        status_reason = excluded.status_reason, updated_at = excluded.updated_at
    `).run(userId, newStatus, until, reason.trim(), now);
    const auditId = logAudit(db, {
      action: action === 'break' ? 'admin_break' : action === 'suspend' ? 'suspension' : action === 'demote' ? 'demotion' : 'staff_removal',
      targetId: userId, actorId, reason, previousValue: previous.status, newValue: newStatus,
      durationSeconds, createdAt: now,
    });
    return { auditId, status: newStatus, statusUntil: until, previousStatus: previous.status };
  })();
}

function addStaffWarning(db, { userId, username, actorId, actorName, reason, now = new Date().toISOString() }) {
  if (!reason?.trim()) throw new Error('A reason is required for a staff warning.');
  return db.transaction(() => {
    const warningNumber = db.prepare('SELECT COUNT(*) AS count FROM warnings WHERE user_id = ?').get(userId).count + 1;
    db.prepare(`
      INSERT INTO warnings (user_id, username, moderator_id, moderator_name, reason, warning_number, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(userId, username, actorId, actorName, reason.trim(), warningNumber, now);
    const auditId = logAudit(db, {
      action: 'warning', targetId: userId, actorId, reason,
      newValue: warningNumber, createdAt: now,
    });
    return { warningNumber, auditId };
  })();
}

function addStaffNote(db, { userId, username, actorId, actorName, note, now = new Date().toISOString() }) {
  if (!note?.trim()) throw new Error('A note is required.');
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO staff_notes (user_id, username, author_id, author_name, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, username, actorId, actorName, note.trim(), now);
    return logAudit(db, {
      action: 'staff_note', targetId: userId, actorId, reason: note,
      createdAt: now,
    });
  })();
}

function resetStaffStreak(db, { userId, actorId, reason, now = new Date().toISOString() }) {
  const resetDate = now.slice(0, 10);
  return db.transaction(() => {
    db.prepare(`
      INSERT INTO staff_streak_resets (user_id, reset_before_date, actor_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET reset_before_date = excluded.reset_before_date,
        actor_id = excluded.actor_id, reason = excluded.reason, created_at = excluded.created_at
    `).run(userId, resetDate, actorId, reason.trim(), now);
    return logAudit(db, {
      action: 'streak_reset', targetId: userId, actorId, reason,
      previousValue: 'current streak', newValue: 0, createdAt: now,
    });
  })();
}

function correctCompletedShift(db, { shiftId, actorId, startedAt, endedAt, reason, now = new Date().toISOString() }) {
  if (!reason?.trim()) throw new Error('A reason is required to correct a shift.');
  const startTime = Date.parse(startedAt);
  const endTime = Date.parse(endedAt);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || endTime > Date.parse(now)) {
    throw new Error('Shift times must be valid, and the end must be after the start and not in the future.');
  }
  return db.transaction(() => {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!shift) throw new Error('Shift not found.');
    const durationSeconds = Math.floor((endTime - startTime) / 1000);
    const oldHours = Math.floor((shift.duration_seconds ?? 0) / 3600);
    const newHours = Math.floor(durationSeconds / 3600);
    db.prepare(`
      UPDATE shifts SET started_at = ?, ended_at = ?, duration_seconds = ?, status = 'completed' WHERE id = ?
    `).run(new Date(startTime).toISOString(), new Date(endTime).toISOString(), durationSeconds, shiftId);
    if (oldHours !== newHours) {
      const auditId = logAudit(db, {
        action: 'shift_correction', targetId: shift.user_id, actorId: actorId, reason,
        previousValue: `${oldHours} hourly points`, newValue: `${newHours} hourly points`, durationSeconds, createdAt: now,
        details: { shiftId },
      });
      db.prepare(`
        INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, actor_id, created_at)
        VALUES (?, ?, 'shift_correction', ?, ?, ?, ?)
      `).run(shift.user_id, newHours - oldHours, `audit-${auditId}`, reason, actorId, now);
    } else {
      logAudit(db, {
        action: 'shift_correction', targetId: shift.user_id, actorId, reason,
        previousValue: `${shift.started_at} - ${shift.ended_at}`,
        newValue: `${new Date(startTime).toISOString()} - ${new Date(endTime).toISOString()}`,
        durationSeconds, createdAt: now, details: { shiftId },
      });
    }
    return { ...shift, started_at: new Date(startTime).toISOString(), ended_at: new Date(endTime).toISOString(), duration_seconds: durationSeconds };
  })();
}

function closeShiftByManagement(db, { shiftId, actorId, reason, now = new Date().toISOString() }) {
  if (!reason?.trim()) throw new Error('A reason is required to close a shift.');
  return db.transaction(() => {
    const shift = db.prepare("SELECT * FROM shifts WHERE id = ? AND status = 'active'").get(shiftId);
    if (!shift) throw new Error('Active shift not found.');
    const durationSeconds = Math.max(0, Math.floor((Date.parse(now) - Date.parse(shift.started_at)) / 1000));
    const hourlyPoints = Math.floor(durationSeconds / 3600);
    db.prepare(`
      UPDATE shifts SET ended_at = ?, duration_seconds = ?, status = 'completed' WHERE id = ? AND status = 'active'
    `).run(now, durationSeconds, shiftId);
    if (hourlyPoints > 0) {
      db.prepare(`
        INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, actor_id, created_at)
        VALUES (?, ?, 'shift_hours', ?, 'Management-closed completed shift', ?, ?)
        ON CONFLICT DO NOTHING
      `).run(shift.user_id, hourlyPoints, String(shift.id), actorId, now);
    }
    logAudit(db, {
      action: 'shift_closed', targetId: shift.user_id, actorId, reason,
      previousValue: 'active', newValue: 'completed', durationSeconds, createdAt: now,
      details: { shiftId, hourlyPoints },
    });
    return { ...shift, ended_at: now, duration_seconds: durationSeconds, hourly_points: hourlyPoints };
  })();
}

function recordReminderAttempt(db, shiftId, status, messageId = null, now = new Date().toISOString()) {
  db.prepare(`
    INSERT INTO staff_shift_reminders (shift_id, last_attempt_at, message_id, delivery_status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(shift_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
      message_id = excluded.message_id, delivery_status = excluded.delivery_status
  `).run(shiftId, now, messageId, status);
}

function getOverdueShifts(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - config.SHIFT_REMINDER_HOURS * 3600_000).toISOString();
  const retryBefore = new Date(now.getTime() - 3600_000).toISOString();
  return db.prepare(`
    SELECT sh.* FROM shifts sh LEFT JOIN staff_shift_reminders r ON r.shift_id = sh.id
    WHERE sh.status = 'active' AND sh.started_at <= ?
      AND (r.shift_id IS NULL OR r.last_attempt_at <= ?)
    ORDER BY sh.started_at ASC
  `).all(cutoff, retryBefore);
}

function getPendingDailyReportReminders(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - config.DAILY_REPORT_REMINDER_MINUTES * 60_000).toISOString();
  const retryBefore = new Date(now.getTime() - config.DAILY_REPORT_REMINDER_RETRY_HOURS * 3600_000).toISOString();
  return db.prepare(`
    SELECT sh.* FROM shifts sh
    LEFT JOIN staff_report_reminders r ON r.shift_id = sh.id
    WHERE sh.status = 'completed' AND sh.ended_at <= ?
      AND NOT EXISTS (
        SELECT 1 FROM daily_rp_reports rp
        WHERE rp.user_id = sh.user_id AND rp.report_date = substr(sh.ended_at, 1, 10)
      )
      AND sh.id = (
        SELECT MAX(latest.id) FROM shifts latest
        WHERE latest.user_id = sh.user_id AND latest.status = 'completed'
          AND substr(latest.ended_at, 1, 10) = substr(sh.ended_at, 1, 10)
      )
      AND (r.shift_id IS NULL OR (r.delivery_status = 'failed' AND r.last_attempt_at <= ?))
    ORDER BY sh.ended_at ASC
  `).all(cutoff, retryBefore);
}

function recordDailyReportReminder(db, shiftId, { status, channelId = null, messageId = null, now = new Date().toISOString() }) {
  db.prepare(`
    INSERT INTO staff_report_reminders (shift_id, last_attempt_at, channel_id, message_id, delivery_status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(shift_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
      channel_id = excluded.channel_id, message_id = excluded.message_id, delivery_status = excluded.delivery_status
  `).run(shiftId, now, channelId, messageId, status);
}

function shouldSendWeeklyGoalReminders(now = new Date()) {
  return config.WEEKLY_GOAL_REMINDER_ENABLED
    && now.getUTCDay() === config.WEEKLY_GOAL_REMINDER_DAY_UTC
    && now.getUTCHours() >= config.WEEKLY_GOAL_REMINDER_HOUR_UTC;
}

function getWeeklyGoalReminderCandidates(db, now = new Date()) {
  if (!shouldSendWeeklyGoalReminders(now)) return [];
  const weekStart = getWeekStart(now);
  const retryBefore = new Date(now.getTime() - 3600_000).toISOString();
  const candidates = db.prepare(`
    SELECT s.user_id, s.username FROM staff s
    LEFT JOIN staff_weekly_goal_reminders r ON r.user_id = s.user_id AND r.week_start = ?
    WHERE r.user_id IS NULL OR (r.delivery_status = 'failed' AND r.last_attempt_at <= ?)
    ORDER BY s.username ASC
  `).all(weekStart, retryBefore);
  return candidates.filter((staffMember) =>
    getStaffStats(db, staffMember.user_id, now).weeklySeconds < config.WEEKLY_GOAL_HOURS * 3600);
}

function recordWeeklyGoalReminder(db, userId, weekStart, { status, messageId = null, now = new Date().toISOString() }) {
  db.prepare(`
    INSERT INTO staff_weekly_goal_reminders (user_id, week_start, last_attempt_at, message_id, delivery_status)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, week_start) DO UPDATE SET last_attempt_at = excluded.last_attempt_at,
      message_id = excluded.message_id, delivery_status = excluded.delivery_status
  `).run(userId, weekStart, now, messageId, status);
}

module.exports = {
  adjustStaffPoints,
  addStaffNote,
  addStaffWarning,
  applyStaffStatus,
  awardStaffOfWeek,
  checkInStaff,
  checkOutStaff,
  closeShiftByManagement,
  correctCompletedShift,
  currentStatus,
  ensureProfile,
  ensureProfile,
  getAuditLogs,
  getCurrentStreak,
  getManagementRoster,
  getNextWeekStart,
  getOverdueShifts,
  getPointsLeaderboard,
  getPendingDailyReportReminders,
  getPunishments,
  getRecentReports,
  getRecentShiftActivity,
  getStaffReports,
  getStaffStats,
  getWeekStart,
  getNextWeekStart,
  getWeekStart,
  getWeeklySummary,
  logAudit,
  recordReminderAttempt,
  recordDailyReportReminder,
  getWeeklyGoalReminderCandidates,
  recordWeeklyGoalReminder,
  resetStaffStreak,
  submitDailyReport,
  shouldSendWeeklyGoalReminders,
};