const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleButton } = require('../src/buttons');
const { getTownJobOptions, handleTownJobsCommand } = require('../src/commands/townJobs');

const managerRoleId = '1556064708795306157';
const managerId = 'town-jobs-manager';
const panelChannelId = '1666064708795306156';
const jobRoleIds = [
  '1666064708795306157',
  '1666064708795306158',
  '1666064708795306159',
];

function createEnvironment(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-town-jobs-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRoleId]));

  const manager = { id: managerId, roles: { cache: new Map([[managerRoleId, { id: managerRoleId, name: 'Admin' }]]) } };
  const roles = new Map(jobRoleIds.map((id, index) => [id, { id, name: `Job ${index + 1}`, position: index + 1, managed: false }]));
  const members = new Map();
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'server-owner',
    roles: { fetch: async (id) => roles.get(id) ?? null },
    members: {
      me: { permissions: { has: () => true }, roles: { highest: { position: 100 } } },
      fetch: async (id) => {
        if (id === managerId) return manager;
        return members.get(id) ?? { id, roles: { cache: new Map() } };
      },
    },
  };
  const posts = [];
  const edits = [];
  let retiredPanels = 0;
  const channels = new Map();
  const channel = {
    id: panelChannelId,
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      posts.push(payload);
      return { id: '1776064708795306156' };
    },
    messages: { fetch: async () => ({
      author: { id: 'townjobs-bot' },
      edit: async (payload) => { edits.push(payload); return { id: '1776064708795306156' }; },
      delete: async () => { retiredPanels += 1; },
    }) },
  };
  channels.set(panelChannelId, channel);
  const client = { user: { id: 'townjobs-bot' }, channels: { fetch: async (id) => channels.get(id) ?? null } };
  return { db, guild, client, roles, members, posts, edits, channel, channels, get retiredPanels() { return retiredPanels; } };
}

function commandInteraction(env, subcommand, options = {}, userId = managerId) {
  const manager = userId === managerId;
  let lastReply;
  return {
    commandName: 'townjobs',
    guild: env.guild,
    client: env.client,
    user: { id: userId, username: manager ? 'Manager' : 'Player' },
    options: { getSubcommand: () => subcommand, ...options },
    reply: async (payload) => { lastReply = payload; return payload; },
    get lastReply() { return lastReply; },
  };
}

function jobOptions(values = {}) {
  return {
    getString: (name) => values[name] ?? null,
    getRole: () => values.role ?? null,
    getChannel: () => values.channel ?? null,
  };
}

function addMember(env, id) {
  const cache = new Map();
  const member = {
    id,
    roles: {
      cache,
      add: async (roleId) => cache.set(typeof roleId === 'string' ? roleId : roleId.id, env.roles.get(typeof roleId === 'string' ? roleId : roleId.id)),
      remove: async (roleId) => cache.delete(typeof roleId === 'string' ? roleId : roleId.id),
    },
  };
  env.members.set(id, member);
  return member;
}

test('management configures roles and updates one persistent panel message', async (t) => {
  const env = createEnvironment(t);
  const unauthorizedInteraction = commandInteraction(env, 'add', jobOptions({
    label: 'Police', role: env.roles.get(jobRoleIds[0]),
  }), 'regular-player');
  await handleTownJobsCommand(unauthorizedInteraction, { db: env.db });
  assert.match(unauthorizedInteraction.lastReply.content, /management roles only/i);

  const configure = await handleTownJobsCommand(commandInteraction(env, 'configure', jobOptions({
    title: 'Town Jobs',
    description: 'Choose a role below.',
    channel: env.channel,
  })), { db: env.db });
  assert.match(configure.content, /Updated Town Jobs panel settings/);

  const first = await handleTownJobsCommand(commandInteraction(env, 'add', jobOptions({
    label: 'State Police',
    role: env.roles.get(jobRoleIds[0]),
    description: 'Serve the community.',
    emoji: '🚓',
    action: 'toggle',
    style: 'primary',
  })), { db: env.db });
  assert.match(first.content, /Added/);
  const duplicate = await handleTownJobsCommand(commandInteraction(env, 'add', jobOptions({
    label: 'Duplicate Police',
    role: env.roles.get(jobRoleIds[0]),
  })), { db: env.db });
  assert.match(duplicate.content, /already assigned/);
  assert.equal(getTownJobOptions(env.db).length, 1);

  const firstPublish = await handleTownJobsCommand(commandInteraction(env, 'panel', {
    getChannel: () => null,
  }), { db: env.db });
  const secondPublish = await handleTownJobsCommand(commandInteraction(env, 'panel', {
    getChannel: () => null,
  }), { db: env.db });
  assert.match(firstPublish.content, /published/);
  assert.match(secondPublish.content, /updated/);
  assert.equal(env.posts.length, 1);
  assert.equal(env.edits.length, 1);
  assert.equal(env.posts[0].embeds[0].data.title, 'Town Jobs');
  const publicPanelText = JSON.stringify(env.posts[0].embeds[0].data);
  assert.doesNotMatch(publicPanelText, /<@&/);
  for (const roleId of jobRoleIds) assert.equal(publicPanelText.includes(roleId), false);
  assert.match(publicPanelText, /Serve the community/);
  assert.equal(env.posts[0].components[0].components[0].data.custom_id, `gv:townjobs:role:${getTownJobOptions(env.db)[0].id}`);
  assert.equal(env.posts[0].components[0].components[0].data.emoji.name, '🚓');
  assert.deepEqual(getTownJobOptions(env.db).map((job) => job.roleId), [jobRoleIds[0]]);

  const movedChannel = {
    ...env.channel,
    id: '1666064708795306159',
    send: async () => ({ id: '1776064708795306157' }),
    messages: { fetch: async () => { throw new Error('No panel in this channel'); } },
  };
  env.channels.set(movedChannel.id, movedChannel);
  const moved = await handleTownJobsCommand(commandInteraction(env, 'panel', {
    getChannel: () => movedChannel,
  }), { db: env.db });
  assert.match(moved.content, /published/);
  assert.equal(env.retiredPanels, 1);
});

test('role buttons assign, toggle, remove, and respect configured role behavior', async (t) => {
  const env = createEnvironment(t);
  const job = { id: 'a1b2c3d4', roleId: jobRoleIds[0], label: 'State Police', description: '', emoji: '', action: 'toggle', style: 'success' };
  const removeJob = { id: 'd4c3b2a1', roleId: jobRoleIds[1], label: 'Leave Fire', description: '', emoji: '', action: 'remove', style: 'danger' };
  const giveJob = { id: '1234abcd', roleId: jobRoleIds[2], label: 'DOT', description: '', emoji: '', action: 'give', style: 'secondary' };
  env.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('TOWN_JOBS_ROLE_OPTIONS', JSON.stringify([job, removeJob, giveJob]));
  const member = addMember(env, 'town-jobs-player');
  let reply;
  const click = async (id) => handleButton({
    customId: `gv:townjobs:role:${id}`,
    guild: env.guild,
    user: { id: member.id },
    reply: async (payload) => { reply = payload; return payload; },
  }, { db: env.db });

  await click(job.id);
  assert.equal(member.roles.cache.has(job.roleId), true);
  assert.match(reply.content, /Assigned/);
  await click(job.id);
  assert.equal(member.roles.cache.has(job.roleId), false);
  assert.match(reply.content, /Removed/);

  member.roles.cache.set(removeJob.roleId, env.roles.get(removeJob.roleId));
  await click(removeJob.id);
  assert.equal(member.roles.cache.has(removeJob.roleId), false);
  assert.match(reply.content, /Removed/);

  await click(giveJob.id);
  assert.equal(member.roles.cache.has(giveJob.roleId), true);
  await click(giveJob.id);
  assert.match(reply.content, /already have/);
  assert.deepEqual(getTownJobOptions(env.db).map((option) => option.roleId), jobRoleIds);
});

test('job buttons reject unavailable settings and role hierarchy failures', async (t) => {
  const env = createEnvironment(t);
  const job = { id: 'a1b2c3d4', roleId: jobRoleIds[0], label: 'Police', description: '', emoji: '', action: 'give', style: 'primary' };
  env.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('TOWN_JOBS_ROLE_OPTIONS', JSON.stringify([job]));
  const member = addMember(env, 'town-jobs-player');
  env.guild.members.me.roles.highest.position = 1;
  let reply;
  await handleButton({
    customId: `gv:townjobs:role:${job.id}`,
    guild: env.guild,
    user: { id: member.id },
    reply: async (payload) => { reply = payload; return payload; },
  }, { db: env.db });
  assert.match(reply.content, /highest role must be above/);
  assert.equal(member.roles.cache.has(job.roleId), false);
});