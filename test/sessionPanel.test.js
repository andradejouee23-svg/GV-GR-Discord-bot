const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleButton } = require('../src/buttons');
const { createPanelComponents } = require('../src/commands/clock');
const { getSessionQuickStartDefaults, handleOperationsCommand, handleSessionPanelModal, makeSessionButtons } = require('../src/commands/operations');
const { setConfigValue } = require('../src/utils/discord');

const sessionChannelId = '1666064708795306156';
const staffRoleId = '1556064708795306156';
const managerRoleId = '1556064708795306157';
const staffId = '1666064708795306157';
const managerId = '1666064708795306158';

test('staff panel starts and ends a branded RP session announcement through buttons and a modal', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-session-panel-'));
  const db = createDatabase(path.join(directory, 'session.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  setConfigValue(db, 'role_staff', [staffRoleId]);
  setConfigValue(db, 'role_management', [managerRoleId]);
  setConfigValue(db, 'SESSION_CHANNEL_ID', sessionChannelId);

  const memberFor = (id) => ({
    id,
    user: { username: id === staffId ? 'SessionHost' : 'Manager' },
    roles: { cache: new Map([[id === staffId ? staffRoleId : managerRoleId, {}]]) },
  });
  const memberCache = new Map([[staffId, memberFor(staffId)], [managerId, memberFor(managerId)]]);
  const sent = [];
  const edits = [];
  const channel = {
    id: sessionChannelId,
    guildId: config.SERVER_ID,
    isTextBased: () => true,
    send: async (payload) => {
      sent.push(payload);
      return { id: `session-message-${sent.length}`, channelId: sessionChannelId };
    },
    messages: { fetch: async () => ({ author: { id: 'session-bot' }, edit: async (payload) => { edits.push(payload); return payload; } }) },
  };
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'owner',
    iconURL: () => null,
    members: { fetch: async (id) => memberCache.get(id), me: {} },
  };
  const client = { user: { id: 'session-bot' }, channels: { fetch: async () => channel } };
  const panelButtons = createPanelComponents().flatMap((row) => row.components);
  assert.ok(panelButtons.some((button) => button.data.custom_id === 'mgmt:economy' && button.data.label === 'Economy'));
  assert.ok(panelButtons.some((button) => button.data.custom_id === 'gv:session_panel:quick-start' && button.data.label === 'Quick Start Session'));
  assert.ok(panelButtons.some((button) => button.data.custom_id === 'gv:session_panel:start' && button.data.label === 'Start RP Session'));
  assert.ok(panelButtons.some((button) => button.data.custom_id === 'gv:session_panel:end' && button.data.label === 'End Session'));

  let modal;
  await handleButton({
    customId: 'gv:session_panel:start',
    user: { id: staffId, username: 'SessionHost' },
    guild,
    client,
    showModal: async (value) => { modal = value; return value; },
    reply: async (payload) => payload,
  }, { db, client });
  assert.equal(modal.data.custom_id, `gv:session_panel_start:${staffId}`);

  let startedReply;
  await handleSessionPanelModal({
    customId: modal.data.custom_id,
    user: { id: staffId, username: 'SessionHost' },
    guild,
    client,
    fields: { getTextInputValue: (key) => key === 'name' ? 'Friday Cruise Night' : 'Meet at the dealership.' },
    reply: async (payload) => { startedReply = payload; return payload; },
  }, { db, client });
  assert.match(startedReply.content, /Session #1 started/);
  assert.match(sent[0].embeds[0].data.title, /GV GR.*Friday Cruise Night/);
  assert.match(sent[0].embeds[0].data.description, /SESSION LIVE/);
  assert.equal(sent[0].components[0].components[0].data.custom_id, 'gv:session_join:1');
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id = 1").get().status, 'active');

  let duplicateReply;
  await handleButton({
    customId: 'gv:session_panel:start',
    user: { id: staffId, username: 'SessionHost' },
    guild,
    client,
    reply: async (payload) => { duplicateReply = payload; return payload; },
  }, { db, client });
  assert.match(duplicateReply.content, /already active/);

  let endedReply;
  await handleButton({
    customId: 'gv:session_panel:end',
    user: { id: managerId, username: 'Manager' },
    guild,
    client,
    reply: async (payload) => { endedReply = payload; return payload; },
  }, { db, client });
  assert.match(endedReply.content, /Session #1 ended/);
  assert.equal(db.prepare("SELECT status FROM sessions WHERE id = 1").get().status, 'completed');
  assert.equal(edits[0].embeds[0].data.title, '🎙️ RP Session Ended');
  assert.equal(edits[0].components.length, 0);
  assert.equal(sent.filter((payload) => payload.embeds?.[0]?.data.title === '🎙️ RP Session Ended').length, 0);
  const messageCountBeforeRepeat = sent.length;
  let repeatedEndReply;
  await handleButton({
    customId: 'gv:session_panel:end',
    user: { id: managerId, username: 'Manager' },
    guild,
    client,
    reply: async (payload) => { repeatedEndReply = payload; return payload; },
  }, { db, client });
  assert.match(repeatedEndReply.content, /no active RP session/i);
  assert.equal(sent.length, messageCountBeforeRepeat);
  assert.equal(edits.length, 1);

  let quickReply;
  await handleButton({
    customId: 'gv:session_panel:quick-start',
    user: { id: staffId, username: 'SessionHost' },
    guild,
    client,
    reply: async (payload) => { quickReply = payload; return payload; },
  }, { db, client });
  assert.match(quickReply.content, /Session #2 started/);
  const quickSession = db.prepare('SELECT * FROM sessions WHERE id = 2').get();
  assert.equal(quickSession.name, 'Greenville RP Session');
  assert.equal(quickSession.status, 'active');
  assert.equal(quickSession.channel_id, sessionChannelId);
  assert.ok(quickSession.message_id);
  const quickAnnouncement = sent.find((payload) => payload.embeds?.[0]?.data.title === '🎙️ GV GR • Greenville RP Session');
  assert.match(quickAnnouncement.embeds[0].data.description, /SESSION LIVE/);
  assert.equal(quickAnnouncement.components[0].components[0].data.custom_id, 'gv:session_join:2');

  await handleButton({
    customId: 'gv:session_panel:end',
    user: { id: managerId, username: 'Manager' },
    guild,
    client,
    reply: async (payload) => payload,
  }, { db, client });
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id = 2').get().status, 'completed');
});

test('management can edit Quick Start defaults and the saved image, style, and button persist after restart', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-session-defaults-'));
  const databasePath = path.join(directory, 'session.sqlite');
  let db = createDatabase(databasePath);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  setConfigValue(db, 'role_management', [managerRoleId]);
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'owner',
    members: { fetch: async (id) => id === managerId ? { id, roles: { cache: new Map([[managerRoleId, {}]]) } } : null },
  };
  const values = {
    name: 'Friday Convoy',
    description: 'Meet at the main dealership at 7 PM.',
    'image-url': 'https://example.com/convoy.jpg',
    color: '#36A765',
    footer: 'GV GR • Friday Night',
    'button-label': 'Join the convoy',
    'button-emoji': '🚘',
  };
  let reply;
  await handleOperationsCommand({
    commandName: 'session',
    guild,
    user: { id: managerId },
    options: {
      getSubcommand: () => 'configure',
      getString: (key) => values[key] ?? null,
      getBoolean: () => false,
    },
    reply: async (payload) => { reply = payload; return payload; },
  }, { db });
  assert.match(reply.content, /Saved Quick Start Session defaults/);
  db.close();
  db = createDatabase(databasePath);
  const defaults = getSessionQuickStartDefaults(db);
  assert.equal(defaults.name, values.name);
  assert.equal(defaults.description, values.description);
  assert.equal(defaults.imageUrl, values['image-url']);
  assert.equal(defaults.color, 0x36a765);
  assert.equal(defaults.footer, values.footer);
  const joinButton = makeSessionButtons(42, defaults)[0].components[0].toJSON();
  assert.equal(joinButton.label, 'Join the convoy');
  assert.equal(joinButton.emoji.name, '🚘');
  assert.equal(joinButton.custom_id, 'gv:session_join:42');
});
