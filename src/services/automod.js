const { createHash, randomUUID } = require('node:crypto');
const config = require('../../config');
const { getConfigValue, memberRoleIds } = require('../utils/discord');

const invitePattern = /https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[A-Za-z0-9-]+/i;
const linkPattern = /https?:\/\/[^\s<>()]+/gi;

function integerSetting(db, key, minimum, maximum) {
  const value = Number(getConfigValue(db, key));
  return Number.isInteger(value) ? Math.max(minimum, Math.min(maximum, value)) : config[key];
}

function enabledSetting(db, key) {
  return getConfigValue(db, key) === true;
}

function stringArraySetting(db, key) {
  const value = getConfigValue(db, key);
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function isExempt(db, member, channelId) {
  if (stringArraySetting(db, 'AUTOMOD_EXEMPT_CHANNEL_IDS').includes(channelId)) return true;
  const exemptRoles = new Set(stringArraySetting(db, 'AUTOMOD_EXEMPT_ROLE_IDS'));
  return member ? memberRoleIds(member).some((roleId) => exemptRoles.has(roleId)) : false;
}

function parsedLinks(content) {
  return (content.match(linkPattern) ?? []).flatMap((value) => {
    try { return [new URL(value.replace(/[.,!?]+$/, ''))]; } catch { return []; }
  });
}

function domainAllowed(hostname, allowlist) {
  const host = hostname.toLowerCase();
  return allowlist.some((domain) => {
    const normalized = domain.toLowerCase().replace(/^\*\./, '');
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

function claimUserActionCooldown(db, userId, feature, now = new Date(), cooldownMs = 60_000) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime()) || !Number.isFinite(cooldownMs) || cooldownMs <= 0) {
    throw new Error('Invalid user action cooldown parameters.');
  }
  return db.transaction(() => {
    const previous = db.prepare(`SELECT expires_at FROM user_action_cooldowns
      WHERE user_id = ? AND feature = ?`).get(userId, feature);
    const remainingMs = previous ? Date.parse(previous.expires_at) - nowDate.getTime() : 0;
    if (remainingMs > 0) return { allowed: false, remainingMs };
    const expiresAt = new Date(nowDate.getTime() + cooldownMs).toISOString();
    db.prepare(`INSERT INTO user_action_cooldowns (user_id, feature, expires_at)
      VALUES (?, ?, ?) ON CONFLICT(user_id, feature) DO UPDATE SET expires_at = excluded.expires_at`)
      .run(userId, feature, expiresAt);
    return { allowed: true, expiresAt };
  })();
}

function recordIncident(db, { sourceId, guildId, userId, channelId = null, type, reason, details = {}, now }) {
  const modeValue = getConfigValue(db, 'AUTOMOD_MODE');
  const mode = ['log', 'warn', 'delete', 'timeout'].includes(modeValue) ? modeValue : 'log';
  const result = db.prepare(`INSERT OR IGNORE INTO automod_incidents
    (source_id, guild_id, user_id, channel_id, incident_type, reason, mode, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sourceId, guildId, userId, channelId, type, reason, mode, JSON.stringify(details), now);
  if (!result.changes) return null;
  return { sourceId, guildId, userId, channelId, type, reason, mode, details };
}

function inspectAutomodMessage(db, message, now = new Date()) {
  if (!enabledSetting(db, 'AUTOMOD_ENABLED') || !message.guild || !message.author || message.author.bot || message.webhookId) return null;
  if (isExempt(db, message.member, message.channelId)) return null;

  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const spamWindow = integerSetting(db, 'AUTOMOD_SPAM_WINDOW_SECONDS', 3, 300);
  const repeatThreshold = integerSetting(db, 'AUTOMOD_REPEAT_THRESHOLD', 2, 20);
  const mentionLimit = integerSetting(db, 'AUTOMOD_MENTION_LIMIT', 2, 100);
  const content = String(message.content ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const contentHash = content.length >= 3 ? createHash('sha256').update(content).digest('hex') : null;
  const messageId = message.id || randomUUID();

  db.prepare('DELETE FROM automod_activity WHERE created_at < ?')
    .run(new Date(nowDate.getTime() - 10 * 60_000).toISOString());
  const inserted = db.prepare(`INSERT OR IGNORE INTO automod_activity
    (activity_id, guild_id, user_id, channel_id, activity_type, content_hash, created_at)
    VALUES (?, ?, ?, ?, 'message', ?, ?)`)
    .run(messageId, message.guild.id, message.author.id, message.channelId, contentHash, nowIso);
  if (!inserted.changes) return null;

  const cutoff = new Date(nowDate.getTime() - spamWindow * 1000).toISOString();
  const messagesInWindow = db.prepare(`SELECT COUNT(*) AS count FROM automod_activity
    WHERE guild_id = ? AND user_id = ? AND channel_id = ? AND activity_type = 'message' AND created_at >= ?`)
    .get(message.guild.id, message.author.id, message.channelId, cutoff).count;
  const repeatedMessages = contentHash ? db.prepare(`SELECT COUNT(*) AS count FROM automod_activity
    WHERE guild_id = ? AND user_id = ? AND channel_id = ? AND activity_type = 'message'
      AND content_hash = ? AND created_at >= ?`)
    .get(message.guild.id, message.author.id, message.channelId, contentHash, cutoff).count : 0;
  const mentionCount = (message.mentions?.users?.size ?? 0) + (message.mentions?.roles?.size ?? 0);
  const links = parsedLinks(String(message.content ?? ''));
  const allowlist = stringArraySetting(db, 'AUTOMOD_ALLOWLISTED_DOMAINS');
  const hasInvite = invitePattern.test(String(message.content ?? ''))
    && !links.some((link) => domainAllowed(link.hostname, allowlist));
  const hasUntrustedLink = links.some((link) => !domainAllowed(link.hostname, allowlist));

  let type;
  let reason;
  if (message.mentions?.everyone || mentionCount >= mentionLimit) {
    type = 'mention_abuse';
    reason = `Message mentioned ${mentionCount} users/roles.`;
  } else if (enabledSetting(db, 'AUTOMOD_FILTER_INVITES') && hasInvite) {
    type = 'invite_link';
    reason = 'Unallowlisted Discord invite detected.';
  } else if (enabledSetting(db, 'AUTOMOD_FILTER_LINKS') && hasUntrustedLink) {
    type = 'untrusted_link';
    reason = 'Link domain is not on the trusted-domain allowlist.';
  } else if (repeatedMessages >= repeatThreshold) {
    type = 'repeated_message';
    reason = `The same message was sent ${repeatedMessages} times in the configured window.`;
  } else if (messagesInWindow >= integerSetting(db, 'AUTOMOD_SPAM_THRESHOLD', 3, 100)) {
    type = 'spam';
    reason = `${messagesInWindow} messages were sent in ${spamWindow} seconds.`;
  } else {
    return null;
  }

  return recordIncident(db, {
    sourceId: messageId, guildId: message.guild.id, userId: message.author.id,
    channelId: message.channelId, type, reason,
    details: { mentionCount, messagesInWindow, repeatedMessages, contentHash }, now: nowIso,
  });
}

function inspectAutomodMemberJoin(db, member, now = new Date()) {
  if (!enabledSetting(db, 'AUTOMOD_ENABLED') || !member?.guild || !member.user) return null;
  const nowDate = now instanceof Date ? now : new Date(now);
  const windowSeconds = integerSetting(db, 'AUTOMOD_RAID_WINDOW_SECONDS', 5, 600);
  const cutoff = new Date(nowDate.getTime() - windowSeconds * 1000).toISOString();
  const sourceId = `join:${member.user.id}:${randomUUID()}`;
  const nowIso = nowDate.toISOString();
  db.prepare(`INSERT INTO automod_activity (activity_id, guild_id, user_id, activity_type, created_at)
    VALUES (?, ?, ?, 'join', ?)`)
    .run(sourceId, member.guild.id, member.user.id, nowIso);
  const joins = db.prepare(`SELECT COUNT(*) AS count FROM automod_activity
    WHERE guild_id = ? AND activity_type = 'join' AND created_at >= ?`).get(member.guild.id, cutoff).count;
  const threshold = integerSetting(db, 'AUTOMOD_RAID_THRESHOLD', 3, 500);
  if (joins < threshold) return null;
  const windowStart = new Date(Math.floor(nowDate.getTime() / (windowSeconds * 1000)) * windowSeconds * 1000).toISOString();
  const alert = db.prepare(`INSERT OR IGNORE INTO automod_alert_windows (guild_id, alert_type, window_start, created_at)
    VALUES (?, 'join_raid', ?, ?)`)
    .run(member.guild.id, windowStart, nowIso);
  if (!alert.changes) return null;
  return recordIncident(db, {
    sourceId: `raid:${member.guild.id}:${windowStart}`,
    guildId: member.guild.id,
    userId: member.user.id,
    type: 'raid_alert',
    reason: `${joins} members joined within ${windowSeconds} seconds. No automatic bans were applied.`,
    details: { joins, windowSeconds },
    now: nowIso,
  });
}

module.exports = {
  claimUserActionCooldown,
  inspectAutomodMemberJoin,
  inspectAutomodMessage,
  parsedLinks,
};