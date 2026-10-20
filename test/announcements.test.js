const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleManagementButton } = require('../src/commands/staffManagement');
const {
  createAnnouncementEmbed,
  handleAnnouncementButton,
  handleAnnouncementCommand,
  handleAnnouncementModal,
  handleAnnouncementSelect,
  parseFields,
  resolveAnnouncementTemplate,
  startCustomAnnouncement,
  validateCustomMessage,
} = require('../src/commands/announcements');

function openDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-announcements-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function member(id, roleId) {
  return { id, roles: { cache: new Map([[roleId, { name: 'Management' }]]) } };
}

test('announcement fields, URLs, color, and embed text limits are validated', () => {
  assert.deepEqual(parseFields('[{"name":"Schedule","value":"Two hours","inline":true}]'), [
    { name: 'Schedule', value: 'Two hours', inline: true },
  ]);
  assert.throws(() => parseFields('not json'), /valid JSON/);
  assert.throws(() => createAnnouncementEmbed({ title: 'Title', description: 'Body', color: 'invalid' }), /six-digit hex/);
  assert.throws(() => createAnnouncementEmbed({
    title: 't'.repeat(256), description: 'x'.repeat(4000), footer: 'f'.repeat(2000), color: '#286F61',
  }), /6000-character/);
});

test('management can preview and publish an announcement only to configured channels', async (t) => {
  const db = openDatabase(t);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM announcement_templates').get().count, 9);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('SESSION_JOIN_CODE', JSON.stringify('OWNER-PROVIDED-CODE'));
  const resolved = resolveAnnouncementTemplate({ description: 'Code: {join_code}\n{join_instructions}\n{join_url}' }, db);
  assert.match(resolved.description, /OWNER-PROVIDED-CODE/);
  assert.doesNotMatch(resolved.description, /\{join_code\}/);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = member('announcement-manager', managerRole);
  const guild = { id: 'announcement-guild', ownerId: 'server-owner' };
  const common = {
    guild,
    member: manager,
    user: { id: manager.id, username: 'Manager' },
  };
  const makeInteraction = (customId, values = [], fields = {}) => ({
    ...common,
    customId,
    values,
    fields: { getTextInputValue: (key) => fields[key] ?? '' },
    reply: async (payload) => payload,
    showModal: async (modal) => modal,
    update: async (payload) => payload,
    deferUpdate: async () => {},
    editReply: async (payload) => payload,
  });

  const createModal = await handleAnnouncementCommand({
    ...common,
    commandName: 'announcement-builder',
    options: { getSubcommand: () => 'create' },
    showModal: async (modal) => modal,
    reply: async (payload) => payload,
  }, { db });
  const draftId = createModal.data.custom_id.split(':').at(-1);
  const detailsModal = await handleAnnouncementModal(makeInteraction(createModal.data.custom_id, [], {
    title: 'Community Update',
    description: 'Maintenance starts soon.',
    color: '#286F61',
    footer: 'GV GR',
    timestamp: '',
  }), { db });
  assert.equal(detailsModal.data.custom_id, `gv:announce:details:${draftId}`);

  const buttonChoice = await handleAnnouncementModal(makeInteraction(detailsModal.data.custom_id, [], {
    image_url: 'https://example.com/banner.png',
    thumbnail_url: '',
    start_at: '2026-10-18T18:00:00Z',
    end_at: '2026-10-18T20:00:00Z',
    fields_json: '[{"name":"Status","value":"Scheduled"}]',
  }), { db });
  assert.equal(buttonChoice.components[0].components[0].data.custom_id, `gv:announce:button_type:${draftId}`);

  const channelChoice = await handleAnnouncementSelect(makeInteraction(`gv:announce:button_type:${draftId}`, ['staff_center']), { db });
  assert.equal(channelChoice.components[0].components[0].data.custom_id, `gv:announce:channel:${draftId}`);
  const configuredChannel = config.STAFF_ANNOUNCEMENT_CHANNEL_ID;
  const preview = await handleAnnouncementSelect(makeInteraction(`gv:announce:channel:${draftId}`, [configuredChannel]), { db });
  assert.match(preview.content, /Preview before publishing/);
  assert.match(preview.embeds[0].data.description, /Maintenance starts soon/);
  const publishId = preview.components.flatMap((row) => row.components)
    .find((button) => button.data.custom_id?.startsWith('gv:announce:publish:')).data.custom_id;

  const sent = [];
  const publishedMessage = {
    id: 'announcement-message',
    author: { id: 'bot-id' },
    edit: async (payload) => sent.push({ kind: 'edit', payload }),
  };
  const client = {
    user: { id: 'bot-id' },
    channels: { fetch: async (channelId) => ({
      id: channelId,
      isTextBased: () => true,
      send: async (payload) => { sent.push({ kind: 'send', payload }); return publishedMessage; },
      messages: { fetch: async () => publishedMessage },
    }) },
  };
  const published = await handleAnnouncementButton({
    ...makeInteraction(publishId), client,
  }, { db });
  assert.match(published.content, /published/);
  assert.equal(sent[0].kind, 'send');
  assert.equal(sent[0].payload.allowedMentions.parse.length, 0);
  assert.equal(sent[0].payload.components[0].components[0].data.custom_id, 'gv:announce:staff_center');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM bot_announcements').get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action = 'announcement_published'").get().count, 1);

  const announcementId = db.prepare('SELECT id FROM bot_announcements').get().id;
  const editMenu = await handleAnnouncementCommand({
    ...common,
    commandName: 'announcement-builder',
    options: { getSubcommand: () => 'edit' },
    reply: async (payload) => payload,
  }, { db });
  const editModal = await handleAnnouncementSelect(makeInteraction('gv:announce:edit_select', [String(announcementId)]), { db });
  const updatedDetailsModal = await handleAnnouncementModal(makeInteraction(editModal.data.custom_id, [], {
    title: 'Community Update Revised',
    description: 'Maintenance has completed.',
    color: '#286F61', footer: 'GV GR', timestamp: '',
  }), { db });
  const updatedButtonChoice = await handleAnnouncementModal(makeInteraction(updatedDetailsModal.data.custom_id, [], {
    image_url: '', thumbnail_url: '', start_at: '', end_at: '', fields_json: '',
  }), { db });
  const editPreview = await handleAnnouncementSelect(makeInteraction(
    updatedButtonChoice.components[0].components[0].data.custom_id, ['none']), { db });
  const updateId = editPreview.components.flatMap((row) => row.components)
    .find((button) => button.data.custom_id?.startsWith('gv:announce:publish:')).data.custom_id;
  const edited = await handleAnnouncementButton({
    ...makeInteraction(updateId), client,
  }, { db });
  assert.match(edited.content, /updated/);
  assert.equal(sent.at(-1).kind, 'edit');
  assert.equal(db.prepare('SELECT title FROM bot_announcements WHERE id = ?').get(announcementId).title, 'Community Update Revised');
  assert.equal(editMenu.components[0].components[0].data.custom_id, 'gv:announce:edit_select');
});

test('custom messages validate embeds, HTTPS links, emoji, and Discord limits', () => {
  const payload = validateCustomMessage({
    content: '@everyone RP starts soon',
    embeds_json: '[{"title":"Halloween RP","description":"Join the patrol.","color":"#286F61","fields":[{"name":"Start","value":"6 PM","inline":true}],"image":{"url":"https://example.com/halloween.png"}}]',
    reactions: '🎃, 👻',
    buttons_json: '[{"label":"Join Greenville","url":"https://example.com/join"}]',
  }, { emojis: { cache: new Map() } });
  assert.equal(payload.embeds[0].color, 0x286f61);
  assert.equal(payload.embeds[0].image.url, 'https://example.com/halloween.png');
  assert.deepEqual(payload.reactions, ['🎃', '👻']);
  assert.equal(payload.buttons[0].url, 'https://example.com/join');
  assert.throws(() => validateCustomMessage({ content: '', embeds_json: '[{"image":{"url":"http://example.com/image.png"},"title":"X"}]', reactions: '', buttons_json: '' }, { emojis: { cache: new Map() } }), /HTTPS/);
  assert.throws(() => validateCustomMessage({ content: 'Button test', embeds_json: '', reactions: '', buttons_json: '[{"label":"Click","url":"javascript:alert(1)"}]' }, { emojis: { cache: new Map() } }), /HTTPS/);
  assert.throws(() => validateCustomMessage({ content: '', embeds_json: '[]', reactions: '', buttons_json: '' }, { emojis: { cache: new Map() } }), /Add message text or at least one embed/);
  assert.throws(() => validateCustomMessage({ content: 'x'.repeat(2001), embeds_json: '', reactions: '', buttons_json: '' }, { emojis: { cache: new Map() } }), /2000 characters/);
});

test('management Send Custom previews, publishes once, suppresses pings, and reports reaction failures', async (t) => {
  const db = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = member('custom-manager', managerRole);
  const guild = {
    id: 'custom-guild', ownerId: 'owner',
    members: { me: { id: 'custom-bot' } },
    emojis: { cache: new Map() },
  };
  const common = { guild, member: manager, user: { id: manager.id, username: 'Manager' } };
  const interaction = (customId, overrides = {}) => ({
    ...common,
    ...overrides,
    customId,
    values: overrides.values ?? [],
    fields: { getTextInputValue: (key) => overrides.fields?.[key] ?? '' },
    reply: async (payload) => payload,
    update: async (payload) => payload,
    showModal: async (modal) => modal,
    deferUpdate: async () => {},
    editReply: async (payload) => payload,
  });

  const opened = await handleManagementButton(interaction('mgmt:send_custom'), { db });
  const selectId = opened.components[0].components[0].data.custom_id;
  assert.equal(selectId.split(':')[2], 'custom_channel');
  const draftId = selectId.split(':').at(-1);
  const modal = await handleAnnouncementSelect(interaction(selectId, {
    values: [config.STAFF_ANNOUNCEMENT_CHANNEL_ID],
  }), { db });
  assert.equal(modal.data.custom_id, `gv:announce:custom_content:${draftId}`);

  const preview = await handleAnnouncementModal(interaction(modal.data.custom_id, {
    fields: {
      content: '@everyone Halloween RP begins at 6 PM.',
      embeds_json: '[{"title":"Halloween RP","description":"Join the Greenville patrol.","color":"#286F61","author":{"name":"GV GR"},"footer":{"text":"Community RP"},"thumbnail":{"url":"https://example.com/thumb.png"},"image":{"url":"https://example.com/halloween.png"},"fields":[{"name":"Start","value":"6 PM","inline":true}]}]',
      reactions: '🎃, 👻',
      buttons_json: '[{"label":"Join","url":"https://example.com/join"}]',
    },
  }), { db });
  assert.match(preview.content, /Preview before publishing/);
  assert.deepEqual(preview.allowedMentions.parse, []);
  assert.equal(preview.embeds[0].data.image.url, 'https://example.com/halloween.png');
  assert.equal(preview.components[0].components[0].data.url, 'https://example.com/join');
  const publishId = preview.components.flatMap((row) => row.components)
    .find((button) => button.data.custom_id?.startsWith('gv:announce:publish:')).data.custom_id;

  const sent = [];
  const reactions = [];
  const botPermissions = { has: () => true };
  const publishedMessage = {
    id: 'custom-message', channelId: config.STAFF_ANNOUNCEMENT_CHANNEL_ID,
    react: async (emoji) => {
      reactions.push(emoji);
      if (emoji === '👻') throw new Error('reaction permission failed');
    },
  };
  const client = {
    user: { id: 'custom-bot' },
    channels: { fetch: async (channelId) => ({
      id: channelId, guildId: guild.id,
      isTextBased: () => true,
      permissionsFor: () => botPermissions,
      send: async (payload) => { sent.push(payload); return publishedMessage; },
    }) },
  };
  const published = await handleAnnouncementButton(interaction(publishId, { client }), { db });
  assert.match(published.content, /could not be added: 👻/);
  assert.match(published.content, /not resent/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].allowedMentions.parse.length, 0);
  assert.equal(sent[0].content.includes('@everyone'), true);
  assert.deepEqual(reactions, ['🎃', '👻']);
  const saved = db.prepare('SELECT title, payload_json FROM bot_announcements WHERE message_id = ?').get('custom-message');
  assert.equal(saved.title, 'Halloween RP');
  assert.deepEqual(JSON.parse(saved.payload_json).reactionFailures, ['👻']);

  const repeated = await handleAnnouncementButton(interaction(publishId, { client }), { db });
  assert.match(repeated.content, /expired or was already processed/i);
  assert.equal(sent.length, 1);
});

test('custom message cancellation closes the draft without sending', async (t) => {
  const db = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = member('cancel-manager', managerRole);
  const guild = { id: 'cancel-guild', ownerId: 'owner', members: { me: { id: 'bot' } } };
  const common = { guild, member: manager, user: { id: manager.id, username: 'Manager' } };
  const invoke = (customId, values = [], fields = {}) => ({
    ...common, customId, values,
    fields: { getTextInputValue: (key) => fields[key] ?? '' },
    reply: async (payload) => payload,
    update: async (payload) => payload,
    showModal: async (modal) => modal,
  });
  const opened = await startCustomAnnouncement(invoke('unused'), { db });
  const selectId = opened.components[0].components[0].data.custom_id;
  const draftId = selectId.split(':').at(-1);
  const modal = await handleAnnouncementSelect(invoke(selectId, [config.STAFF_ANNOUNCEMENT_CHANNEL_ID]), { db });
  const preview = await handleAnnouncementModal(invoke(modal.data.custom_id, [], {
    content: 'Community update', embeds_json: '', reactions: '', buttons_json: '',
  }), { db });
  const cancelled = await handleAnnouncementButton(invoke(`gv:announce:cancel:${draftId}`), { db });
  assert.match(cancelled.content, /cancelled/i);
  assert.equal(db.prepare('SELECT status FROM announcement_drafts WHERE draft_id = ?').get(draftId).status, 'cancelled');
  assert.ok(preview.components.flatMap((row) => row.components).some((button) => button.data.custom_id === `gv:announce:cancel:${draftId}`));
});

test('custom publication refuses missing destination permissions and leaves the draft retryable', async (t) => {
  const db = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = member('permission-manager', managerRole);
  const guild = { id: 'permission-guild', ownerId: 'owner', members: { me: { id: 'bot' } } };
  const draftId = 'permission-draft';
  db.prepare(`INSERT INTO announcement_drafts
    (draft_id, owner_id, flow, payload_json, channel_id, status, expires_at, created_at)
    VALUES (?, ?, 'create', ?, ?, 'pending', ?, ?)`)
    .run(draftId, manager.id, JSON.stringify({ kind: 'custom', content: 'Test message', embeds: [], reactions: [], buttons: [] }),
      config.STAFF_ANNOUNCEMENT_CHANNEL_ID, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString());
  let sends = 0;
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async (id) => ({
      id, guildId: guild.id,
      isTextBased: () => true,
      permissionsFor: () => ({ has: () => false }),
      send: async () => { sends += 1; },
    }) },
  };
  const result = await handleAnnouncementButton({
    customId: `gv:announce:publish:${draftId}`,
    guild,
    member: manager,
    user: { id: manager.id, username: 'Manager' },
    client,
    deferUpdate: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db });
  assert.match(result.content, /View Channel and Send Messages/);
  assert.equal(sends, 0);
  assert.equal(db.prepare('SELECT status FROM announcement_drafts WHERE draft_id = ?').get(draftId).status, 'pending');

  for (const [key, id] of [
    ['STAFF_ANNOUNCEMENT_CHANNEL_ID', '323456789012345678'],
    ['EVENT_CHANNEL_ID', '423456789012345678'],
    ['SESSION_CHANNEL_ID', '523456789012345678'],
    ['STAFF_ACTIVITY_CHANNEL_ID', '623456789012345678'],
  ]) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(id));
  }
  const invalidTarget = await handleAnnouncementButton({
    customId: `gv:announce:publish:${draftId}`,
    guild,
    member: manager,
    user: { id: manager.id, username: 'Manager' },
    client,
    reply: async (payload) => payload,
  }, { db });
  assert.match(invalidTarget.content, /target is no longer a configured announcement channel/i);
  assert.equal(sends, 0);
  assert.equal(db.prepare('SELECT status FROM announcement_drafts WHERE draft_id = ?').get(draftId).status, 'pending');
});
