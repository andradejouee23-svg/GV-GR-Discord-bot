const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const {
  createAnnouncementEmbed,
  handleAnnouncementButton,
  handleAnnouncementCommand,
  handleAnnouncementModal,
  handleAnnouncementSelect,
  parseFields,
  resolveAnnouncementTemplate,
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