const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleButton } = require('../src/buttons');
const { createPanelComponents } = require('../src/commands/clock');
const { handleOperationsCommand } = require('../src/commands/operations');
const {
  buildAnnouncementComponents,
  createDraft,
  handleAnnouncementManagerInteraction,
  isHttpsUrl,
  parseColor,
  templateData,
  templateLabels,
  validateDraft,
} = require('../src/commands/announcementManager');

const managerRoleId = '1556064708795306157';
const managerId = '1556064273472421888';
const hostId = '1556064708795306156';
const destinationId = '1666064708795306156';

function createTestDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-announcement-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRoleId]));
  return db;
}

function createGuild() {
  const manager = { id: managerId, roles: { cache: new Map([[managerRoleId, { name: 'Admin' }]]) } };
  const host = { id: hostId, user: { id: hostId, username: 'Host' }, roles: { cache: new Map([[config.STAFF_ROLE_IDS[0], { name: 'Moderator' }]]) } };
  return {
    id: config.SERVER_ID,
    ownerId: 'server-owner',
    members: {
      me: {},
      fetch: async (id) => id === managerId ? manager : id === hostId ? host : null,
    },
    channels: { fetch: async () => null },
    roles: { fetch: async () => null },
  };
}

function openInteraction(guild, user = { id: managerId, username: 'Manager' }) {
  return {
    guild,
    user,
    reply: async (payload) => payload,
  };
}

test('session command and staff panel button open the same template selector', async (t) => {
  const db = createTestDatabase(t);
  const guild = createGuild();
  const commandInteraction = {
    ...openInteraction(guild),
    commandName: 'session',
    options: {
      getSubcommand: () => 'start',
      getUser: () => ({ id: hostId }),
    },
  };
  const commandReply = await handleOperationsCommand(commandInteraction, { db });

  const panelButton = createPanelComponents().flatMap((row) => row.components)
    .find((button) => button.data.custom_id === 'gv:ann:open');
  assert.ok(panelButton);
  const buttonReply = await handleButton({
    ...openInteraction(guild),
    customId: panelButton.data.custom_id,
  }, { db });

  const templateOptions = (payload) => payload.components[0].components[0].toJSON().options.map((option) => option.value);
  assert.deepEqual(templateOptions(commandReply), ['session_started', 'upcoming_session', 'special_event', 'custom']);
  assert.deepEqual(templateOptions(buttonReply), templateOptions(commandReply));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM announcement_drafts').get().count, 2);
});

test('all templates load and draft validation rejects unsafe URLs and invalid colors', async (t) => {
  const db = createTestDatabase(t);
  const ctx = { db };
  const templates = Object.keys(templateLabels);
  assert.deepEqual(templates, ['session_started', 'upcoming_session', 'special_event', 'custom']);
  const loaded = templates.map((template) => templateData(template, { hostId }, ctx));
  assert.equal(loaded[0].buttons[0].label, 'Launch Greenville RP');
  assert.ok(loaded[1].buttons.some((button) => button.type === 'channel'));
  assert.equal(loaded[2].buttons[0].type, 'channel');
  assert.equal(loaded[3].title, '');
  assert.deepEqual(loaded[3].buttons, []);

  assert.equal(parseColor('#4388D1'), 0x4388d1);
  assert.equal(parseColor('#abc'), null);
  assert.equal(isHttpsUrl('https://example.com/image.png'), true);
  assert.equal(isHttpsUrl('http://example.com/image.png'), false);
  const actionButtons = buildAnnouncementComponents({
    ...loaded[3],
    buttons: [
      { type: 'link', label: 'Launch', emoji: '🎮', target: 'https://example.com' },
      { type: 'channel', label: 'Open Channel', emoji: '📍', target: hostId },
      { type: 'role', label: 'Contact Role', emoji: '📨', target: managerRoleId },
    ],
  }, 'a'.repeat(32), config.SERVER_ID)[0].components.map((button) => button.toJSON());
  assert.equal(actionButtons[0].url, 'https://example.com');
  assert.equal(actionButtons[1].url, `https://discord.com/channels/${config.SERVER_ID}/${hostId}`);
  assert.equal(actionButtons[2].custom_id, `gv:ann:role:${'a'.repeat(32)}:${managerRoleId}`);
  const invalid = {
    ...loaded[3],
    title: 'Announcement',
    color: 'not-hex',
    imageUrl: 'http://example.com/image.png',
    buttons: [{ type: 'link', label: 'Launch', emoji: '', target: 'javascript:alert(1)' }],
  };
  const errors = validateDraft(invalid).join('\n');
  assert.match(errors, /HEX value/);
  assert.match(errors, /HTTPS URL/);

  const draftId = createDraft(db, managerId);
  db.prepare('UPDATE announcement_drafts SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(templateData('custom', {}, ctx)), draftId);
  const fields = {
    getTextInputValue: (key) => ({
      title: 'Edited title',
      description: 'Edited description',
      image: 'https://example.com/header.png',
      color: '#12AB34',
    })[key],
  };
  let editedReply;
  await handleAnnouncementManagerInteraction({
    ...openInteraction(createGuild()),
    customId: `gv:ann:content:${draftId}`,
    isButton: () => false,
    isModalSubmit: () => true,
    fields,
    reply: async (payload) => { editedReply = payload; return payload; },
  }, { db });
  const edited = JSON.parse(db.prepare('SELECT data_json FROM announcement_drafts WHERE id = ?').get(draftId).data_json);
  assert.equal(edited.title, 'Edited title');
  assert.equal(edited.imageUrl, 'https://example.com/header.png');
  assert.equal(edited.color, '#12AB34');
  assert.ok(editedReply.components);
});

test('publish requires confirmation, authorizes managers, and prevents duplicate sends', async (t) => {
  const db = createTestDatabase(t);
  const guild = createGuild();
  const draftId = createDraft(db, managerId);
  const data = {
    ...templateData('custom', {}, { db }),
    title: 'Test Announcement',
    description: 'Details',
    destinationChannelId: destinationId,
  };
  db.prepare('UPDATE announcement_drafts SET data_json = ? WHERE id = ?')
    .run(JSON.stringify(data), draftId);
  let publishedMessages = 0;
  const destination = {
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => {
      publishedMessages += 1;
      return { channelId: destinationId, id: '1776064708795306156' };
    },
  };
  const client = { channels: { fetch: async (id) => id === destinationId ? destination : null } };
  const interaction = (action, userId = managerId) => {
    let lastReply;
    let lastUpdate;
    return {
      ...openInteraction(guild, { id: userId, username: 'Manager' }),
      customId: `gv:ann:${action}:${draftId}`,
      client,
      message: {},
      isButton: () => true,
      update: async (payload) => {
        lastUpdate = payload;
        return payload;
      },
      reply: async (payload) => {
        lastReply = payload;
        return payload;
      },
      get lastReply() { return lastReply; },
      get lastUpdate() { return lastUpdate; },
    };
  };

  const previewInteraction = interaction('publish');
  const preview = await handleAnnouncementManagerInteraction(previewInteraction, { db });
  assert.match(preview.content, /Confirm publishing/);
  assert.equal(preview.components.at(-1).components[0].data.label, 'Confirm Publish');
  assert.equal(publishedMessages, 0);

  const deniedInteraction = interaction('confirm', 'unauthorized-user');
  await handleAnnouncementManagerInteraction(deniedInteraction, { db });
  assert.match(deniedInteraction.lastReply.content, /management roles only/i);
  assert.equal(publishedMessages, 0);

  const publishInteraction = interaction('confirm');
  const published = await handleAnnouncementManagerInteraction(publishInteraction, { db, client });
  assert.match(published.content, /Announcement published/);
  assert.equal(publishedMessages, 1);
  const duplicateInteraction = interaction('confirm');
  await handleAnnouncementManagerInteraction(duplicateInteraction, { db, client });
  assert.match(duplicateInteraction.lastUpdate.content, /already been published/i);
  assert.equal(publishedMessages, 1);
});