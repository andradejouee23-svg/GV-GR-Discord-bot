const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDatabase } = require('../src/database');
const {
  addStaffWarning,
  adjustStaffPoints,
  awardStaffOfWeek,
  checkInStaff,
  checkOutStaff,
  getCurrentStreak,
  getStaffStats,
  getWeekStart,
  submitDailyReport,
} = require('../src/services/staffRewards');

function openDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-rewards-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('check-in, completed-hour points, and one daily report bonus persist safely', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-rewards-reopen-'));
  const databasePath = path.join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const member = { id: 'staff-a', username: 'A', roleName: 'Moderator' };
  let db = createDatabase(databasePath);

  const started = checkInStaff(db, member, '2026-10-04T08:00:00.000Z');
  assert.equal(started.alreadyOnDuty, false);
  assert.equal(checkInStaff(db, member, '2026-10-04T08:01:00.000Z').alreadyOnDuty, true);
  db.close();

  db = createDatabase(databasePath);
  const completed = checkOutStaff(db, member.id, '2026-10-04T10:59:59.000Z');
  assert.equal(completed.hourly_points, 2);
  assert.equal(checkOutStaff(db, member.id, '2026-10-04T11:00:00.000Z'), null);
  assert.equal(getStaffStats(db, member.id, new Date('2026-10-04T11:00:00.000Z')).totalPoints, 2);

  const report = submitDailyReport(db, {
    userId: member.id,
    shiftId: completed.id,
    rating: 'great',
    explanation: 'Good RP session.',
    now: '2026-10-04T11:01:00.000Z',
  });
  assert.equal(report.saved, true);
  assert.equal(report.bonusPoints, 1);
  assert.equal(report.totalPoints, 3);
  assert.equal(submitDailyReport(db, {
    userId: member.id,
    shiftId: completed.id,
    rating: 'good',
    now: '2026-10-04T11:02:00.000Z',
  }).reason, 'already_reported');
  assert.equal(getStaffStats(db, member.id, new Date('2026-10-04T11:03:00.000Z')).totalPoints, 3);
  db.close();
});

test('a 4:28 to 4:30 shift is recorded as two minutes and earns no full-hour point', (t) => {
  const db = openDatabase(t);
  const member = { id: 'staff-two-minutes', username: 'TwoMinutes', roleName: 'Moderator' };
  checkInStaff(db, member, '2026-10-04T16:28:00.000Z');
  const shift = checkOutStaff(db, member.id, '2026-10-04T16:30:00.000Z');

  assert.equal(shift.duration_seconds, 120);
  assert.equal(shift.hourly_points, 0);
  assert.equal(getStaffStats(db, member.id, new Date('2026-10-04T16:30:00.000Z')).totalSeconds, 120);
  assert.equal(getStaffStats(db, member.id, new Date('2026-10-04T16:30:00.000Z')).totalPoints, 0);
});

test('weekly stats only include elapsed active time and streaks require distinct qualified days', (t) => {
  const db = openDatabase(t);
  const member = { id: 'staff-b', username: 'B', roleName: 'Admin' };
  checkInStaff(db, member, '2026-10-03T22:00:00.000Z');
  const stats = getStaffStats(db, member.id, new Date('2026-10-04T02:00:00.000Z'));
  assert.equal(stats.weeklySeconds, 4 * 60 * 60);
  assert.equal(getWeekStart(new Date('2026-10-04T02:00:00.000Z')), '2026-09-28');

  db.prepare(`UPDATE shifts SET ended_at = '2026-10-04T02:00:00.000Z', duration_seconds = 14400, status = 'completed' WHERE user_id = ?`).run(member.id);
  db.prepare(`
    INSERT INTO shifts (user_id, username, role_name, started_at, ended_at, duration_seconds, status)
    VALUES (?, 'B', 'Admin', '2026-10-03T08:00:00.000Z', '2026-10-03T08:45:00.000Z', 2700, 'completed')
  `).run(member.id);
  db.prepare(`
    INSERT INTO shifts (user_id, username, role_name, started_at, ended_at, duration_seconds, status)
    VALUES (?, 'B', 'Admin', '2026-10-02T10:00:00.000Z', '2026-10-02T10:45:00.000Z', 2700, 'completed')
  `).run(member.id);
  db.prepare(`
    INSERT INTO shifts (user_id, username, role_name, started_at, ended_at, duration_seconds, status)
    VALUES (?, 'B', 'Admin', '2026-10-03T10:00:00.000Z', '2026-10-03T10:10:00.000Z', 600, 'completed')
  `).run(member.id);
  assert.equal(getCurrentStreak(db, member.id, new Date('2026-10-04T12:00:00.000Z')), 3);
});

test('point adjustments, warnings, and weekly awards are auditable and idempotent', (t) => {
  const db = openDatabase(t);
  const member = { id: 'staff-c', username: 'C', roleName: 'Moderator' };
  checkInStaff(db, member, '2026-09-29T08:00:00.000Z');
  checkOutStaff(db, member.id, '2026-09-29T10:00:00.000Z');
  const adjustment = adjustStaffPoints(db, { userId: member.id, amount: 2, actorId: 'owner', reason: 'Approved bonus' });
  assert.deepEqual(adjustment, { before: 2, after: 4, amount: 2 });
  assert.throws(() => adjustStaffPoints(db, { userId: member.id, amount: -5, actorId: 'owner', reason: 'Too many' }), /below zero/);
  assert.equal(addStaffWarning(db, {
    userId: member.id,
    username: member.username,
    actorId: 'manager',
    actorName: 'Manager',
    reason: 'Missed briefing',
  }).warningNumber, 1);

  const award = awardStaffOfWeek(db, new Date('2026-10-06T12:00:00.000Z'));
  assert.equal(award.winner.user_id, member.id);
  assert.equal(awardStaffOfWeek(db, new Date('2026-10-06T13:00:00.000Z')), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM staff_audit_logs').get().count, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_points_ledger WHERE source_type = 'staff_of_week'").get().count, 1);
});