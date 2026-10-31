const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { setConfigValue } = require('../src/utils/discord');
const { buildWelcomeComponents, buildWelcomeEmbed, welcomeNewMember } = require('../src/events/memberJoin');

const welcomeId = '1666064708795306156';
const howToJoinId = '1666064708795306157';
const rulesId = '1666064708795306158';

function makeTempDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-member-welcome-'));
  const db = createDatabase(path.join(directory, 'welcome.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('welcome embed uses the new member avatar thumbnail and links to configured channels', async (t) => {
  const db = makeTempDatabase(t);
  for (const [key, value] of [
    ['WELCOME_CHANNEL_ID', welcomeId],
    ['HOW_TO_JOIN_CHANNEL_ID', howToJoinId],
    ['SERVER_RULES_CHANNEL_ID', rulesId],
  ]) setConfigValue(db, key, value);

  const avatarUrl = 'https://cdn.discordapp.com/avatars/player/avatar.png';
  const guild = {
    id: config.SERVER_ID,
    name: 'Greenville Roleplay',
    memberCount: 123,
    members: { me: {} },
    channels: {
      fetch: async (id) => ({ id, isTextBased: () => true }),
    },
    iconURL: () => 'https://cdn.discordapp.com/icons/server/server.png',
  };
  const member = {
    id: 'player-id',
    guild,
    user: { displayAvatarURL: () => avatarUrl },
  };
  const sent = [];
  const welcomeChannel = {
    id: welcomeId,
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => { sent.push(payload); return payload; },
  };
  const client = { channels: { fetch: async () => welcomeChannel } };

  const embed = buildWelcomeEmbed(member).toJSON();
  assert.equal(embed.title, 'WELCOME TO GV GR!');
  assert.match(embed.description, /<@player-id>/);
  assert.match(embed.description, /Greenville Roleplay/);
  assert.equal(embed.thumbnail.url, avatarUrl);
  assert.notEqual(embed.thumbnail.url, guild.iconURL());

  const buttonRows = buildWelcomeComponents(guild.id, howToJoinId, rulesId);
  assert.deepEqual(buttonRows[0].components.map((button) => button.data.label), ['How to Join', 'Server Rules']);
  assert.deepEqual(buttonRows[0].components.map((button) => button.data.url), [
    `https://discord.com/channels/${guild.id}/${howToJoinId}`,
    `https://discord.com/channels/${guild.id}/${rulesId}`,
  ]);

  await welcomeNewMember(member, db, client);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].allowedMentions, { users: [member.id] });
  assert.equal(sent[0].embeds[0].data.thumbnail.url, avatarUrl);
});