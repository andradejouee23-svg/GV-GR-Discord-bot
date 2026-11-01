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
  handleTempAdminSelect,
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
  const completeAnswers = Array.from({ length: settings.questions.length }, (_, index) => answers[index] ?? `Completed response ${index + 1}.`);
  const draftId = createApplicationDraft(env.db, applicantId, settings);
  const pageCount = Math.ceil(settings.questions.length / 5);
  let customId = pageCount > 1 ? `gv:tempadmin:apply:${draftId}:0` : `gv:tempadmin:apply:${draftId}`;
  let response;
  for (let page = 0; page < pageCount; page += 1) {
    await handleTempAdminModal({
      customId,
      user: { id: applicantId, username: applicantId },
      guild: env.guild,
      client: env.client,
      fields: { getTextInputValue: (id) => completeAnswers[Number(id.slice('answer_'.length))] },
      reply: async (payload) => { response = payload; return payload; },
    }, { db: env.db });
    if (page < pageCount - 1) {
      let nextModal;
      const nextId = response.components[0].components.at(-1).data.custom_id;
      await handleTempAdminButton({
        customId: nextId,
        user: { id: applicantId, username: applicantId },
        showModal: async (modal) => { nextModal = modal; return modal; },
        reply: async (payload) => payload,
      }, { db: env.db });
      customId = nextModal.data.custom_id;
    }
  }
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
  assert.equal(env.reviewPosts[0].components[0].components.length, 4);

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
  assert.equal(approved.trial_started_at, approved.reviewed_at);
  assert.equal(approved.assigned_manager_id, managerId);
  const initialExpires = approved.expires_at;
  let extensionReply;
  await handleTempAdminCommand(managerInteraction(env, {
    commandName: 'tempadmin',
    options: {
      getSubcommand: () => 'trial-extend',
      getInteger: (name) => name === 'hours' ? 24 : approvedApp.id,
      getString: () => 'Strong attendance',
    },
    reply: async (payload) => { extensionReply = payload; return payload; },
  }), { db: env.db });
  const extended = env.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(approvedApp.id);
  assert.match(extensionReply.content, /Trial extended/);
  assert.ok(new Date(extended.expires_at).getTime() > new Date(initialExpires).getTime());
  assert.equal(extended.trial_extensions, 1);

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
  assert.equal(env.dms.length, 5);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS count FROM temporary_admin_application_history WHERE action IN (\'approved\', \'denied\')').get().count, 2);
});

test('management can hold, request information, resume, and record applicant responses', async (t) => {
  const env = createEnvironment(t);
  const applicant = addApplicant(env, 'applicant-info');
  await submitApplication(env, applicant.id, ['Answer one.', 'Answer two.', 'Answer three.']);
  const application = env.db.prepare('SELECT * FROM temporary_admin_applications WHERE applicant_id = ?').get(applicant.id);

  let holdReply;
  await handleTempAdminButton(managerInteraction(env, {
    customId: `gv:tempadmin:hold:${application.id}`,
    reply: async (payload) => { holdReply = payload; return payload; },
  }), { db: env.db });
  assert.match(holdReply.content, /on hold/);
  assert.equal(env.db.prepare('SELECT review_state FROM temporary_admin_applications WHERE id = ?').get(application.id).review_state, 'on_hold');

  let approveReply;
  await handleTempAdminButton(managerInteraction(env, {
    customId: `gv:tempadmin:approve:${application.id}`,
    reply: async (payload) => { approveReply = payload; return payload; },
  }), { db: env.db });
  assert.match(approveReply.content, /on hold/);

  await handleTempAdminButton(managerInteraction(env, {
    customId: `gv:tempadmin:resume:${application.id}`,
    reply: async (payload) => payload,
  }), { db: env.db });
  let infoModal;
  await handleTempAdminButton(managerInteraction(env, {
    customId: `gv:tempadmin:info:${application.id}`,
    showModal: async (modal) => { infoModal = modal; return modal; },
  }), { db: env.db });
  let infoReply;
  await handleTempAdminModal(managerInteraction(env, {
    customId: infoModal.data.custom_id,
    fields: { getTextInputValue: () => 'Please provide your schedule.' },
    reply: async (payload) => { infoReply = payload; return payload; },
  }), { db: env.db });
  assert.match(infoReply.content, /Information requested/);
  assert.equal(env.db.prepare('SELECT review_state FROM temporary_admin_applications WHERE id = ?').get(application.id).review_state, 'info_requested');

  let response;
  await handleTempAdminCommand({
    commandName: 'tempadmin',
    options: { getSubcommand: () => 'respond', getInteger: () => application.id, getString: () => 'I am available weekends.' },
    user: { id: applicant.id },
    guild: env.guild,
    client: env.client,
    reply: async (payload) => { response = payload; return payload; },
  }, { db: env.db });
  assert.match(response.content, /sent to management/);
  assert.equal(env.db.prepare('SELECT review_state FROM temporary_admin_applications WHERE id = ?').get(application.id).review_state, 'pending');
  assert.ok(env.db.prepare("SELECT id FROM temporary_admin_application_history WHERE application_id = ? AND action = 'applicant_information_submitted'").get(application.id));
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

test('Temporary Admin forms paginate text and real dropdown/multi-select questions while retaining all submitted answers', async (t) => {
  const env = createEnvironment(t);
  setConfigValue(env.db, 'TEMP_ADMIN_APPLICATION_QUESTIONS', [
    { label: 'Roblox username', type: 'short', required: true },
    { label: 'Why apply?', type: 'paragraph', required: true },
    { label: 'Select your shift', type: 'dropdown', required: true, options: ['Morning', 'Evening'] },
    { label: 'Past experience', type: 'short', required: false },
    { label: 'Which rules do you know?', type: 'multiple_choice', required: true, options: ['Respect', 'Safety', 'Fair play'] },
    { label: 'Availability', type: 'paragraph', required: true },
  ]);
  const applicantId = 'applicant-multistep';
  let firstModal;
  await handleTempAdminButton({
    customId: 'gv:tempadmin:apply',
    user: { id: applicantId, username: 'Multi Step Applicant' },
    showModal: async (modal) => { firstModal = modal; return modal; },
    reply: async (payload) => payload,
  }, { db: env.db });
  assert.equal(firstModal.toJSON().custom_id.split(':').at(-1), '0');
  assert.equal(firstModal.toJSON().components.length, 3);

  let choicePayload;
  await handleTempAdminModal({
    customId: firstModal.data.custom_id,
    user: { id: applicantId, username: 'Multi Step Applicant' },
    guild: env.guild,
    client: env.client,
    fields: { getTextInputValue: (key) => ({ answer_0: 'RobloxOne', answer_1: 'I want to help.', answer_3: 'Community moderation' }[key] ?? '') },
    reply: async (payload) => { choicePayload = payload; return payload; },
  }, { db: env.db });
  assert.equal(choicePayload.components.length, 3);
  assert.equal(choicePayload.components[0].components[0].data.type, 3);
  const dropdownId = choicePayload.components[0].components[0].data.custom_id;
  await handleTempAdminSelect({
    customId: dropdownId,
    values: ['Evening'],
    user: { id: applicantId },
    update: async (payload) => { choicePayload = payload; return payload; },
    reply: async (payload) => payload,
  }, { db: env.db });
  const multiChoiceId = choicePayload.components[1].components[0].data.custom_id;
  await handleTempAdminSelect({
    customId: multiChoiceId,
    values: ['Respect', 'Safety'],
    user: { id: applicantId },
    update: async (payload) => { choicePayload = payload; return payload; },
    reply: async (payload) => payload,
  }, { db: env.db });

  const continueId = choicePayload.components[2].components[0].data.custom_id;
  let secondModal;
  await handleTempAdminButton({
    customId: continueId,
    user: { id: applicantId },
    showModal: async (modal) => { secondModal = modal; return modal; },
    reply: async (payload) => payload,
  }, { db: env.db });
  assert.equal(secondModal.data.custom_id.split(':').at(-1), '1');
  let submitted;
  await handleTempAdminModal({
    customId: secondModal.data.custom_id,
    user: { id: applicantId, username: 'Multi Step Applicant' },
    guild: env.guild,
    client: env.client,
    fields: { getTextInputValue: () => 'Available every weekend.' },
    reply: async (payload) => { submitted = payload; return payload; },
  }, { db: env.db });
  assert.match(submitted.content, /sent to management/);
  const application = env.db.prepare('SELECT * FROM temporary_admin_applications WHERE applicant_id = ?').get(applicantId);
  assert.deepEqual(JSON.parse(application.answers_json), ['RobloxOne', 'I want to help.', 'Evening', 'Community moderation', 'Respect, Safety', 'Available every weekend.']);
});