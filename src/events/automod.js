const config = require('../../config');
const { logAudit } = require('../services/staffRewards');
const { claimUserActionCooldown, inspectAutomodMemberJoin, inspectAutomodMessage } = require('../services/automod');
const { getConfigValue, logStaffAction, makeEmbed } = require('../utils/discord');

async function applyAutomodMessage(message, client, db) {
  const incident = inspectAutomodMessage(db, message);
  if (!incident) return null;
  let actionResult = 'logged';
  if (incident.mode === 'warn') {
    const warningCooldown = claimUserActionCooldown(db, incident.userId, 'automod_warning', new Date(), 30 * 60_000);
    if (!warningCooldown.allowed) {
      actionResult = 'warning_suppressed_by_cooldown';
    } else {
      try {
        await message.author.send(`GV GR AutoMod noticed a possible policy issue: ${incident.reason} Please review the server rules before posting again.`);
        actionResult = 'private_warning_sent';
      } catch {
        actionResult = 'private_warning_unavailable';
      }
    }
  } else if (incident.mode === 'delete') {
    try {
      await message.delete();
      actionResult = 'message_deleted';
    } catch (error) {
      actionResult = `delete_failed: ${error.message}`;
    }
  } else if (incident.mode === 'timeout' && ['spam', 'repeated_message', 'mention_abuse'].includes(incident.type)) {
    const timeoutAfter = Math.max(1, Math.min(20, Number(getConfigValue(db, 'AUTOMOD_TIMEOUT_AFTER_INCIDENTS')) || config.AUTOMOD_TIMEOUT_AFTER_INCIDENTS));
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const incidentCount = db.prepare(`SELECT COUNT(*) AS count FROM automod_incidents
      WHERE user_id = ? AND incident_type IN ('spam', 'repeated_message', 'mention_abuse')
        AND mode IN ('warn', 'timeout') AND created_at >= ?`)
      .get(incident.userId, cutoff).count;
    if (incidentCount < timeoutAfter) {
      const warningCooldown = claimUserActionCooldown(db, incident.userId, 'automod_warning', new Date(), 30 * 60_000);
      if (!warningCooldown.allowed) {
        actionResult = `warning_suppressed_by_cooldown_${incidentCount}_of_${timeoutAfter}`;
      } else {
        try {
          await message.author.send(`GV GR AutoMod warning: ${incident.reason} Another qualifying incident within 24 hours may result in a timeout.`);
          actionResult = `private_warning_sent_${incidentCount}_of_${timeoutAfter}`;
        } catch {
          actionResult = `warning_logged_${incidentCount}_of_${timeoutAfter}`;
        }
      }
    } else if (incidentCount > timeoutAfter) {
      actionResult = 'timeout_already_applied_in_rolling_window';
    } else {
      try {
        const timeoutMinutes = Math.max(1, Math.min(60, Number(getConfigValue(db, 'AUTOMOD_TIMEOUT_MINUTES')) || config.AUTOMOD_TIMEOUT_MINUTES));
        if (!message.member?.timeout) throw new Error('Member timeout action is unavailable.');
        await message.member.timeout(timeoutMinutes * 60_000, `GV GR AutoMod: ${incident.reason}`);
        actionResult = `timed_out_${timeoutMinutes}_minutes`;
      } catch (error) {
        actionResult = `timeout_failed: ${error.message}`;
      }
    }
  }
  db.prepare('UPDATE automod_incidents SET action_result = ? WHERE source_id = ?').run(actionResult, incident.sourceId);
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO moderation_logs (action, staff_id, staff_name, target_id, target_name, reason, created_at)
    VALUES (?, 'automod', 'GV GR AutoMod', ?, ?, ?, ?)`)
    .run(`automod_${incident.type}`, incident.userId, message.author?.username ?? 'Unknown', incident.reason, timestamp);
  logAudit(db, {
    action: `automod_${incident.type}`, targetId: incident.userId, actorId: 'automod',
    reason: incident.reason, createdAt: timestamp,
    details: { channelId: incident.channelId, messageId: incident.sourceId, actionResult, ...incident.details },
  });
  await logStaffAction(client, db, {
    embeds: [makeEmbed(config.EMBED_COLORS.warning, `🛡️ AutoMod • ${incident.type.replaceAll('_', ' ')}`,
      `Member: <@${incident.userId}>\nChannel: <#${incident.channelId}>\nReason: ${incident.reason}\nAction: ${actionResult}\nMessage body was not stored.`)],
    allowedMentions: { parse: [] },
  });
  return { ...incident, actionResult };
}

async function applyAutomodJoin(member, client, db) {
  const incident = inspectAutomodMemberJoin(db, member);
  if (!incident) return null;
  const timestamp = new Date().toISOString();
  logAudit(db, {
    action: 'automod_raid_alert', targetId: incident.userId, actorId: 'automod',
    reason: incident.reason, createdAt: timestamp, details: incident.details,
  });
  await logStaffAction(client, db, {
    embeds: [makeEmbed(config.EMBED_COLORS.error, '🚨 Possible Join Raid',
      `${incident.reason}\nAlert only. No members were banned or removed.`)],
    allowedMentions: { parse: [] },
  });
  return incident;
}

module.exports = { applyAutomodJoin, applyAutomodMessage };