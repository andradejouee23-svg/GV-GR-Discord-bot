function saveStaffRecord(db, member, now) {
  db.prepare(`
    INSERT INTO staff (user_id, username, role_name, first_seen_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, role_name = excluded.role_name
  `).run(member.id, member.username, member.roleName, now);
}

function clockIn(db, member, now = new Date().toISOString()) {
  return db.transaction(() => {
    const activeShift = db.prepare(
      "SELECT id, started_at FROM shifts WHERE user_id = ? AND status = 'active'",
    ).get(member.id);

    if (activeShift) return { alreadyOnDuty: true, shift: activeShift };

    saveStaffRecord(db, member, now);
    const result = db.prepare(`
      INSERT INTO shifts (user_id, username, role_name, started_at)
      VALUES (?, ?, ?, ?)
    `).run(member.id, member.username, member.roleName, now);

    return {
      alreadyOnDuty: false,
      shift: { id: Number(result.lastInsertRowid), started_at: now },
    };
  })();
}

function clockOut(db, userId, now = new Date().toISOString()) {
  return db.transaction(() => {
    const shift = db.prepare(
      "SELECT * FROM shifts WHERE user_id = ? AND status = 'active'",
    ).get(userId);

    if (!shift) return null;

    const durationSeconds = Math.max(
      0,
      Math.floor((new Date(now).getTime() - new Date(shift.started_at).getTime()) / 1000),
    );
    db.prepare(`
      UPDATE shifts
      SET ended_at = ?, duration_seconds = ?, status = 'completed'
      WHERE id = ? AND status = 'active'
    `).run(now, durationSeconds, shift.id);

    return { ...shift, ended_at: now, duration_seconds: durationSeconds, status: 'completed' };
  })();
}

function getOnDuty(db) {
  return db.prepare(`
    SELECT user_id, username, role_name, started_at
    FROM shifts WHERE status = 'active'
    ORDER BY started_at ASC
  `).all();
}

module.exports = { clockIn, clockOut, getOnDuty };