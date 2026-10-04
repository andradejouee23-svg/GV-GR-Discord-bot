const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { canRefreshStaffPanel } = require('../src/commands/clock');
const { isManagement, isOwner, isStaff } = require('../src/commands/staffCenter');
const { handleManagementButton, handleOwnerButton } = require('../src/commands/staffManagement');
const { handleButton } = require('../src/buttons');
const { logMessageDeletion } = require('../src/events/messageDelete');
const {
  createDailyReportComponents,
  createPermanentLeaderboardEmbed,
  createStaffCenterComponents,
} = require('../src/utils/staffCenter');
const { createDailyReportReminderComponents } = require('../src/commands/staffCenter');

function member(id, roleIds = []) {
  return { id, roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) } };
}

test('staff, management, and Owner access remain distinct', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-panel-permissions-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify(['1556064708795306157']));
  const guild = { ownerId: 'server-owner' };
  const regularStaff = member('staff-user', config.STAFF_ROLE_IDS);
  const manager = member('management-user', ['1556064708795306157']);
  const configuredOwner = member('configured-owner', config.OWNER_ROLE_IDS);
  const owner = member(guild.ownerId);

  assert.equal(isStaff(regularStaff, guild, db), true);
  assert.equal(isManagement(regularStaff, guild, db), false);
  assert.equal(isOwner(regularStaff, guild, db), false);
  assert.equal(isManagement(manager, guild, db), true);
  assert.equal(isOwner(manager, guild, db), false);
  assert.equal(isOwner(owner, guild, db), true);
  assert.equal(isManagement(owner, guild, db), true);
  assert.equal(canRefreshStaffPanel(owner, guild, db), true);
  assert.equal(canRefreshStaffPanel(configuredOwner, guild, db), true);
  assert.equal(canRefreshStaffPanel(regularStaff, guild, db), false);
  assert.equal(canRefreshStaffPanel(manager, guild, db), true);
});

test('a suspended management-role member loses management access', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-panel-status-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const userId = 'suspended-manager';
  const roleId = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([roleId]));
  db.prepare('INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'Manager', 'Admin', '2026-10-01T00:00:00.000Z');
  db.prepare('INSERT INTO staff_profiles (user_id, status, status_reason, updated_at) VALUES (?, ?, ?, ?)')
    .run(userId, 'suspended', 'Review', '2026-10-04T00:00:00.000Z');

  assert.equal(isManagement(member(userId, [roleId]), { ownerId: 'server-owner' }, db), false);
});

test('permanent leaderboard uses all-time points and refreshes from the ledger', (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-permanent-board-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  for (const [userId, username, points] of [['staff-a', 'A', 7], ['staff-b', 'B', 3]]) {
    db.prepare('INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES (?, ?, ?, ?)')
      .run(userId, username, 'Moderator', '2026-10-04T00:00:00.000Z');
    db.prepare(`
      INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, created_at)
      VALUES (?, ?, 'test', ?, 'Leaderboard test', '2026-10-04T00:00:00.000Z')
    `).run(userId, points, userId);
  }

  let description = createPermanentLeaderboardEmbed(db).data.description;
  assert.match(description, /<@staff-a>.*\*\*7 ⭐\*\*/);
  assert.match(description, /<@staff-b>.*\*\*3 ⭐\*\*/);

  db.prepare(`
    INSERT INTO staff_points_ledger (user_id, amount, source_type, source_id, reason, created_at)
    VALUES ('staff-b', 6, 'test', 'staff-b-extra', 'Leaderboard test', '2026-10-04T00:00:00.000Z')
  `).run();
  description = createPermanentLeaderboardEmbed(db).data.description;
  assert.ok(description.indexOf('<@staff-b>') < description.indexOf('<@staff-a>'));
  assert.match(description, /<@staff-b>.*\*\*9 ⭐\*\*/);
});

test('Staff Center buttons and report reminder open the expected private flows', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-staff-buttons-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const buttonIds = createStaffCenterComponents()
    .flatMap((row) => row.components.map((component) => component.data.custom_id));
  assert.deepEqual(buttonIds, [
    'gv:center:checkin',
    'gv:center:checkout',
    'gv:center:stats',
    'gv:center:leaderboard',
    'gv:center:weekly',
    'gv:center:streak',
    'gv:center:reports:0',
  ]);
  assert.ok(buttonIds.every((customId) => customId.startsWith('gv:center:')));

  const reportRatingValues = createDailyReportComponents(42)[0].components[0].toJSON().options.map((option) => option.value);
  assert.deepEqual(reportRatingValues, ['great', 'good', 'okay', 'bad']);
  assert.equal(createDailyReportReminderComponents({ id: 42 })[0].components[0].data.custom_id, 'gv:daily:remind:42');

  db.prepare('INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES (?, ?, ?, ?)')
    .run('report-owner', 'ReportOwner', 'Moderator', '2026-10-04T00:00:00.000Z');
  db.prepare(`
    INSERT INTO shifts (user_id, username, role_name, started_at, ended_at, duration_seconds, status)
    VALUES (?, ?, ?, ?, ?, ?, 'completed')
  `).run('report-owner', 'ReportOwner', 'Moderator', '2026-10-04T08:00:00.000Z', '2026-10-04T09:00:00.000Z', 3600);
  let replyPayload;
  await handleButton({
    customId: 'gv:daily:remind:1',
    user: { id: 'report-owner' },
    reply: async (payload) => { replyPayload = payload; },
  }, { db });
  assert.equal(replyPayload.ephemeral, true);
  assert.match(replyPayload.content, /checkout and shift points are already saved/i);
  assert.equal(replyPayload.components[0].components[0].data.custom_id, 'gv:daily:rating:1');

  let deniedPayload;
  await handleButton({
    customId: 'gv:daily:remind:1',
    user: { id: 'another-user' },
    reply: async (payload) => { deniedPayload = payload; },
  }, { db });
  assert.equal(deniedPayload.ephemeral, true);
  assert.match(deniedPayload.content, /not linked to one of your completed shifts/i);
});

test('management and Owner dashboard buttons work; Owner toggles user-only delete logs', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-dashboard-actions-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify(['1556064708795306157']));

  const owner = member('configured-owner', config.OWNER_ROLE_IDS);
  const manager = member('manager-user', ['1556064708795306157']);
  const server = { ownerId: 'discord-server-owner' };
  function createInteraction(customId, interactingMember) {
    return {
      customId,
      guild: server,
      member: interactingMember,
      user: { id: interactingMember.id },
      update: async (payload) => payload,
      reply: async (payload) => payload,
    };
  }

  for (const customId of ['mgmt:overview', 'mgmt:reports', 'mgmt:activity', 'mgmt:leaderboard']) {
    const result = await handleManagementButton(createInteraction(customId, manager), { db });
    assert.ok(result.embeds[0], `Management button ${customId} should update the dashboard.`);
  }
  for (const customId of ['owner:overview', 'owner:reports', 'owner:audit', 'owner:activity']) {
    const result = await handleOwnerButton(createInteraction(customId, owner), { db });
    assert.ok(result.embeds[0], `Owner button ${customId} should update the dashboard.`);
  }

  const toggleOffResult = await handleOwnerButton(createInteraction('owner:toggle_message_delete_logging', owner), { db });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'MESSAGE_DELETE_LOGGING_ENABLED'").get().value), false);
  assert.match(toggleOffResult.embeds[0].data.description, /Message deletion logs: \*\*Disabled\*\*/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action = 'message_delete_logging_toggle'").get().count, 1);

  const deletedMessage = {
    guild: {},
    author: { id: 'message-author', username: 'Player', bot: false },
    channelId: '123456789012345678',
    content: 'message contents are not logged',
  };
  const sent = [];
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (payload) => sent.push(payload),
      }),
    },
  };
  await logMessageDeletion(deletedMessage, client, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM moderation_logs WHERE action = 'message_delete'").get().count, 0);
  assert.equal(sent.length, 0);

  const toggleOnResult = await handleOwnerButton(createInteraction('owner:toggle_message_delete_logging', owner), { db });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'MESSAGE_DELETE_LOGGING_ENABLED'").get().value), true);
  assert.match(toggleOnResult.embeds[0].data.description, /Message deletion logs: \*\*Enabled\*\*/);
  await logMessageDeletion(deletedMessage, client, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM moderation_logs WHERE action = 'message_delete'").get().count, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].embeds[0].data.description, /\*\*User:\*\* <@message-author>/);
  assert.doesNotMatch(JSON.stringify(sent[0]), /message contents are not logged/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action = 'message_delete_logging_toggle'").get().count, 2);
});
