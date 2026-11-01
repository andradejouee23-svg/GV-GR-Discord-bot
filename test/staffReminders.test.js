const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const {
  checkInStaff,
  checkOutStaff,
  getWeeklyGoalReminderCandidates,
  recordWeeklyGoalReminder,
} = require('../src/services/staffRewards');

function openDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-reminders-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('weekly goal reminders are opt-in and only sent once per staff member per week', (t) => {
  const db = openDatabase(t);
  const originalEnabled = config.WEEKLY_GOAL_REMINDER_ENABLED;
  const originalDay = config.WEEKLY_GOAL_REMINDER_DAY_UTC;
  const originalHour = config.WEEKLY_GOAL_REMINDER_HOUR_UTC;
  config.WEEKLY_GOAL_REMINDER_ENABLED = false;
  config.WEEKLY_GOAL_REMINDER_DAY_UTC = 0;
  config.WEEKLY_GOAL_REMINDER_HOUR_UTC = 18;
  t.after(() => {
    config.WEEKLY_GOAL_REMINDER_ENABLED = originalEnabled;
    config.WEEKLY_GOAL_REMINDER_DAY_UTC = originalDay;
    config.WEEKLY_GOAL_REMINDER_HOUR_UTC = originalHour;
  });

  const member = { id: 'weekly-staff', username: 'WeeklyStaff', roleName: 'Moderator' };
  checkInStaff(db, member, '2026-10-04T08:00:00.000Z');
  checkOutStaff(db, member.id, '2026-10-04T09:00:00.000Z');
  const sundayAt18Utc = new Date('2026-10-04T18:00:00.000Z');

  assert.equal(getWeeklyGoalReminderCandidates(db, sundayAt18Utc).length, 0);
  config.WEEKLY_GOAL_REMINDER_ENABLED = true;
  assert.deepEqual(getWeeklyGoalReminderCandidates(db, sundayAt18Utc), [{
    user_id: member.id,
    username: member.username,
  }]);
  recordWeeklyGoalReminder(db, member.id, '2026-09-28', {
    status: 'sent',
    messageId: '323456789012345678',
    now: sundayAt18Utc.toISOString(),
  });
  assert.equal(getWeeklyGoalReminderCandidates(db, sundayAt18Utc).length, 0);
  assert.equal(getWeeklyGoalReminderCandidates(db, new Date('2026-10-05T18:00:00.000Z')).length, 0);
});