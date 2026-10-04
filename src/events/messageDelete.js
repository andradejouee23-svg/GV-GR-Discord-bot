const config = require('../../config');
const { getConfigValue, logStaffAction, makeEmbed, unixTime } = require('../utils/discord');

async function logMessageDeletion(message, client, db) {
  if (!message.guild || message.author?.bot
    || !getConfigValue(db, 'MESSAGE_DELETE_LOGGING_ENABLED')) return;

  const authorName = message.author?.username ?? 'Unknown';
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO moderation_logs (action, staff_id, staff_name, target_id, target_name, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('message_delete', 'unknown', 'Not recorded', message.author?.id ?? null,
    authorName, `Deleted in <#${message.channelId}>`, createdAt);

  const embed = makeEmbed(config.EMBED_COLORS.warning, '🛡️ Message Deleted',
    `**User:** ${message.author ? `<@${message.author.id}>` : authorName}\n**Channel:** <#${message.channelId}>\n**Date:** ${unixTime(createdAt)}`);
  await logStaffAction(client, db, { embeds: [embed] });
}

module.exports = { logMessageDeletion };