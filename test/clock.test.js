const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDatabase } = require('../src/database');
const { clockIn, clockOut, getOnDuty } = require('../src/services/clock');
const { refreshStaffPanel } = require('../src/commands/clock');
const { checkInStaff, checkOutStaff } = require('../src/services/staffRewards');

test('clock shifts persist across database reopen and cannot be duplicated', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-clock-'));
  const databasePath = path.join(directory, 'test.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const member = { id: 'staff-1', username: 'GreenvilleStaff', roleName: 'Moderator' };
  const firstStart = '2026-10-04T10:00:00.000Z';
  let db = createDatabase(databasePath);

  const started = clockIn(db, member, firstStart);
  assert.equal(started.alreadyOnDuty, false);
  assert.equal(clockIn(db, member, '2026-10-04T10:05:00.000Z').alreadyOnDuty, true);
  db.close();

  db = createDatabase(databasePath);
  assert.equal(getOnDuty(db).length, 1);

  const completed = clockOut(db, member.id, '2026-10-04T11:30:00.000Z');
  assert.equal(completed.duration_seconds, 90 * 60);
  assert.equal(clockOut(db, member.id, '2026-10-04T11:31:00.000Z'), null);
  assert.equal(getOnDuty(db).length, 0);

  const shifts = db.prepare('SELECT * FROM shifts WHERE user_id = ?').all(member.id);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].status, 'completed');
  assert.equal(shifts[0].role_name, 'Moderator');
  db.close();
});

test('the saved staff panel refreshes its current duty count after shift changes', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-clock-panel-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('panel_message', JSON.stringify('panel-message'));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('panel_channel', JSON.stringify('123456789012345678'));
  const updates = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    messages: { fetch: async () => ({ edit: async (payload) => updates.push(payload) }) },
  }) } };
  const guild = { members: { fetch: async () => {}, cache: { filter: () => ({ size: 0 }) } } };

  checkInStaff(db, { id: 'panel-staff', username: 'PanelStaff', roleName: 'Moderator' }, '2026-10-04T08:00:00.000Z');
  assert.equal(await refreshStaffPanel(client, guild, db), true);
  assert.match(updates.at(-1).embeds[0].data.fields[0].value, /Currently On Duty: \*\*1\*\*/);

  checkOutStaff(db, 'panel-staff', '2026-10-04T09:00:00.000Z');
  assert.equal(await refreshStaffPanel(client, guild, db), true);
  assert.match(updates.at(-1).embeds[0].data.fields[0].value, /Currently On Duty: \*\*0\*\*/);
});