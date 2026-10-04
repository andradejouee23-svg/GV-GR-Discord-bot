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
  getPendingDailyReportReminders,
  getWeeklyGoalReminderCandidates,
  recordDailyReportReminder,
  recordWeeklyGoalReminder,
  submitDailyReport,
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

test('daily report reminders wait, retry failures, and stop after a report is submitted', (t) => {
  const db = openDatabase(t);
  const originalDelay = config.DAILY_REPORT_REMINDER_MINUTES;
  const originalRetry = config.DAILY_REPORT_REMINDER_RETRY_HOURS;
  config.DAILY_REPORT_REMINDER_MINUTES = 20;
  config.DAILY_REPORT_REMINDER_RETRY_HOURS = 1;
  t.after(() => {
    config.DAILY_REPORT_REMINDER_MINUTES = originalDelay;
    config.DAILY_REPORT_REMINDER_RETRY_HOURS = originalRetry;
  });

  const member = { id: 'report-staff', username: 'ReportStaff', roleName: 'Moderator' };
  checkInStaff(db, member, '2026-10-04T08:00:00.000Z');
  const shift = checkOutStaff(db, member.id, '2026-10-04T10:00:00.000Z');

  assert.equal(getPendingDailyReportReminders(db, new Date('2026-10-04T10:19:59.000Z')).length, 0);
  assert.equal(getPendingDailyReportReminders(db, new Date('2026-10-04T10:20:00.000Z'))[0].id, shift.id);

  recordDailyReportReminder(db, shift.id, {
    status: 'failed',
    now: '2026-10-04T10:20:00.000Z',
  });
  assert.equal(getPendingDailyReportReminders(db, new Date('2026-10-04T11:19:59.000Z')).length, 0);
  assert.equal(getPendingDailyReportReminders(db, new Date('2026-10-04T11:20:00.000Z'))[0].id, shift.id);

  recordDailyReportReminder(db, shift.id, {
    status: 'sent',
    channelId: '123456789012345678',
    messageId: '223456789012345678',
    now: '2026-10-04T11:20:00.000Z',
  });
  const report = submitDailyReport(db, {
    userId: member.id,
    shiftId: shift.id,
    rating: 'good',
    now: '2026-10-04T11:30:00.000Z',
  });
  assert.deepEqual(report.reminders, [{
    channel_id: '123456789012345678',
    message_id: '223456789012345678',
  }]);
  assert.equal(db.prepare('SELECT delivery_status FROM staff_report_reminders WHERE shift_id = ?').get(shift.id).delivery_status, 'completed');
  assert.equal(getPendingDailyReportReminders(db, new Date('2026-10-04T12:00:00.000Z')).length, 0);
});

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