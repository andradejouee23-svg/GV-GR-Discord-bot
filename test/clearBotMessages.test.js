const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Collection } = require('discord.js');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleClearBotMessagesButton, handleClearBotMessagesCommand } = require('../src/commands/clearBotMessages');

const managerRoleId = '1556064708795306157';
const managerId = 'clear-manager';
const botId = 'clear-bot';

test('confirmed bot cleanup deletes only the bot’s unpinned non-record messages', async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-clear-bots-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRoleId]));

  const channelId = '1666064708795306156';
  const deleted = [];
  const now = Date.now();
  const messages = new Collection([
    ['recent-bot', { id: 'recent-bot', author: { id: botId }, createdTimestamp: now, pinned: false, content: 'Old status notice', embeds: [], delete: async () => deleted.push('recent-bot') }],
    ['old-bot', { id: 'old-bot', author: { id: botId }, createdTimestamp: now - 20 * 86400_000, pinned: false, content: 'Old status notice', embeds: [], delete: async () => deleted.push('old-bot') }],
    ['player', { id: 'player', author: { id: 'regular-player' }, createdTimestamp: now, pinned: false, content: 'Keep my message', embeds: [] }],
    ['pinned', { id: 'pinned', author: { id: botId }, createdTimestamp: now, pinned: true, content: 'Pinned bot info', embeds: [] }],
    ['record', { id: 'record', author: { id: botId }, createdTimestamp: now, pinned: false, content: '', embeds: [{ title: 'BLACKLIST RECORD' }] }],
  ]);
  const channel = {
    id: channelId,
    guildId: config.SERVER_ID,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => messages },
    bulkDelete: async (collection) => {
      for (const message of collection.values()) deleted.push(message.id);
      return collection;
    },
  };
  const manager = { id: managerId, roles: { cache: new Map([[managerRoleId, {}]]) } };
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'owner',
    members: { me: {}, fetch: async (id) => id === managerId ? manager : { id, roles: { cache: new Map() } } },
  };
  const client = { user: { id: botId }, channels: { fetch: async () => channel } };
  const command = await handleClearBotMessagesCommand({
    commandName: 'clear-bot-messages',
    guild,
    client,
    user: { id: managerId },
    options: { getChannel: () => channel, getInteger: () => 5 },
    reply: async (payload) => payload,
  }, { db });
  assert.equal(command.ephemeral, true);
  assert.deepEqual(deleted, []);
  const confirmId = command.components[0].components[0].data.custom_id;

  let denied;
  await handleClearBotMessagesButton({
    customId: confirmId,
    guild,
    client,
    user: { id: 'regular-player' },
    reply: async (payload) => { denied = payload; return payload; },
  }, { db });
  assert.match(denied.content, /management roles only/i);
  assert.deepEqual(deleted, []);

  let result;
  await handleClearBotMessagesButton({
    customId: confirmId,
    guild,
    client,
    user: { id: managerId },
    update: async (payload) => { result = payload; return payload; },
  }, { db });
  assert.match(result.content, /Removed \*\*2\*\* bot messages/);
  assert.deepEqual(new Set(deleted), new Set(['recent-bot', 'old-bot']));
});