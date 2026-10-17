const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChannelType } = require('discord.js');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { canRefreshStaffPanel } = require('../src/commands/clock');
const { isManagement, isOwner, isStaff } = require('../src/commands/staffCenter');
const {
  handleManagementButton,
  handleManagementShiftActionSelect,
  handleManagementShiftConfirm,
  handleManagementShiftModal,
  handleOwnerButton,
  handleOwnerCleanupSelect,
  handleOwnerSettingsModal,
  handleOwnerSettingsSelect,
} = require('../src/commands/staffManagement');
const { handleButton } = require('../src/buttons');
const { logMessageDeletion } = require('../src/events/messageDelete');
const {
  createDailyReportComponents,
  createPermanentLeaderboardEmbed,
  createStaffCenterComponents,
} = require('../src/utils/staffCenter');
const {
  createDailyReportReminderComponents,
  handleDailyReportSelect,
} = require('../src/commands/staffCenter');

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
    'gv:center:events',
    'gv:center:rp:start',
    'gv:center:rp:controls',
    'gv:center:rp:history',
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

test('daily report cooldown is shared across checkout and reminder entry points', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-daily-report-cooldown-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES (?, ?, ?, ?)')
    .run('report-cooldown-user', 'ReportUser', 'Moderator', '2026-10-17T00:00:00.000Z');
  for (const [start, end] of [['08:00', '09:00'], ['10:00', '11:00']]) {
    db.prepare(`INSERT INTO shifts (user_id, username, role_name, started_at, ended_at, duration_seconds, status)
      VALUES (?, ?, ?, ?, ?, 3600, 'completed')`)
      .run('report-cooldown-user', 'ReportUser', 'Moderator', `2026-10-17T${start}:00.000Z`, `2026-10-17T${end}:00.000Z`);
  }
  const user = { id: 'report-cooldown-user' };
  let modal;
  await handleDailyReportSelect({
    customId: 'gv:daily:rating:1', user, values: ['good'],
    showModal: async (value) => { modal = value; return value; },
    reply: async (payload) => payload,
  }, { db });
  assert.equal(modal.data.custom_id, 'gv:daily:submit:1:good');

  let blocked;
  await handleDailyReportSelect({
    customId: 'gv:daily:rating:2', user, values: ['great'],
    showModal: async () => { throw new Error('second entry point bypassed cooldown'); },
    reply: async (payload) => { blocked = payload; return payload; },
  }, { db });
  assert.equal(blocked.ephemeral, true);
  assert.match(blocked.content, /Daily report cooldown: try again in/);
});

test('management and Owner dashboard buttons work; deletion logging stays disabled', async (t) => {
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

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    .run('MESSAGE_DELETE_LOGGING_ENABLED', JSON.stringify(true));
  const staleToggleResult = await handleOwnerButton(createInteraction('owner:toggle_message_delete_logging', owner), { db });
  assert.match(staleToggleResult.content, /disabled/i);
  assert.doesNotMatch(JSON.stringify(staleToggleResult.components), /toggle_message_delete_logging/);

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
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'MESSAGE_DELETE_LOGGING_ENABLED'").get().value), true);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action = 'message_delete_logging_toggle'").get().count, 0);
});

test('Management can manually clock in a staff member with confirmation and audit attribution', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-manual-clock-ui-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const managerRoleId = '1556064708795306157';
  const staffRoleId = config.STAFF_ROLE_IDS[0];
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRoleId]));
  db.prepare('INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES (?, ?, ?, ?)')
    .run('manual-target', 'Target', 'Moderator', '2026-10-04T00:00:00.000Z');
  const manager = member('manual-manager', [managerRoleId]);
  const target = {
    id: 'manual-target',
    user: { username: 'Target' },
    roles: { cache: new Map([[staffRoleId, { name: 'Moderator' }]]) },
  };
  const guild = {
    ownerId: 'server-owner',
    members: { fetch: async (userId) => userId === target.id ? target : null },
  };
  const baseInteraction = {
    guild,
    member: manager,
    user: { id: manager.id, username: 'Manager' },
  };

  const modal = await handleManagementShiftActionSelect({
    ...baseInteraction,
    customId: 'mgmt:shift_action:manual-target',
    values: ['manual_clock_in'],
    showModal: async (value) => value,
    reply: async (payload) => payload,
  }, { db });
  assert.equal(modal.data.custom_id, 'mgmt:shift_modal:manual-target:manual_clock_in');

  const confirmation = await handleManagementShiftModal({
    ...baseInteraction,
    customId: modal.data.custom_id,
    fields: { getTextInputValue: () => 'Approved opening shift' },
    reply: async (payload) => payload,
  }, { db });
  assert.match(confirmation.embeds[0].data.description, /Clock In Manually/);
  const confirmId = confirmation.components[0].components[0].data.custom_id;
  const result = await handleManagementShiftConfirm({
    ...baseInteraction,
    customId: confirmId,
    client: {},
    deferUpdate: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db });

  assert.match(result.content, /applied and saved to the audit log/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE user_id = 'manual-target' AND status = 'active'").get().count, 1);
  assert.deepEqual(db.prepare(`SELECT action, target_id, actor_id, reason FROM staff_audit_logs
    WHERE action = 'shift_manual_clock_in'`).get(), {
    action: 'shift_manual_clock_in',
    target_id: 'manual-target',
    actor_id: 'manual-manager',
    reason: 'Approved opening shift',
  });
});

test('Owner cleanup deletes only confirmed old completed bot session posts', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-cleanup-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const owner = member('cleanup-owner', config.OWNER_ROLE_IDS);
  const guild = { id: 'cleanup-guild', ownerId: 'server-owner' };
  const oldDate = '2026-08-01T12:00:00.000Z';
  const insertSession = ({ name, status, lifecycleStatus, endedAt, messageId }) => db.prepare(`INSERT INTO sessions (
    name, description, host_id, host_name, started_at, ended_at, duration_seconds, status,
    session_code, lifecycle_status, channel_id, message_id
  ) VALUES (?, '', 'session-host', 'Host', ?, ?, ?, ?, ?, ?, 'session-channel', ?)`)
    .run(name, oldDate, endedAt, status === 'completed' ? 3600 : null, status,
      `GV-RP-${String(Math.random()).slice(2, 6)}`, lifecycleStatus, messageId).lastInsertRowid;
  const completedId = insertSession({ name: 'Old completed', status: 'completed', lifecycleStatus: 'completed', endedAt: oldDate, messageId: 'bot-post' });
  insertSession({ name: 'Old active', status: 'active', lifecycleStatus: 'active', endedAt: null, messageId: 'active-post' });
  const untrustedId = insertSession({ name: 'Untrusted message reference', status: 'completed', lifecycleStatus: 'completed', endedAt: oldDate, messageId: 'user-post' });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('panel_message', JSON.stringify('protected-panel'));

  const messages = {
    'bot-post': { author: { id: 'bot-id' }, delete: async () => { deleted.push('bot-post'); } },
    'user-post': { author: { id: 'human-id' }, delete: async () => { deleted.push('user-post'); } },
  };
  const deleted = [];
  const client = {
    user: { id: 'bot-id' },
    channels: { fetch: async () => ({
      isTextBased: () => true,
      messages: { fetch: async (messageId) => messages[messageId] ?? null },
    }) },
  };
  let preview;
  await handleOwnerCleanupSelect({
    customId: 'owner:cleanup:category', guild, member: owner,
    user: { id: owner.id }, values: ['completed_sessions'],
    reply: async (payload) => { preview = payload; },
  }, { db });
  assert.equal(preview.ephemeral, true);
  assert.match(preview.content, /\*\*2\*\* completed session announcement/);
  const confirmId = preview.components[0].components[0].data.custom_id;
  let finalPayload;
  await handleOwnerButton({
    customId: confirmId, guild, member: owner, user: { id: owner.id }, client,
    deferUpdate: async () => {},
    editReply: async (payload) => { finalPayload = payload; },
    reply: async (payload) => { finalPayload = payload; },
  }, { db });

  assert.deepEqual(deleted, ['bot-post']);
  assert.match(finalPayload.content, /\*\*1\*\* message\(s\) deleted; \*\*1\*\* skipped/);
  assert.equal(db.prepare('SELECT id FROM sessions WHERE id = ?').get(completedId).id, completedId);
  assert.equal(db.prepare('SELECT id FROM sessions WHERE id = ?').get(untrustedId).id, untrustedId);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'panel_message'").get().value), 'protected-panel');
  const audit = db.prepare("SELECT actor_id, details_json FROM staff_audit_logs WHERE action = 'message_cleanup'").get();
  assert.equal(audit.actor_id, owner.id);
  assert.deepEqual(JSON.parse(audit.details_json).deletedMessageIds, ['bot-post']);
});

test('Owner Settings updates channels, role groups, and timezone with audit records; Management is denied', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-owner-settings-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const owner = member('configured-owner', config.OWNER_ROLE_IDS);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = member('manager-user', [managerRole]);
  const guild = { id: 'guild-1', ownerId: 'actual-server-owner' };
  let lastReply;
  const interaction = (customId, actingMember, values = []) => ({
    customId,
    guild,
    member: actingMember,
    user: { id: actingMember.id, username: actingMember.id },
    values,
    fields: { getTextInputValue: () => 'America/Chicago' },
    isStringSelectMenu: () => ['owner:settings:channel', 'owner:settings:roles', 'owner:settings:session', 'owner:settings:categories'].includes(customId),
    isChannelSelectMenu: () => customId.startsWith('owner:settings:setchannel:') || customId.startsWith('owner:settings:setcategory:'),
    isRoleSelectMenu: () => customId.startsWith('owner:settings:saveroles:'),
    update: async (payload) => payload,
    showModal: async (payload) => payload,
    reply: async (payload) => { lastReply = payload; return payload; },
  });

  const settingsPanel = await handleOwnerButton(interaction('owner:settings', owner), { db });
  assert.match(settingsPanel.embeds[0].data.title, /SERVER SETTINGS/);
  assert.equal(settingsPanel.components.length, 5);

  const automodModal = await handleOwnerButton(interaction('owner:automod:core', owner), { db });
  assert.equal(automodModal.data.custom_id, 'owner:automod:core_modal');
  const automodSaved = await handleOwnerSettingsModal({
    ...interaction('owner:automod:core_modal', owner),
    fields: { getTextInputValue: (key) => ({
      enabled: 'true', mode: 'log', spam_threshold: '6', spam_window: '10', repeat_threshold: '3',
    })[key] },
  }, { db });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'AUTOMOD_ENABLED'").get().value), true);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'AUTOMOD_MODE'").get().value), 'log');
  assert.match(automodSaved.content, /Message Content privileged intent/i);
  await handleOwnerSettingsModal({
    ...interaction('owner:automod:core_modal', manager),
    fields: { getTextInputValue: () => 'true' },
  }, { db });
  assert.match(lastReply.content, /server owner or a configured Owner role/i);

  await handleOwnerSettingsSelect(interaction('owner:settings:channel', manager, ['EVENT_CHANNEL_ID']), { db });
  assert.match(lastReply.content, /Only the server owner or a configured Owner role/);

  const chooseChannel = await handleOwnerSettingsSelect(interaction('owner:settings:channel', owner, ['EVENT_CHANNEL_ID']), { db });
  assert.equal(chooseChannel.components[0].components[0].data.custom_id, 'owner:settings:setchannel:EVENT_CHANNEL_ID');
  const saveChannel = await handleOwnerSettingsSelect(interaction('owner:settings:setchannel:EVENT_CHANNEL_ID', owner, ['423456789012345678']), { db });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'EVENT_CHANNEL_ID'").get().value), '423456789012345678');
  assert.match(saveChannel.embeds[0].data.description, /<#423456789012345678>/);

  const chooseRoles = await handleOwnerSettingsSelect(interaction('owner:settings:roles', owner, ['management']), { db });
  assert.equal(chooseRoles.components[0].components[0].data.custom_id, 'owner:settings:saveroles:management');
  await handleOwnerSettingsSelect(interaction('owner:settings:saveroles:management', owner, ['523456789012345678']), { db });
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'role_management'").get().value), ['523456789012345678']);

  const recruitingRoles = await handleOwnerSettingsSelect(interaction('owner:settings:roles', owner, ['admin_recruiting']), { db });
  assert.equal(recruitingRoles.components[0].components[0].data.max_values, 1);
  await handleOwnerSettingsSelect(interaction('owner:settings:saveroles:admin_recruiting', owner, ['623456789012345678']), { db });
  assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'role_admin_recruiting'").get().value), ['623456789012345678']);

  const categories = await handleOwnerSettingsSelect(interaction('owner:settings:categories', owner, ['TICKET_RECRUITING_CATEGORY_ID']), { db });
  assert.equal(categories.components[0].components[0].data.channel_types[0], ChannelType.GuildCategory);
  const setCategory = await handleOwnerSettingsSelect(interaction('owner:settings:setcategory:TICKET_RECRUITING_CATEGORY_ID', owner, ['723456789012345678']), { db });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'TICKET_RECRUITING_CATEGORY_ID'").get().value), '723456789012345678');

  await handleOwnerSettingsModal(interaction('owner:settings:timezone_modal', owner), { db });
  assert.equal(lastReply.ephemeral, true);
  assert.match(lastReply.embeds[0].data.description, /America\/Chicago/);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'TIME_ZONE'").get().value), 'America/Chicago');
  await handleOwnerSettingsModal({
    ...interaction('owner:settings:timezone_modal', owner),
    fields: { getTextInputValue: () => 'Not/A_Real_Zone' },
  }, { db });
  assert.match(lastReply.content, /timezone is not valid/i);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'TIME_ZONE'").get().value), 'America/Chicago');

  const joinSettingModal = await handleOwnerSettingsSelect(interaction('owner:settings:session', owner, ['SESSION_JOIN_CODE']), { db });
  assert.equal(joinSettingModal.data.custom_id, 'owner:settings:session_modal:SESSION_JOIN_CODE');
  await handleOwnerSettingsModal({
    ...interaction('owner:settings:session_modal:SESSION_JOIN_CODE', owner),
    fields: { getTextInputValue: () => 'ACTUAL-CODE-123' },
  }, { db });
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'SESSION_JOIN_CODE'").get().value), 'ACTUAL-CODE-123');
  await handleOwnerSettingsModal({
    ...interaction('owner:settings:session_modal:SESSION_JOIN_URL', owner),
    fields: { getTextInputValue: () => 'http://unsafe.example' },
  }, { db });
  assert.match(lastReply.content, /valid HTTPS URL/i);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action IN ('configuration_change', 'permission_change')").get().count, 7);
});
