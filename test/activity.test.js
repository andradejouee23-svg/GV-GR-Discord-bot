const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDatabase } = require('../src/database');
const { getLeaderboard, getShiftSummary } = require('../src/services/activity');

test('activity totals include active shift time and calculate weekly and monthly hours', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-activity-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const now = new Date('2026-10-04T12:00:00.000Z');
  db.prepare("INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES ('staff-1', 'One', 'Moderator', ?)").run(now.toISOString());
  db.prepare(`
    INSERT INTO shifts (user_id, username, role_name, started_at, ended_at, duration_seconds, status)
    VALUES ('staff-1', 'One', 'Moderator', '2026-10-03T10:00:00.000Z', '2026-10-03T12:00:00.000Z', 7200, 'completed')
  `).run();
  db.prepare(`
    INSERT INTO shifts (user_id, username, role_name, started_at)
    VALUES ('staff-1', 'One', 'Moderator', '2026-10-04T11:00:00.000Z')
  `).run();
  db.prepare("INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES ('staff-2', 'Two', 'Admin', ?)").run(now.toISOString());
  db.prepare(`
    INSERT INTO shifts (user_id, username, role_name, started_at, ended_at, duration_seconds, status)
    VALUES ('staff-2', 'Two', 'Admin', '2026-10-04T09:00:00.000Z', '2026-10-04T10:00:00.000Z', 3600, 'completed')
  `).run();

  const summary = getShiftSummary(db, 'staff-1', now);
  assert.equal(summary.totalSeconds, 3 * 60 * 60);
  assert.equal(summary.shiftsCompleted, 1);
  assert.equal(summary.averageSeconds, 2 * 60 * 60);
  assert.equal(summary.weekSeconds, 3 * 60 * 60);
  assert.equal(summary.monthSeconds, 3 * 60 * 60);
  assert.equal(summary.currentShift.started_at, '2026-10-04T11:00:00.000Z');

  assert.deepEqual(
    getLeaderboard(db, 'weekly', now).map((entry) => entry.user_id),
    ['staff-1', 'staff-2'],
  );
});