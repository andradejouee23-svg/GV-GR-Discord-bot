const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const {
  handleVehicleButton,
  handleVehicleCommand,
  handleVehicleManagementButton,
  handleVehicleManagementModal,
  handleVehicleManagementSelect,
  handleVehicleModal,
  processVehicleExpirations,
  registrationCode,
  savePendingApplication,
} = require('../src/commands/vehicles');
const { handleManagementButton, handleManagementSelect } = require('../src/commands/staffManagement');
const { setConfigValue } = require('../src/utils/discord');

const managerId = 'vehicle-manager';
const applicantId = 'vehicle-applicant';
const roleId = '1556064708795306157';
const reviewChannelId = '1666064708795306156';
const panelChannelId = '1666064708795306157';
const mediaChannelId = '1666064708795306158';

function createEnvironment(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-vehicles-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([roleId]));
  setConfigValue(db, 'VEHICLE_REVIEW_CHANNEL_ID', reviewChannelId);
  setConfigValue(db, 'VEHICLE_REGISTRATION_CHANNEL_ID', panelChannelId);

  const manager = { id: managerId, roles: { cache: new Map([[roleId, { name: 'Admin' }]]) } };
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'server-owner',
    members: {
      me: {},
      fetch: async (id) => id === managerId ? manager : null,
    },
  };
  const reviewPosts = [];
  const panelPosts = [];
  const mediaPosts = [];
  const panelEdits = [];
  const reviewEdits = [];
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
    messages: {
      fetch: async () => ({ edit: async (payload) => { reviewEdits.push(payload); return payload; } }),
    },
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
    messages: {
      fetch: async () => ({ edit: async (payload) => { panelEdits.push(payload); return { id: '1776064708795306199' }; } }),
    },
  };
  const mediaChannel = {
    id: mediaChannelId,
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      mediaPosts.push(payload);
      return { id: `media-post-${mediaPosts.length}` };
    },
  };
  const client = {
    channels: { fetch: async (id) => id === reviewChannelId ? reviewChannel : id === panelChannelId ? panelChannel : id === mediaChannelId ? mediaChannel : null },
    users: {
      fetch: async (id) => ({ send: async (payload) => { dms.push({ id, payload }); } }),
    },
  };
  return { db, guild, client, reviewPosts, panelPosts, panelEdits, reviewEdits, mediaPosts, dms };
}

function makeApplicationData(overrides = {}) {
  return {
    robloxUsername: 'GreenvilleDriver',
    makeModel: '2022 Falcon Cruiser',
    plate: 'GV 1234',
    registrationState: 'Wisconsin',
    color: 'Blue',
    vehicleYear: 2022,
    imageUrl: null,
    ...overrides,
  };
}

function managerInteraction(env, properties = {}) {
  return {
    guild: env.guild,
    client: env.client,
    user: { id: managerId, username: 'Manager' },
    ...properties,
  };
}

test('panel posts and refreshes; applicants submit a validated application with an optional image', async (t) => {
  const env = createEnvironment(t);
  const { db, guild, client } = env;
  const panelCommand = managerInteraction(env, {
    commandName: 'vehicle',
    options: { getSubcommand: () => 'panel' },
    reply: async (payload) => payload,
  });
  const firstPanel = await handleVehicleCommand(panelCommand, { db });
  const secondPanel = await handleVehicleCommand(panelCommand, { db });
  assert.match(firstPanel.content, /posted/);
  assert.match(secondPanel.content, /refreshed/);
  assert.equal(env.panelPosts.length, 1);
  assert.equal(env.panelEdits.length, 1);
  assert.deepEqual(env.panelPosts[0].components[0].components.map((button) => button.data.label), [
    'Register Vehicle', 'My Registered Vehicles',
  ]);
  const publicPanelText = JSON.stringify(env.panelPosts[0].embeds[0].data);
  assert.match(publicPanelText, /CIVILIAN VEHICLES ONLY/);
  assert.match(publicPanelText, /Police, Fire Rescue/);
  assert.match(publicPanelText, /must NOT be registered/i);
  assert.match(publicPanelText, /My Registered Vehicles/);

  let firstModal;
  await handleVehicleButton({
    customId: 'gv:vehicle:register',
    showModal: async (modal) => { firstModal = modal; return modal; },
  }, { db });
  assert.equal(firstModal.toJSON().custom_id, 'gv:vehicle:apply:basic');
  const basicFields = {
    roblox: 'GreenvilleDriver',
    vehicle: '2022 Falcon Cruiser',
    plate: 'GV 1234',
    state: 'Wisconsin',
    color: 'Blue',
  };
  const submitBasic = async (id = applicantId) => {
    let reply;
    await handleVehicleModal({
      customId: 'gv:vehicle:apply:basic',
      user: { id },
      fields: { getTextInputValue: (key) => basicFields[key] },
      reply: async (payload) => { reply = payload; return payload; },
    }, { db });
    return reply;
  };
  const continuation = await submitBasic();
  assert.match(continuation.content, /Add the year/);
  const continueId = continuation.components[0].components[0].data.custom_id;
  let detailModal;
  await handleVehicleButton({
    customId: continueId,
    user: { id: applicantId },
    showModal: async (modal) => { detailModal = modal; return modal; },
    reply: async (payload) => payload,
  }, { db });
  const modalJson = detailModal.toJSON();
  assert.equal(modalJson.components[1].type, 18);
  assert.equal(modalJson.components[1].component.type, 19);

  const attachment = {
    contentType: 'image/png',
    size: 1024,
    url: 'https://cdn.discordapp.com/attachments/1/2/vehicle.png',
  };
  const submitDetails = async (file) => {
    let reply;
    await handleVehicleModal({
      customId: `gv:vehicle:apply:details:${continueId.split(':').at(-1)}`,
      user: { id: applicantId },
      guild,
      client,
      fields: {
        getTextInputValue: () => '2022',
        getUploadedFiles: () => file ? { first: () => file } : null,
      },
      reply: async (payload) => { reply = payload; return payload; },
    }, { db });
    return reply;
  };
  const oversized = await submitDetails({ ...attachment, size: 9 * 1024 * 1024 });
  assert.match(oversized.content, /no larger than 8 MB/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vehicle_applications').get().count, 0);

  const submitted = await submitDetails(attachment);
  assert.match(submitted.content, /sent to staff for review/);
  assert.equal(env.reviewPosts.length, 1);
  assert.equal(env.reviewPosts[0].embeds[0].data.image.url, attachment.url);
  assert.match(env.reviewPosts[0].embeds[0].data.title, /GV-APP-000001/);
  assert.equal(env.reviewPosts[0].components[0].components.length, 2);
  const application = db.prepare('SELECT * FROM vehicle_applications').get();
  assert.equal(application.status, 'pending');
  assert.equal(application.image_url, attachment.url);
  assert.equal(application.review_message_id, String(1776064708795306157));
  assert.equal(db.prepare('SELECT action FROM vehicle_registration_history WHERE application_id = ?').get(application.id).action, 'submitted');

  const repeatApplicant = await submitBasic();
  assert.match(repeatApplicant.content, /already have a vehicle application pending/);
  const repeatPlate = await submitBasic('another-applicant');
  assert.match(repeatPlate.content, /plate is already pending review/);
});

test('only management can decide applications; decisions are persisted and applicants are notified', async (t) => {
  const env = createEnvironment(t);
  const { db, guild, client } = env;
  const approvedId = savePendingApplication(db, applicantId, makeApplicationData(), reviewChannelId);
  const deniedId = savePendingApplication(db, 'another-player', makeApplicationData({ plate: 'GV 7777' }), reviewChannelId);
  for (const id of [approvedId, deniedId]) {
    db.prepare('UPDATE vehicle_applications SET review_message_id = ? WHERE id = ?').run(String(1776064708795306200 + id), id);
  }

  let deniedReply;
  await handleVehicleButton({
    ...managerInteraction(env, { user: { id: 'unauthorized-player', username: 'Player' } }),
    customId: `gv:vehicle:approve:${approvedId}`,
    reply: async (payload) => { deniedReply = payload; return payload; },
  }, { db });
  assert.match(deniedReply.content, /management roles only/i);
  assert.equal(db.prepare('SELECT status FROM vehicle_applications WHERE id = ?').get(approvedId).status, 'pending');

  let approvalUpdate;
  await handleVehicleButton({
    ...managerInteraction(env, { customId: `gv:vehicle:approve:${approvedId}` }),
    update: async (payload) => { approvalUpdate = payload; return payload; },
  }, { db });
  const approved = db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(approvedId);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.registration_code, registrationCode(approvedId));
  assert.match(approvalUpdate.embeds[0].data.title, /Approved/);
  assert.equal(env.dms.length, 1);
  assert.match(env.dms[0].payload.embeds[0].data.description, /Active/);

  let denialModal;
  await handleVehicleButton({
    ...managerInteraction(env, { customId: `gv:vehicle:deny:${deniedId}` }),
    showModal: async (modal) => { denialModal = modal; return modal; },
  }, { db });
  assert.equal(denialModal.toJSON().custom_id, `gv:vehicle:deny_submit:${deniedId}`);
  env.client.users.fetch = async () => { throw new Error('DMs are unavailable'); };
  let denialReply;
  await handleVehicleModal({
    ...managerInteraction(env, { customId: `gv:vehicle:deny_submit:${deniedId}` }),
    fields: { getTextInputValue: () => 'Plate details do not match.' },
    reply: async (payload) => { denialReply = payload; return payload; },
  }, { db });
  const denied = db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(deniedId);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.decision_reason, 'Plate details do not match.');
  assert.match(env.reviewEdits.at(-1).embeds[0].data.title, /Denied/);
  assert.match(denialReply.content, /notified in the registration channel/);
  assert.equal(env.panelPosts.at(-1).content, '<@another-player>');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vehicle_registration_history WHERE action IN ('approved', 'denied')").get().count, 2);
});

test('management can search, update, revoke, expire, and inspect registrations', async (t) => {
  const env = createEnvironment(t);
  const { db } = env;
  const firstId = savePendingApplication(db, applicantId, makeApplicationData(), reviewChannelId);
  const secondId = savePendingApplication(db, 'other-player', makeApplicationData({ plate: 'OTHER 2' }), reviewChannelId);
  for (const id of [firstId, secondId]) {
    db.prepare("UPDATE vehicle_applications SET status = 'approved', reviewed_at = ?, reviewer_id = ?, registration_code = ? WHERE id = ?")
      .run('2026-10-30T12:00:00.000Z', managerId, registrationCode(id), id);
  }

  const command = (action, options, userId = managerId) => managerInteraction(env, {
    commandName: 'vehicle',
    user: { id: userId, username: 'Manager' },
    options: { getSubcommand: () => action, ...options },
    reply: async (payload) => payload,
  });
  const duplicatePlate = await handleVehicleCommand(command('update', {
    getInteger: (name) => name === 'id' ? firstId : null,
    getString: (name) => name === 'plate' ? 'OTHER 2' : null,
    getBoolean: () => false,
  }), { db });
  assert.match(duplicatePlate.content, /already uses that plate/);

  const updated = await handleVehicleCommand(command('update', {
    getInteger: (name) => name === 'id' ? firstId : null,
    getString: (name) => ({ plate: 'UPDATED 1' }[name] ?? null),
    getBoolean: () => false,
  }), { db });
  assert.match(updated.content, /updated/i);
  assert.equal(db.prepare('SELECT plate FROM vehicle_applications WHERE id = ?').get(firstId).plate, 'UPDATED 1');

  const playerVehicles = await handleVehicleCommand(command('mine', {}, applicantId), { db });
  assert.match(playerVehicles.embeds[0].data.description, /UPDATED 1/);
  assert.match(playerVehicles.embeds[0].data.description, /APPROVED/);
  const search = await handleVehicleCommand(command('search', { getString: () => 'updated1' }), { db });
  assert.match(search.embeds[0].data.description, /UPDATED 1/);

  const expiration = await handleVehicleCommand(command('expiration', {
    getInteger: () => secondId,
    getString: () => '2027-01-01T00:00:00Z',
  }), { db });
  assert.match(expiration.content, /expires/);
  assert.equal(processVehicleExpirations(db, new Date('2027-01-02T00:00:00.000Z')), 1);
  assert.equal(db.prepare('SELECT status FROM vehicle_applications WHERE id = ?').get(secondId).status, 'expired');

  const revoked = await handleVehicleCommand(command('revoke', {
    getInteger: () => firstId,
    getString: () => 'No longer in service.',
  }), { db });
  assert.match(revoked.content, /revoked/);
  assert.equal(db.prepare('SELECT status FROM vehicle_applications WHERE id = ?').get(firstId).status, 'revoked');
  const history = await handleVehicleCommand(command('history', { getUser: () => ({ id: applicantId, username: 'Driver' }) }), { db });
  assert.match(history.embeds[0].data.description, /UPDATED|REVOKED|EXPIRATION_CHANGED/i);
});

test('Staff Panel vehicle management selects members and safely manages their registrations', async (t) => {
  const env = createEnvironment(t);
  const { db } = env;
  const approvedId = savePendingApplication(db, applicantId, makeApplicationData({ plate: 'GV 2000' }), reviewChannelId);
  db.prepare("UPDATE vehicle_applications SET status = 'approved', reviewed_at = ?, reviewer_id = ?, registration_code = ? WHERE id = ?")
    .run('2026-10-30T12:00:00.000Z', managerId, registrationCode(approvedId), approvedId);
  const pendingId = savePendingApplication(db, applicantId, makeApplicationData(), reviewChannelId);

  let picker;
  const dashboard = await handleManagementButton(managerInteraction(env, {
    customId: 'mgmt:vehicles',
    update: async (payload) => { picker = payload; return payload; },
  }), { db });
  assert.equal(picker.components[0].components[0].data.custom_id, 'mgmt:vehicle:member');
  assert.equal(dashboard.components[0].components[0].data.type, 5);

  let listed;
  await handleManagementSelect(managerInteraction(env, {
    customId: 'mgmt:vehicle:member',
    values: [applicantId],
    update: async (payload) => { listed = payload; return payload; },
  }), { db });
  assert.match(listed.embeds[0].data.fields.map((field) => field.name).join(' '), /PENDING.*APPROVED/);
  assert.equal(listed.components[0].components[0].data.custom_id, `mgmt:vehicle:application:${applicantId}:0`);

  let emptyList;
  await handleManagementSelect(managerInteraction(env, {
    customId: 'mgmt:vehicle:member',
    values: ['member-without-vehicles'],
    update: async (payload) => { emptyList = payload; return payload; },
  }), { db });
  assert.match(emptyList.embeds[0].data.description, /no registered vehicle records/i);

  let detail;
  await handleVehicleManagementSelect(managerInteraction(env, {
    customId: `mgmt:vehicle:application:${applicantId}:0`,
    values: [String(pendingId)],
    update: async (payload) => { detail = payload; return payload; },
  }), { db });
  assert.match(detail.embeds[0].data.title, /PENDING/);
  const actionIds = detail.components[0].components.map((button) => button.data.custom_id);
  assert.ok(actionIds.includes(`mgmt:vehicle:approve:${applicantId}:${pendingId}`));
  assert.ok(actionIds.includes(`mgmt:vehicle:deny:${applicantId}:${pendingId}`));

  let wrongOwnerReply;
  await handleVehicleManagementSelect(managerInteraction(env, {
    customId: 'mgmt:vehicle:application:someone-else:0',
    values: [String(pendingId)],
    reply: async (payload) => { wrongOwnerReply = payload; return payload; },
  }), { db });
  assert.match(wrongOwnerReply.content, /does not belong to the selected member/i);

  let unauthorizedReply;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:remove:${applicantId}:${approvedId}`,
    user: { id: 'unauthorized-player', username: 'Player' },
    reply: async (payload) => { unauthorizedReply = payload; return payload; },
  }), { db });
  assert.match(unauthorizedReply.content, /management roles only/i);
  assert.equal(db.prepare('SELECT status FROM vehicle_applications WHERE id = ?').get(approvedId).status, 'approved');

  let approvedMessage;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:approve:${applicantId}:${pendingId}`,
    update: async (payload) => { approvedMessage = payload; return payload; },
  }), { db });
  assert.equal(db.prepare('SELECT status FROM vehicle_applications WHERE id = ?').get(pendingId).status, 'approved');
  assert.match(approvedMessage.embeds[0].data.title, /Approved/);

  const deniedId = savePendingApplication(db, 'second-applicant', makeApplicationData({ plate: 'GV 3000' }), reviewChannelId);
  let denialModal;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:deny:second-applicant:${deniedId}`,
    showModal: async (modal) => { denialModal = modal; return modal; },
  }), { db });
  let denialReply;
  await handleVehicleModal(managerInteraction(env, {
    customId: denialModal.data.custom_id,
    fields: { getTextInputValue: () => 'Registration details need correction.' },
    reply: async (payload) => { denialReply = payload; return payload; },
  }), { db });
  assert.equal(db.prepare('SELECT status FROM vehicle_applications WHERE id = ?').get(deniedId).status, 'denied');
  assert.match(denialReply.content, /applicant was notified/i);

  let editModal;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:edit:${applicantId}:${approvedId}`,
    showModal: async (modal) => { editModal = modal; return modal; },
  }), { db });
  let editDetailsModal;
  await handleVehicleManagementModal(managerInteraction(env, {
    customId: editModal.data.custom_id,
    fields: { getTextInputValue: (key) => ({
      roblox: 'UpdatedDriver', vehicle: '2024 Falcon Cruiser', plate: 'GV 2001', state: 'Wisconsin', color: 'Black',
    })[key] },
    showModal: async (modal) => { editDetailsModal = modal; return modal; },
  }), { db });
  await handleVehicleManagementModal(managerInteraction(env, {
    customId: editDetailsModal.data.custom_id,
    fields: { getTextInputValue: (key) => ({ year: '2024', image: '' })[key] },
    reply: async (payload) => payload,
  }), { db });
  const edited = db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(approvedId);
  assert.equal(edited.plate, 'GV 2001');
  assert.equal(edited.vehicle_year, 2024);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vehicle_registration_history WHERE application_id = ? AND action = 'updated'").get(approvedId).count, 1);

  let removalModal;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:remove:${applicantId}:${approvedId}`,
    showModal: async (modal) => { removalModal = modal; return modal; },
  }), { db });
  await handleVehicleManagementModal(managerInteraction(env, {
    customId: removalModal.data.custom_id,
    fields: { getTextInputValue: () => 'No longer eligible for civilian vehicle registration.' },
    reply: async (payload) => payload,
  }), { db });
  assert.equal(db.prepare('SELECT status FROM vehicle_applications WHERE id = ?').get(approvedId).status, 'revoked');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vehicle_applications WHERE id = ?').get(approvedId).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM vehicle_registration_history WHERE application_id = ? AND action = 'removed'").get(approvedId).count, 1);
});

test('only management can publish an approved vehicle with a photo to Media, once', async (t) => {
  const env = createEnvironment(t);
  setConfigValue(env.db, 'VEHICLE_MEDIA_CHANNEL_ID', mediaChannelId);
  const vehicleId = savePendingApplication(env.db, applicantId, makeApplicationData({
    plate: 'MEDIA 1', imageUrl: 'https://cdn.example.com/car.jpg',
  }), reviewChannelId);
  env.db.prepare("UPDATE vehicle_applications SET status = 'approved', reviewed_at = ?, reviewer_id = ?, registration_code = ? WHERE id = ?")
    .run('2026-11-09T12:00:00.000Z', managerId, registrationCode(vehicleId), vehicleId);

  let denied;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:publish_media:${applicantId}:${vehicleId}`,
    user: { id: 'regular-player', username: 'Player' },
    reply: async (payload) => { denied = payload; return payload; },
  }), { db: env.db });
  assert.match(denied.content, /management roles only/i);
  assert.equal(env.mediaPosts.length, 0);

  let postedView;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:publish_media:${applicantId}:${vehicleId}`,
    update: async (payload) => { postedView = payload; return payload; },
  }), { db: env.db });
  const published = env.db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(vehicleId);
  assert.equal(env.mediaPosts.length, 1);
  assert.equal(env.mediaPosts[0].embeds[0].data.image.url, 'https://cdn.example.com/car.jpg');
  assert.doesNotMatch(env.mediaPosts[0].embeds[0].data.description, /MEDIA 1/);
  assert.equal(published.media_channel_id, mediaChannelId);
  assert.equal(published.media_message_id, 'media-post-1');
  assert.ok(published.media_published_at);
  assert.equal(env.db.prepare("SELECT action FROM vehicle_registration_history WHERE application_id = ? ORDER BY id DESC LIMIT 1").get(vehicleId).action, 'media_published');
  assert.ok(postedView.components.flatMap((row) => row.components).some((button) => button.data.disabled && /Published in Media/.test(button.data.label)));

  let duplicateReply;
  await handleVehicleManagementButton(managerInteraction(env, {
    customId: `mgmt:vehicle:publish_media:${applicantId}:${vehicleId}`,
    reply: async (payload) => { duplicateReply = payload; return payload; },
  }), { db: env.db });
  assert.match(duplicateReply.content, /already been published/i);
  assert.equal(env.mediaPosts.length, 1);
});