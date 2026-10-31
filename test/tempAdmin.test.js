const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const {
  createApplicationDraft,
  getApplicationSettings,
  handleTempAdminButton,
  handleTempAdminCommand,
  handleTempAdminModal,
  processTemporaryAdminExpirations,
} = require('../src/commands/tempAdmin');
const { setConfigValue } = require('../src/utils/discord');

const managerId = 'temporary-admin-manager';
const managerRoleId = '1556064708795306157';
const adminRoleId = '1666064708795306156';
const reviewChannelId = '1666064708795306157';
const panelChannelId = '1666064708795306158';

function createEnvironment(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-temp-admin-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRoleId]));

  const assignedRole = { id: adminRoleId, name: 'Temporary Admin', position: 2, managed: false };
  const manager = { id: managerId, roles: { cache: new Map([[managerRoleId, { id: managerRoleId, name: 'Admin' }]]) } };
  const members = new Map();
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'server-owner',
    roles: { fetch: async (id) => id === adminRoleId ? assignedRole : null },
    members: {
      me: { permissions: { has: () => true }, roles: { highest: { position: 10 } } },
      fetch: async (id) => {
        if (id === managerId) return manager;
        const member = members.get(id);
        if (!member) throw Object.assign(new Error('Unknown member'), { code: 10007 });
        return member;
      },
    },
  };
  const reviewPosts = [];
  const reviewEdits = [];
  const panelPosts = [];
  const panelEdits = [];
  const dms = [];
  const reviewChannel = {
    id: reviewChannelId,
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      reviewPosts.push(payload);
      return { id: String(1776064708795306156 + reviewPosts.length) };
    },
    messages: { fetch: async () => ({ edit: async (payload) => { reviewEdits.push(payload); return payload; } }) },
  };
  const panelChannel = {
    id: panelChannelId,
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      panelPosts.push(payload);
      return { id: '1776064708795306199' };
    },
    messages: { fetch: async () => ({ edit: async (payload) => { panelEdits.push(payload); return { id: '1776064708795306199' }; } }) },
  };
  const client = {
    guilds: { cache: new Map([[config.SERVER_ID, guild]]) },
    channels: { fetch: async (id) => id === reviewChannelId ? reviewChannel : id === panelChannelId ? panelChannel : null },
    users: {
      fetch: async (id) => ({ send: async (payload) => { dms.push({ id, payload }); } }),
    },
  };
  setConfigValue(db, 'TEMP_ADMIN_ROLE_ID', adminRoleId);
  setConfigValue(db, 'TEMP_ADMIN_REVIEW_CHANNEL_ID', reviewChannelId);
  return { db, guild, client, members, assignedRole, reviewPosts, reviewEdits, panelPosts, panelEdits, dms, reviewChannel, panelChannel };
}

function addApplicant(env, userId, username = 'Applicant') {
  const roles = new Map();
  const member = {
    id: userId,
    roles: {
      cache: roles,
      add: async (role) => { roles.set(role.id, role); },
      remove: async (role) => { roles.delete(typeof role === 'string' ? role : role.id); },
    },
    username,
  };
  env.members.set(userId, member);
  return member;
}

function managerInteraction(env, properties = {}) {
  return {
    guild: env.guild,
    client: env.client,
    user: { id: managerId, username: 'Manager' },
    ...properties,
  };
}

function makeApplicationOptions(values = {}) {
  return {
    getString: (name) => values[name] ?? null,
    getInteger: (name) => values[name] ?? null,
    getRole: () => values.role ?? null,
    getChannel: (name) => values[name] ?? null,
    getUser: (name) => values[name] ?? null,
  };
}

async function submitApplication(env, applicantId, answers) {
  const settings = getApplicationSettings(env.db);
  const draftId = createApplicationDraft(env.db, applicantId, settings);
  let response;
  await handleTempAdminModal({
    customId: `gv:tempadmin:apply:${draftId}`,
    user: { id: applicantId, username: applicantId },
    guild: env.guild,
    client: env.client,
    fields: { getTextInputValue: (id) => answers[Number(id.slice('answer_'.length))] },
    reply: async (payload) => { response = payload; return payload; },
  }, { db: env.db });
  return response;
}

test('management configures and publishes the application panel; submitted forms retain question snapshots', async (t) => {
  const env = createEnvironment(t);
  const options = makeApplicationOptions({
    title: 'GV GR Temporary Admin',
    description: 'Answer carefully before applying.',
    role: env.assignedRole,
    'review-channel': env.reviewChannel,
    'duration-hours': 24,
    'question-1': 'Why do you want this role?',
    'question-2': 'Describe your experience.',
  });
  const configured = await handleTempAdminCommand(managerInteraction(env, {
    commandName: 'tempadmin',
    options: { getSubcommand: () => 'configure', ...options },
    reply: async (payload) => payload,
  }), { db: env.db });
  assert.match(configured.content, /Updated temporary admin settings/);

  const panel = await handleTempAdminCommand(managerInteraction(env, {
    commandName: 'tempadmin',
    options: { getSubcommand: () => 'panel', getChannel: () => env.panelChannel },
    reply: async (payload) => payload,
  }), { db: env.db });
  assert.match(panel.content, /posted/);
  const refreshed = await handleTempAdminCommand(managerInteraction(env, {
    commandName: 'tempadmin',
    options: { getSubcommand: () => 'panel', getChannel: () => env.panelChannel },
    reply: async (payload) => payload,
  }), { db: env.db });
  assert.match(refreshed.content, /refreshed/);
  assert.equal(env.panelPosts.length, 1);
  assert.equal(env.panelEdits.length, 1);
  assert.equal(env.panelPosts[0].embeds[0].data.title, 'GV GR Temporary Admin');
  assert.equal(env.panelPosts[0].components[0].components[0].data.custom_id, 'gv:tempadmin:apply');

  let modal;
  await handleTempAdminButton({
    customId: 'gv:tempadmin:apply',
    user: { id: 'applicant-a', username: 'Applicant A' },
    showModal: async (value) => { modal = value; return value; },
    reply: async (payload) => payload,
  }, { db: env.db });
  assert.equal(modal.toJSON().components.length, 2);
  setConfigValue(env.db, 'TEMP_ADMIN_APPLICATION_QUESTIONS', ['Changed after opening']);
  let submitted;
  await handleTempAdminModal({
    customId: modal.toJSON().custom_id,
    user: { id: 'applicant-a', username: 'applicant-a' },
    guild: env.guild,
    client: env.client,
    fields: { getTextInputValue: (id) => id === 'answer_0' ? 'I want to support the server.' : 'I have moderated before.' },
    reply: async (payload) => { submitted = payload; return payload; },
  }, { db: env.db });
  assert.match(submitted.content, /sent to management for review/);
  const application = env.db.prepare('SELECT * FROM temporary_admin_applications').get();
  assert.deepEqual(JSON.parse(application.questions_json), ['Why do you want this role?', 'Describe your experience.']);
  assert.equal(application.duration_hours, 24);
  assert.match(env.reviewPosts[0].embeds[0].data.title, /GV GR Temporary Admin/);
  assert.equal(env.reviewPosts[0].components[0].components.length, 2);

  let duplicateReply;
  await handleTempAdminButton({
    customId: 'gv:tempadmin:apply',
    user: { id: 'applicant-a', username: 'Applicant A' },
    reply: async (payload) => { duplicateReply = payload; return payload; },
  }, { db: env.db });
  assert.match(duplicateReply.content, /already have a Temporary Admin application/);
});

test('management-only approval and denial update roles, history, and private notifications', async (t) => {
  const env = createEnvironment(t);
  setConfigValue(env.db, 'TEMP_ADMIN_DURATION_HOURS', 1);
  const applicant = addApplicant(env, 'applicant-approve');
  const deniedApplicant = addApplicant(env, 'applicant-deny');
  const approvedSubmission = await submitApplication(env, applicant.id, ['Answer one.', 'Answer two.', 'Answer three.']);
  const deniedSubmission = await submitApplication(env, deniedApplicant.id, ['Answer one.', 'Answer two.', 'Answer three.']);
  assert.match(approvedSubmission.content, /sent to management/);
  assert.match(deniedSubmission.content, /sent to management/);
  const [approvedApp, deniedApp] = env.db.prepare('SELECT * FROM temporary_admin_applications ORDER BY id').all();

  let unauthorizedReply;
  await handleTempAdminButton({
    ...managerInteraction(env, { user: { id: 'unauthorized-user', username: 'Player' } }),
    customId: `gv:tempadmin:approve:${approvedApp.id}`,
    reply: async (payload) => { unauthorizedReply = payload; return payload; },
  }, { db: env.db });
  assert.match(unauthorizedReply.content, /management roles only/i);
  assert.equal(applicant.roles.cache.has(adminRoleId), false);

  let approvedMessage;
  await handleTempAdminButton(managerInteraction(env, {
    customId: `gv:tempadmin:approve:${approvedApp.id}`,
    update: async (payload) => { approvedMessage = payload; return payload; },
    followUp: async (payload) => payload,
  }), { db: env.db });
  const approved = env.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(approvedApp.id);
  assert.equal(approved.status, 'approved');
  assert.equal(applicant.roles.cache.has(adminRoleId), true);
  assert.ok(approved.expires_at);
  assert.match(approvedMessage.embeds[0].data.title, /Approved/);
  assert.equal(env.dms.length, 1);

  let denialModal;
  await handleTempAdminButton(managerInteraction(env, {
    customId: `gv:tempadmin:deny:${deniedApp.id}`,
    showModal: async (value) => { denialModal = value; return value; },
  }), { db: env.db });
  assert.equal(denialModal.toJSON().custom_id, `gv:tempadmin:deny_submit:${deniedApp.id}`);
  let denialReply;
  await handleTempAdminModal(managerInteraction(env, {
    customId: `gv:tempadmin:deny_submit:${deniedApp.id}`,
    fields: { getTextInputValue: () => 'Insufficient detail.' },
    reply: async (payload) => { denialReply = payload; return payload; },
  }), { db: env.db });
  const denied = env.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(deniedApp.id);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.decision_reason, 'Insufficient detail.');
  assert.match(denialReply.content, /notified privately/);
  assert.equal(env.dms.length, 2);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM temporary_admin_application_history WHERE action IN (\'approved\', \'denied\')').get().count, 2);
});

test('temporary role expiration removes the role once and recovers interrupted approvals', async (t) => {
  const env = createEnvironment(t);
  const applicant = addApplicant(env, 'applicant-expiry');
  const submitted = await submitApplication(env, applicant.id, ['Answer one.', 'Answer two.', 'Answer three.']);
  assert.match(submitted.content, /sent to management/);
  const application = env.db.prepare('SELECT * FROM temporary_admin_applications').get();
  const past = new Date(Date.now() - 3600_000).toISOString();
  env.db.prepare(`UPDATE temporary_admin_applications SET status = 'approved', reviewed_at = ?, reviewer_id = ?, expires_at = ?, requested_role_id = ? WHERE id = ?`)
    .run(past, managerId, past, adminRoleId, application.id);
  applicant.roles.cache.set(adminRoleId, env.assignedRole);
  const removed = await processTemporaryAdminExpirations(env.client, env.db, new Date());
  assert.equal(removed, 1);
  assert.equal(applicant.roles.cache.has(adminRoleId), false);
  assert.equal(env.db.prepare('SELECT status FROM temporary_admin_applications WHERE id = ?').get(application.id).status, 'expired');

  const recoveryApplicant = addApplicant(env, 'applicant-recovery');
  const recoverySubmit = await submitApplication(env, recoveryApplicant.id, ['Answer one.', 'Answer two.', 'Answer three.']);
  assert.match(recoverySubmit.content, /sent to management/);
  const recovery = env.db.prepare('SELECT * FROM temporary_admin_applications WHERE applicant_id = ?').get(recoveryApplicant.id);
  const reviewedAt = new Date().toISOString();
  env.db.prepare(`UPDATE temporary_admin_applications SET status = 'approving', reviewed_at = ?, reviewer_id = ? WHERE id = ?`)
    .run(reviewedAt, managerId, recovery.id);
  recoveryApplicant.roles.cache.set(adminRoleId, env.assignedRole);
  await processTemporaryAdminExpirations(env.client, env.db, new Date());
  const recovered = env.db.prepare('SELECT status, expires_at FROM temporary_admin_applications WHERE id = ?').get(recovery.id);
  assert.equal(recovered.status, 'approved');
  assert.ok(recovered.expires_at);
});