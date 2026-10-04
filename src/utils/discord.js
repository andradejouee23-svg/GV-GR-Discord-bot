const { EmbedBuilder } = require('discord.js');
const config = require('../../config');

function validId(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function getConfigValue(db, key) {
  const savedValue = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return savedValue ? JSON.parse(savedValue.value) : config[key];
}

function setConfigValue(db, key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, JSON.stringify(value));
}

function getRoleIds(db, group) {
  const keys = { staff: 'STAFF_ROLE_IDS', management: 'MANAGEMENT_ROLE_IDS', owners: 'OWNER_ROLE_IDS' };
  const settingKeys = { staff: 'role_staff', management: 'role_management', owners: 'role_owners' };
  return getConfigValue(db, settingKeys[group]) ?? getConfigValue(db, keys[group]) ?? [];
}

function memberRoleIds(member) {
  if (member.roles?.cache) return [...member.roles.cache.keys()];
  return member.roles ?? [];
}

function hasRoleGroup(member, db, group) {
  const memberRoles = new Set(memberRoleIds(member));
  const configuredRoles = group === 'management'
    ? [...getRoleIds(db, 'management'), ...getRoleIds(db, 'owners')]
    : getRoleIds(db, group);
  return configuredRoles.some((roleId) => validId(roleId) && memberRoles.has(roleId));
}

function getStaffRoleName(member, db) {
  const roleIds = [
    ...getRoleIds(db, 'staff'),
    ...getRoleIds(db, 'management'),
    ...getRoleIds(db, 'owners'),
  ];
  const memberRoles = member.roles?.cache;

  for (const roleId of [...roleIds].reverse()) {
    if (!validId(roleId) || !memberRoleIds(member).includes(roleId)) continue;
    return memberRoles?.get(roleId)?.name ?? 'Staff';
  }
  return null;
}

function makeEmbed(color, title, description) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description);
}

async function fetchGuildMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function getInteractionMember(interaction) {
  const member = interaction.member;
  if (member?.roles) {
    return {
      id: member.id ?? member.user?.id ?? interaction.user.id,
      roles: member.roles,
    };
  }
  return fetchGuildMember(interaction.guild, interaction.user.id);
}

async function sendToChannel(client, channelId, payload) {
  if (!validId(channelId)) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return false;
    await channel.send(payload);
    return true;
  } catch (error) {
    console.error(`Could not send to channel ${channelId}:`, error.message);
    return false;
  }
}

async function logStaffAction(client, db, payload) {
  const channels = new Set([
    getConfigValue(db, 'STAFF_LOG_CHANNEL_ID'),
    getConfigValue(db, 'STAFF_ACTIVITY_CHANNEL_ID'),
  ]);
  const results = await Promise.all([...channels].map((channelId) => sendToChannel(client, channelId, payload)));
  return results.some(Boolean);
}

function unixTime(isoDate, style = 'F') {
  return `<t:${Math.floor(new Date(isoDate).getTime() / 1000)}:${style}>`;
}

module.exports = {
  config,
  fetchGuildMember,
  getConfigValue,
  getInteractionMember,
  getRoleIds,
  getStaffRoleName,
  hasRoleGroup,
  logStaffAction,
  makeEmbed,
  memberRoleIds,
  sendToChannel,
  setConfigValue,
  unixTime,
  validId,
};