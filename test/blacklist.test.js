const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleBlacklistButton, handleBlacklistCommand, handleBlacklistModal, processBlacklistExpirations } = require('../src/commands/blacklist');
const { setConfigValue } = require('../src/utils/discord');

const managerId = '1666064708795306156';
const managerRoleId = '1556064708795306157';
const recordChannelId = '1666064708795306157';
const appealChannelId = '1666064708795306158';
const panelChannelId = '1666064708795306159';
const applicantId = '1666064708795306160';

function environment(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-blacklist-'));
  const db = createDatabase(path.join(directory, 'blacklist.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  setConfigValue(db, 'role_management', [managerRoleId]);
  setConfigValue(db, 'BLACKLIST_CHANNEL_ID', recordChannelId);
  setConfigValue(db, 'BLACKLIST_APPEAL_REVIEW_CHANNEL_ID', appealChannelId);
  setConfigValue(db, 'BLACKLIST_PANEL_CHANNEL_ID', panelChannelId);
  const manager = { id: managerId, roles: { cache: new Map([[managerRoleId, {}]]) } };
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'owner',
    members: { fetch: async (id) => id === managerId ? manager : null, me: {} },
  };
  const sent = [];
  const edits = [];
  const dms = [];
  const channels = new Map();
  for (const id of [recordChannelId, appealChannelId, panelChannelId]) {
    channels.set(id, {
      id,
      guildId: guild.id,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      send: async (payload) => {
        sent.push({ channelId: id, payload });
        return { id: `message-${sent.length}` };
      },
      messages: { fetch: async () => ({ edit: async (payload) => { edits.push({ id, payload }); return payload; } }) },
    });
  }
  const client = {
    channels: { fetch: async (id) => channels.get(id) },
    users: { fetch: async (id) => ({ send: async (payload) => { dms.push({ id, payload }); } }) },
  };
  return { db, guild, client, sent, edits, dms, panelChannel: channels.get(panelChannelId) };
}

function modalInteraction(env, userId, customId, values) {
  return {
    customId,
    user: { id: userId, username: userId === managerId ? 'Manager' : 'AppealPlayer' },
    guild: env.guild,
    client: env.client,
    fields: { getTextInputValue: (key) => values[key] ?? '' },
    reply: async (payload) => payload,
    showModal: async (modal) => modal,
  };
}

function commandInteraction(env, action, options = {}) {
  return {
    commandName: 'blacklist',
    options: { getSubcommand: () => action, ...options },
    user: { id: managerId, username: 'Manager' },
    guild: env.guild,
    client: env.client,
    reply: async (payload) => payload,
  };
}

test('blacklist records are created from Discord modals, reject active duplicates, searchable, editable with confirmation, and expire persistently', async (t) => {
  const env = environment(t);
  let firstModal;
  await handleBlacklistButton({
    customId: 'gv:blacklist:blacklist',
    user: { id: managerId }, guild: env.guild, client: env.client,
    showModal: async (modal) => { firstModal = modal; return modal; },
    reply: async (payload) => payload,
  }, { db: env.db });
  const createId = firstModal.data.custom_id;
  const createContinue = await handleBlacklistModal(modalInteraction(env, managerId, createId, {
    roblox_name: 'GreenvilleDriver', roblox_id: 'roblox-123', discord_name: 'AppealPlayer', discord_id: applicantId, reason: 'Repeated exploit use',
  }), { db: env.db });
  let detailsModal;
  await handleBlacklistButton({
    customId: createContinue.components[0].components[0].data.custom_id,
    user: { id: managerId }, guild: env.guild, client: env.client,
    showModal: async (modal) => { detailsModal = modal; return modal; },
    reply: async (payload) => payload,
  }, { db: env.db });
  const created = await handleBlacklistModal(modalInteraction(env, managerId, detailsModal.data.custom_id, {
    evidence: 'https://example.com/evidence', duration: '7d', staff_notes: 'Reviewed by management',
  }), { db: env.db });
  const recordId = env.db.prepare('SELECT record_id FROM blacklist_records').get().record_id;
  assert.match(created.content, /saved and posted/);
  assert.match(created.content, /Player was blacklisted/);
  assert.match(created.embeds[0].data.title, new RegExp(recordId));
  assert.match(created.embeds[0].data.description, /Repeated exploit use/);
  let record = env.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(recordId);
  assert.equal(record.status, 'active');
  assert.equal(record.duration_hours, 168);
  assert.ok(record.expires_at);
  assert.ok(record.message_id);

  let duplicateModal;
  await handleBlacklistButton({
    customId: 'gv:blacklist:blacklist', user: { id: managerId }, guild: env.guild, client: env.client,
    showModal: async (modal) => { duplicateModal = modal; return modal; }, reply: async (payload) => payload,
  }, { db: env.db });
  const duplicateContinue = await handleBlacklistModal(modalInteraction(env, managerId, duplicateModal.data.custom_id, {
    roblox_name: 'AnotherAlias', roblox_id: 'roblox-123', discord_name: 'Other', discord_id: '1666064708795306161', reason: 'Duplicate',
  }), { db: env.db });
  let duplicateDetails;
  await handleBlacklistButton({
    customId: duplicateContinue.components[0].components[0].data.custom_id,
    user: { id: managerId }, guild: env.guild, client: env.client,
    showModal: async (modal) => { duplicateDetails = modal; return modal; },
    reply: async (payload) => payload,
  }, { db: env.db });
  const duplicateReply = await handleBlacklistModal(modalInteraction(env, managerId, duplicateDetails.data.custom_id, { duration: '1d' }), { db: env.db });
  assert.match(duplicateReply.content, /already has active blacklist record/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM blacklist_records').get().count, 1);

  const searched = await handleBlacklistCommand(commandInteraction(env, 'search', { getString: () => 'roblox-123' }), { db: env.db });
  assert.match(searched.embeds[0].data.description, new RegExp(recordId));
  let editModal;
  await handleBlacklistButton({
    customId: `gv:blacklist:record:edit:${recordId}`, user: { id: managerId }, guild: env.guild, client: env.client,
    showModal: async (modal) => { editModal = modal; return modal; }, reply: async (payload) => payload,
  }, { db: env.db });
  const editContinue = await handleBlacklistModal(modalInteraction(env, managerId, editModal.data.custom_id, {
    roblox_name: 'GreenvilleDriver', roblox_id: 'roblox-123', discord_name: 'AppealPlayer', discord_id: applicantId, reason: 'Updated reason',
  }), { db: env.db });
  let nextEditModal;
  await handleBlacklistButton({
    customId: editContinue.components[0].components[0].data.custom_id,
    user: { id: managerId }, guild: env.guild, client: env.client,
    showModal: async (modal) => { nextEditModal = modal; return modal; },
    reply: async (payload) => payload,
  }, { db: env.db });
  const preview = await handleBlacklistModal(modalInteraction(env, managerId, nextEditModal.data.custom_id, {
    evidence: 'https://example.com/new-evidence', duration: '14d', expiration: 'permanent', status: 'active', staff_notes: 'Updated notes',
  }), { db: env.db });
  assert.match(preview.embeds[0].data.title, /Confirm Edit/);
  const confirmId = preview.components[0].components[0].data.custom_id;
  const saved = await handleBlacklistButton({ customId: confirmId, user: { id: managerId }, guild: env.guild, client: env.client, reply: async (payload) => payload }, { db: env.db });
  assert.match(saved.embeds[0].data.title, /Updated/);
  record = env.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(recordId);
  assert.equal(record.reason, 'Updated reason');
  assert.equal(record.duration_hours, 336);
  assert.equal(record.expires_at, null);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM blacklist_record_history WHERE record_id = ?').get(recordId).count, 2);

  env.db.prepare('UPDATE blacklist_records SET expires_at = ? WHERE record_id = ?').run('2020-01-01T00:00:00.000Z', recordId);
  assert.equal(await processBlacklistExpirations(env.client, env.db, new Date('2026-11-01T00:00:00.000Z')), 1);
  assert.equal(env.db.prepare('SELECT status FROM blacklist_records WHERE record_id = ?').get(recordId).status, 'expired');
});

test('appeals link to saved records, prevent repeat pending submissions, support management decisions, notes, and notifications', async (t) => {
  const env = environment(t);
  const now = new Date().toISOString();
  const recordId = 'BL-ABCDEF012345';
  env.db.prepare(`INSERT INTO blacklist_records (record_id, roblox_username, roblox_user_id, discord_username, discord_user_id, reason, duration_hours, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
    .run(recordId, 'AppealPlayer', 'roblox-appeal', 'AppealPlayer', applicantId, 'Test reason', 168, managerId, now, now);

  const appealModal = await handleBlacklistButton({ customId: 'gv:blacklist:appeal', user: { id: applicantId }, showModal: async (modal) => modal }, { db: env.db });
  const submitted = await handleBlacklistModal(modalInteraction(env, applicantId, appealModal.data.custom_id, {
    roblox_name: 'AppealPlayer',
    reconsideration: 'I would like management to reconsider the decision.',
  }), { db: env.db });
  assert.match(submitted.content, /submitted for management review/);
  const appeal = env.db.prepare('SELECT * FROM blacklist_appeals').get();
  assert.equal(appeal.record_id, recordId);
  assert.equal(appeal.status, 'pending');
  assert.equal(env.db.prepare('SELECT status FROM blacklist_records WHERE record_id = ?').get(recordId).status, 'active');

  const duplicateFirst = await handleBlacklistButton({ customId: 'gv:blacklist:appeal', user: { id: applicantId }, showModal: async (modal) => modal }, { db: env.db });
  const duplicateReply = await handleBlacklistModal(modalInteraction(env, applicantId, duplicateFirst.data.custom_id, {
    roblox_name: 'AppealPlayer', reconsideration: 'Another request.',
  }), { db: env.db });
  assert.match(duplicateReply.content, /appeal in progress/);

  let editAppealModal;
  await handleBlacklistButton({
    customId: `gv:blacklist:review:edit:${appeal.appeal_id}`,
    user: { id: managerId }, guild: env.guild,
    showModal: async (modal) => { editAppealModal = modal; return modal; },
    reply: async (payload) => payload,
  }, { db: env.db });
  const editedAppeal = await handleBlacklistModal(modalInteraction(env, managerId, editAppealModal.data.custom_id, {
    record_id: recordId,
    reconsideration: 'Please reconsider with corrected facts.',
    incident: 'Corrected incident explanation.',
    return_reason: 'I can return under supervision.',
    evidence: 'https://example.com/appeal-evidence',
  }), { db: env.db });
  assert.match(editedAppeal.content, /updated and added to its history/);
  assert.equal(env.db.prepare('SELECT reconsideration_reason FROM blacklist_appeals WHERE appeal_id = ?').get(appeal.appeal_id).reconsideration_reason, 'Please reconsider with corrected facts.');

  let approveModal;
  await handleBlacklistButton({
    customId: `gv:blacklist:review:approve:${appeal.appeal_id}`, user: { id: managerId }, guild: env.guild,
    showModal: async (modal) => { approveModal = modal; return modal; }, reply: async (payload) => payload,
  }, { db: env.db });
  const decision = await handleBlacklistModal(modalInteraction(env, managerId, approveModal.data.custom_id, { resolution: 'remove', management_note: 'Appeal accepted.' }), { db: env.db });
  assert.match(decision.content, /approved/);
  assert.equal(env.db.prepare('SELECT status FROM blacklist_records WHERE record_id = ?').get(recordId).status, 'removed');
  assert.equal(env.db.prepare('SELECT status FROM blacklist_appeals WHERE appeal_id = ?').get(appeal.appeal_id).status, 'approved');
  assert.ok(env.dms.length >= 1);

  const appealHistory = env.db.prepare('SELECT COUNT(*) AS count FROM blacklist_appeal_history WHERE appeal_id = ?').get(appeal.appeal_id).count;
  assert.equal(appealHistory, 3);
});

test('players can answer an information request and return their saved appeal to management review', async (t) => {
  const env = environment(t);
  const now = new Date().toISOString();
  const recordId = 'BL-RESPONSE1234';
  const appealId = 'AP-RESPONSE1234';
  env.db.prepare(`INSERT INTO blacklist_records (record_id, roblox_username, discord_username, reason, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`)
    .run(recordId, 'ResponsePlayer', 'ResponsePlayer', 'Test', managerId, now, now);
  env.db.prepare(`INSERT INTO blacklist_appeals (appeal_id, record_id, applicant_id, roblox_username, discord_username, blacklist_record_id, reconsideration_reason, incident_explanation, return_reason, status, submitted_at, decision_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'info_requested', ?, ?)`)
    .run(appealId, recordId, applicantId, 'ResponsePlayer', 'ResponsePlayer', recordId, 'Please review', 'I understand', 'I will follow rules', now, 'Provide a schedule');
  const response = await handleBlacklistCommand({
    commandName: 'blacklist',
    options: { getSubcommand: () => 'respond', getString: (name) => name === 'appeal-id' ? appealId : 'I am available after 5 PM.' },
    user: { id: applicantId },
    client: env.client,
    reply: async (payload) => payload,
  }, { db: env.db });
  assert.match(response.content, /returned to the management review queue/);
  const saved = env.db.prepare('SELECT status, applicant_response FROM blacklist_appeals WHERE appeal_id = ?').get(appealId);
  assert.equal(saved.status, 'pending');
  assert.equal(saved.applicant_response, 'I am available after 5 PM.');
  assert.equal(env.db.prepare("SELECT COUNT(*) AS count FROM blacklist_appeal_history WHERE appeal_id = ? AND action = 'applicant_response_submitted'").get(appealId).count, 1);
});
