const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const {
  getPanelEditorConfig,
  handlePanelEditorButton,
  handlePanelEditorCommand,
  handlePanelEditorModal,
  handlePanelEditorSelect,
} = require('../src/commands/panelEditor');
const { setConfigValue } = require('../src/utils/discord');

const managerId = '1666064708795306156';
const managerRoleId = '1556064708795306157';
const channelId = '1666064708795306158';
const oldMessageId = '1666064708795306159';
const botId = '1666064708795306160';

function setup(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-panel-editor-'));
  const db = createDatabase(path.join(directory, 'panel.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  setConfigValue(db, 'role_management', [managerRoleId]);
  setConfigValue(db, 'ECONOMY_PANEL_MESSAGE_CHANNEL_ID', channelId);
  setConfigValue(db, 'ECONOMY_PANEL_MESSAGE_ID', oldMessageId);
  const manager = { id: managerId, roles: { cache: new Map([[managerRoleId, {}]]) } };
  const guild = { id: config.SERVER_ID, members: { fetch: async () => manager, me: {} } };
  const sends = [];
  const edits = [];
  const deleted = [];
  const channel = {
    id: channelId,
    guildId: config.SERVER_ID,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => { sends.push(payload); return { id: `new-message-${sends.length}` }; },
    messages: { fetch: async () => ({ author: { id: botId }, edit: async (payload) => { edits.push(payload); return payload; }, delete: async () => { deleted.push(oldMessageId); } }) },
  };
  const client = {
    user: { id: botId },
    guilds: { cache: new Map([[config.SERVER_ID, guild]]) },
    channels: { fetch: async () => channel },
  };
  return { db, guild, client, sends, edits, deleted };
}

function managerInteraction(env, properties = {}) {
  return {
    user: { id: managerId, username: 'Manager' },
    guild: env.guild,
    client: env.client,
    reply: async (payload) => payload,
    ...properties,
  };
}

test('panel editor previews and saves separate HEX/image/text settings while refreshing existing buttons', async (t) => {
  const env = setup(t);
  const opened = await handlePanelEditorCommand({ ...managerInteraction(env), commandName: 'panel-editor' }, { db: env.db });
  assert.equal(opened.components[0].components[0].data.custom_id, 'gv:panel_editor:select');

  const preview = await handlePanelEditorSelect(managerInteraction(env, {
    customId: 'gv:panel_editor:select',
    values: ['economy'],
    update: async (payload) => payload,
  }), { db: env.db });
  assert.match(preview.embeds[0].data.title, /Preview/);
  const textId = preview.components[0].components[0].data.custom_id;
  const textModal = await handlePanelEditorButton(managerInteraction(env, { customId: textId, showModal: async (modal) => modal }), { db: env.db });
  const textPreview = await handlePanelEditorModal(managerInteraction(env, {
    customId: textModal.data.custom_id,
    fields: { getTextInputValue: (key) => ({
      title: 'GV GR • Community Economy',
      description: 'A refreshed economy experience for Greenville.',
      footer: 'GV GR • Community',
      author: 'Greenville Roleplay',
      buttons: 'Open wallet|💳',
    }[key]) },
  }), { db: env.db });
  assert.match(textPreview.embeds[0].data.title, /GV GR • Community Economy/);

  const sectionsModal = await handlePanelEditorButton(managerInteraction(env, {
    customId: textPreview.components[0].components[3].data.custom_id,
    showModal: async (modal) => modal,
  }), { db: env.db });
  const sectionsPreview = await handlePanelEditorModal(managerInteraction(env, {
    customId: sectionsModal.data.custom_id,
    fields: { getTextInputValue: () => '1|COMMUNITY SERVICES|Browse Greenville products|inline' },
  }), { db: env.db });
  assert.match(sectionsPreview.embeds[0].data.fields[0].name, /COMMUNITY SERVICES/);

  const colorModal = await handlePanelEditorButton(managerInteraction(env, {
    customId: sectionsPreview.components[0].components[1].data.custom_id,
    showModal: async (modal) => modal,
  }), { db: env.db });
  const invalidColor = await handlePanelEditorModal(managerInteraction(env, {
    customId: colorModal.data.custom_id,
    fields: { getTextInputValue: () => '#12GG00' },
  }), { db: env.db });
  assert.match(invalidColor.content, /valid six-digit HEX/);
  const colorPreview = await handlePanelEditorModal(managerInteraction(env, {
    customId: colorModal.data.custom_id,
    fields: { getTextInputValue: () => '#5865F2' },
  }), { db: env.db });
  assert.equal(colorPreview.embeds[0].data.color, 0x5865f2);

  const imageModal = await handlePanelEditorButton(managerInteraction(env, {
    customId: colorPreview.components[0].components[2].data.custom_id,
    showModal: async (modal) => modal,
  }), { db: env.db });
  const imagePreview = await handlePanelEditorModal(managerInteraction(env, {
    customId: imageModal.data.custom_id,
    fields: { getTextInputValue: () => 'https://example.com/gv-header.png' },
  }), { db: env.db });
  assert.ok(imagePreview.embeds[0]);

  const save = await handlePanelEditorButton(managerInteraction(env, {
    customId: imagePreview.components[1].components[0].data.custom_id,
    update: async (payload) => payload,
  }), { db: env.db });
  assert.match(save.content, /customization saved/);
  const saved = getPanelEditorConfig(env.db, 'economy');
  assert.equal(saved.title, 'GV GR • Community Economy');
  assert.equal(saved.colorHex, '#5865F2');
  assert.equal(saved.headerImageUrl, 'https://example.com/gv-header.png');
  assert.equal(saved.buttonLabels[0].label, 'Open wallet');
  assert.equal(env.sends.length, 2);
  assert.equal(env.sends[0].embeds[0].data.image.url, 'https://example.com/gv-header.png');
  assert.equal(env.sends[1].embeds[0].data.title, 'GV GR • Community Economy');
  assert.match(env.sends[1].embeds[0].data.fields[0].name, /COMMUNITY SERVICES/);
  assert.ok(env.sends[1].components.flatMap((row) => row.components).some((button) => button.data.custom_id === 'gv:economy:wallet'));
  assert.equal(env.deleted.length, 1);

  const secondPreview = await handlePanelEditorSelect(managerInteraction(env, {
    customId: 'gv:panel_editor:select', values: ['economy'], update: async (payload) => payload,
  }), { db: env.db });
  const removeImageModal = await handlePanelEditorButton(managerInteraction(env, {
    customId: secondPreview.components[0].components[2].data.custom_id,
    showModal: async (modal) => modal,
  }), { db: env.db });
  const removeImagePreview = await handlePanelEditorModal(managerInteraction(env, {
    customId: removeImageModal.data.custom_id,
    fields: { getTextInputValue: () => '' },
  }), { db: env.db });
  await handlePanelEditorButton(managerInteraction(env, {
    customId: removeImagePreview.components[1].components[0].data.custom_id,
    update: async (payload) => payload,
  }), { db: env.db });
  assert.equal(getPanelEditorConfig(env.db, 'economy').headerImageUrl, '');
  assert.equal(getPanelEditorConfig(env.db, 'economy').headerMessageId, null);
  assert.equal(env.deleted.length, 2);
});
