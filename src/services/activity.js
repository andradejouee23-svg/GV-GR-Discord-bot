function getShiftSummary(db, userId, now = new Date()) {
  const nowIso = now.toISOString();
  const weekStart = new Date(now);
  const dayOffset = (weekStart.getUTCDay() + 6) % 7;
  weekStart.setUTCDate(weekStart.getUTCDate() - dayOffset);
  weekStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const secondsInRange = (start, end) => db.prepare(`
    SELECT COALESCE(SUM(
      MAX(0, MIN(strftime('%s', COALESCE(ended_at, ?)), strftime('%s', ?))
      - MAX(strftime('%s', started_at), strftime('%s', ?)))
    ), 0) AS seconds
    FROM shifts
    WHERE user_id = ? AND started_at < ? AND (ended_at IS NULL OR ended_at > ?)
  `).get(nowIso, end, start, userId, end, start).seconds;

  const totals = db.prepare(`
    SELECT COUNT(*) AS completed_shifts,
      COALESCE(SUM(duration_seconds), 0) AS completed_seconds
    FROM shifts WHERE user_id = ? AND status = 'completed'
  `).get(userId);
  const currentShift = db.prepare(
    "SELECT started_at FROM shifts WHERE user_id = ? AND status = 'active'",
  ).get(userId);
  const sessions = db.prepare(
    'SELECT COUNT(*) AS count FROM session_participants WHERE user_id = ?',
  ).get(userId).count;
  const eventsHosted = db.prepare(
    'SELECT COUNT(*) AS count FROM events WHERE host_id = ?',
  ).get(userId).count;
  const moderationActions = db.prepare(
    'SELECT COUNT(*) AS count FROM moderation_logs WHERE staff_id = ?',
  ).get(userId).count;
  const allTimeSeconds = secondsInRange('1970-01-01T00:00:00.000Z', nowIso);

  return {
    totalSeconds: allTimeSeconds,
    shiftsCompleted: totals.completed_shifts,
    currentShift,
    averageSeconds: totals.completed_shifts ? totals.completed_seconds / totals.completed_shifts : 0,
    sessionsAttended: sessions,
    eventsHosted,
    moderationActions,
    weekSeconds: secondsInRange(weekStart.toISOString(), nowIso),
    monthSeconds: secondsInRange(monthStart.toISOString(), nowIso),
  };
}

function getLeaderboard(db, period, now = new Date()) {
  const nowIso = now.toISOString();
  let start = '1970-01-01T00:00:00.000Z';
  if (period === 'weekly') {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    date.setUTCHours(0, 0, 0, 0);
    start = date.toISOString();
  } else if (period === 'monthly') {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  }

  return db.prepare(`
    SELECT s.user_id, s.username,
      SUM(MAX(0, MIN(strftime('%s', COALESCE(sh.ended_at, ?)), strftime('%s', ?))
      - MAX(strftime('%s', sh.started_at), strftime('%s', ?)))) AS total_seconds
    FROM shifts sh JOIN staff s ON s.user_id = sh.user_id
    WHERE sh.started_at < ? AND (sh.ended_at IS NULL OR sh.ended_at > ?)
    GROUP BY s.user_id ORDER BY total_seconds DESC, s.username ASC LIMIT 10
  `).all(nowIso, nowIso, start, nowIso, start);
}

module.exports = { getLeaderboard, getShiftSummary };