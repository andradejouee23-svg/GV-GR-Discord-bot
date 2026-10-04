const config = require('../../config');
const { getShiftSummary } = require('../services/activity');
const { logAudit } = require('../services/staffRewards');
const { formatDuration } = require('../utils/format');
const {
  fetchGuildMember,
  getConfigValue,
  getStaffRoleName,
  hasRoleGroup,
  logStaffAction,
  makeEmbed,
  sendToChannel,
  setConfigValue,
  unixTime,
} = require('../utils/discord');
const { isManagement, isOwner } = require('./staffCenter');

async function ensureManagement(interaction, db, ownerOnly = false) {
  const member = await fetchGuildMember(interaction.guild, interaction.user.id);
  const allowed = member && (ownerOnly
    ? isOwner(member, interaction.guild, db)
    : isManagement(member, interaction.guild, db));
  if (allowed) return member;
  await interaction.reply({ content: ownerOnly
    ? 'This configuration command is reserved for the configured Owner and Co-Owner roles.'
    : 'This command is available to configured management roles only.', ephemeral: true });
  return null;
}

async function staffWarning(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const target = interaction.options.getUser('member', true);
  const member = await fetchGuildMember(interaction.guild, target.id);
  if (!member || !getStaffRoleName(member, ctx.db)) {
    return interaction.reply({ content: 'That user does not currently have a configured staff role.', ephemeral: true });
  }

  const reason = interaction.options.getString('reason', true);
  const now = new Date().toISOString();
  const previousCount = ctx.db.prepare('SELECT COUNT(*) AS count FROM warnings WHERE user_id = ?').get(target.id).count;
  const warningNumber = previousCount + 1;
  ctx.db.prepare(`
    INSERT INTO warnings (user_id, username, moderator_id, moderator_name, reason, warning_number, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(target.id, target.username, interaction.user.id, interaction.user.username, reason, warningNumber, now);

  const embed = makeEmbed(config.EMBED_COLORS.warning, `⚠️ Staff Warning #${warningNumber}`,
    `Staff Member: <@${target.id}>\nModerator: <@${interaction.user.id}>\nReason: ${reason}\nDate: ${unixTime(now)}`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [embed] });
  return interaction.reply({ content: `Warning #${warningNumber} recorded for <@${target.id}>.`, ephemeral: true });
}

async function staffNotes(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const subcommand = interaction.options.getSubcommand();
  const target = interaction.options.getUser('member', true);
  const targetMember = await fetchGuildMember(interaction.guild, target.id);
  if (!targetMember || !getStaffRoleName(targetMember, ctx.db)) {
    return interaction.reply({ content: 'That user does not currently have a configured staff role.', ephemeral: true });
  }

  if (subcommand === 'add') {
    const note = interaction.options.getString('note', true);
    const now = new Date().toISOString();
    ctx.db.prepare(`
      INSERT INTO staff_notes (user_id, username, author_id, author_name, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(target.id, target.username, interaction.user.id, interaction.user.username, note, now);
    await logStaffAction(interaction.client, ctx.db, {
      embeds: [makeEmbed(config.EMBED_COLORS.management, '📝 Staff Note Added', `Staff Member: <@${target.id}>\nAdded by: <@${interaction.user.id}>\nDate: ${unixTime(now)}`)],
    });
    return interaction.reply({ content: `Private staff note added for <@${target.id}>.`, ephemeral: true });
  }

  const notes = ctx.db.prepare(`
    SELECT author_id, note, created_at FROM staff_notes WHERE user_id = ? ORDER BY id DESC LIMIT 10
  `).all(target.id);
  const description = notes.length
    ? notes.map((row) => `**${unixTime(row.created_at)} • <@${row.author_id}>**\n${row.note}`).join('\n\n')
    : 'No staff notes have been recorded.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.management, `📝 Staff Notes • ${target.username}`, description)], ephemeral: true });
}

async function staffHistory(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const target = interaction.options.getUser('member', true);
  const warnings = ctx.db.prepare(`
    SELECT warning_number, reason, moderator_id, created_at FROM warnings WHERE user_id = ? ORDER BY id DESC LIMIT 5
  `).all(target.id);
  const notes = ctx.db.prepare(`
    SELECT note, author_id, created_at FROM staff_notes WHERE user_id = ? ORDER BY id DESC LIMIT 5
  `).all(target.id);
  const shifts = ctx.db.prepare(`
    SELECT started_at, ended_at, duration_seconds FROM shifts WHERE user_id = ? ORDER BY id DESC LIMIT 5
  `).all(target.id);
  const summary = getShiftSummary(ctx.db, target.id);
  const warningText = warnings.length
    ? warnings.map((row) => `#${row.warning_number} by <@${row.moderator_id}> • ${unixTime(row.created_at, 'd')}\n${row.reason}`).join('\n')
    : 'None';
  const shiftText = shifts.length
    ? shifts.map((row) => `${unixTime(row.started_at, 'd')} • ${row.ended_at ? formatDuration(row.duration_seconds) : 'On duty'}`).join('\n')
    : 'None';
  const noteText = notes.length
    ? notes.map((row) => `${unixTime(row.created_at, 'd')} by <@${row.author_id}>: ${row.note}`).join('\n')
    : 'None';

  const embed = makeEmbed(config.EMBED_COLORS.management, `📋 Staff History • ${target.username}`, '')
    .addFields(
      { name: 'Warnings', value: warningText.slice(0, 1024) },
      { name: 'Recent Shifts', value: shiftText.slice(0, 1024) },
      { name: 'Private Notes', value: noteText.slice(0, 1024) },
      { name: 'Total Hours', value: formatDuration(summary.totalSeconds), inline: true },
    );
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function staffAnnouncement(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const channelId = getConfigValue(ctx.db, 'STAFF_ANNOUNCEMENT_CHANNEL_ID');
  const title = interaction.options.getString('title', true);
  const message = interaction.options.getString('message', true);
  const embed = makeEmbed(config.EMBED_COLORS.management, `📢 ${title}`, message)
    .setFooter({ text: `GV GR Staff • Posted by ${interaction.user.username}` })
    .setTimestamp();
  const sent = await sendToChannel(interaction.client, channelId, { embeds: [embed] });
  if (!sent) {
    return interaction.reply({ content: 'I could not post the announcement. Check STAFF_ANNOUNCEMENT_CHANNEL_ID and my channel permissions.', ephemeral: true });
  }
  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.management, '📢 Staff Announcement Posted', `Title: **${title}**\nPosted by: <@${interaction.user.id}>`)],
  });
  return interaction.reply({ content: 'Staff announcement posted.', ephemeral: true });
}

async function staffConfig(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db, true)) return;
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'channel') {
    const setting = interaction.options.getString('setting', true);
    const channel = interaction.options.getChannel('channel', true);
    const previous = getConfigValue(ctx.db, setting);
    setConfigValue(ctx.db, setting, channel.id);
    logAudit(ctx.db, {
      action: 'permission_change', targetId: interaction.guild.id, actorId: interaction.user.id,
      reason: `Updated ${setting}`, previousValue: previous ?? 'not configured', newValue: channel.id,
    });
    return interaction.reply({ content: `Updated **${setting}** to <#${channel.id}>. The change is saved in SQLite.`, ephemeral: true });
  }

  const group = interaction.options.getString('group', true);
  const action = interaction.options.getString('action', true);
  const role = interaction.options.getRole('role', true);
  const settingKey = `role_${group}`;
  const configKey = { staff: 'STAFF_ROLE_IDS', management: 'MANAGEMENT_ROLE_IDS', owners: 'OWNER_ROLE_IDS' }[group];
  const current = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey);
  const roleIds = current ? JSON.parse(current.value) : [...ctx.config[configKey]];
  const updated = action === 'add'
    ? [...new Set([...roleIds, role.id])]
    : roleIds.filter((roleId) => roleId !== role.id);
  if (group === 'owners' && action === 'remove'
    && !updated.some((roleId) => /^\d{17,20}$/.test(roleId))) {
    return interaction.reply({ content: 'At least one configured Owner or Co-Owner role must remain.', ephemeral: true });
  }
  setConfigValue(ctx.db, settingKey, updated);
  logAudit(ctx.db, {
    action: 'permission_change', targetId: interaction.guild.id, actorId: interaction.user.id,
    reason: `${action === 'add' ? 'Added' : 'Removed'} ${role.name} ${group} role`,
    previousValue: roleIds.join(',') || 'none', newValue: updated.join(',') || 'none',
    details: { group, roleId: role.id },
  });
  return interaction.reply({ content: `${action === 'add' ? 'Added' : 'Removed'} <@&${role.id}> ${action === 'add' ? 'to' : 'from'} the **${group}** role group.`, ephemeral: true });
}

async function handleStaffCommand(interaction, ctx) {
  switch (interaction.commandName) {
    case 'staffwarn': return staffWarning(interaction, ctx);
    case 'staffnotes': return staffNotes(interaction, ctx);
    case 'staffhistory': return staffHistory(interaction, ctx);
    case 'staffannounce': return staffAnnouncement(interaction, ctx);
    case 'staffconfig': return staffConfig(interaction, ctx);
    default: return null;
  }
}

module.exports = { ensureManagement, handleStaffCommand };