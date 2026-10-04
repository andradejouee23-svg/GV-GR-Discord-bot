const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const {
  fetchGuildMember,
  getConfigValue,
  hasRoleGroup,
  logStaffAction,
  makeEmbed,
  sendToChannel,
  unixTime,
} = require('../utils/discord');
const { ensureManagement } = require('./staff');

function reportModal() {
  return new ModalBuilder().setCustomId('gv:report_submit').setTitle('Submit a Player Report').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('player').setLabel('Player being reported').setStyle(TextInputStyle.Short)
      .setMaxLength(100).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('reason').setLabel('Reason for the report').setStyle(TextInputStyle.Short)
      .setMaxLength(200).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('description').setLabel('What happened?').setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1500).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('evidence').setLabel('Evidence link (optional)').setStyle(TextInputStyle.Short)
      .setMaxLength(500).setRequired(false)),
  );
}

function reportButtons(reportId, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:report:${reportId}:reviewing`).setLabel('Reviewing').setEmoji('🟡').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gv:report:${reportId}:resolved`).setLabel('Resolved').setEmoji('🟢').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gv:report:${reportId}:rejected`).setLabel('Rejected').setEmoji('🔴').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

async function handleReportCommand(interaction) {
  return interaction.showModal(reportModal());
}

async function submitReport(interaction, ctx) {
  const player = interaction.fields.getTextInputValue('player').trim();
  const reason = interaction.fields.getTextInputValue('reason').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  const evidence = interaction.fields.getTextInputValue('evidence').trim();
  const now = new Date().toISOString();
  const result = ctx.db.prepare(`
    INSERT INTO reports (reporter_id, reporter_name, reported_player, reason, description, evidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(interaction.user.id, interaction.user.username, player, reason, description, evidence, now, now);
  const reportId = Number(result.lastInsertRowid);
  const embed = makeEmbed(config.EMBED_COLORS.warning, `🚨 Player Report #${reportId}`,
    `**Reported player:** ${player}\n**Reason:** ${reason}\n**Description:** ${description}\n**Evidence:** ${evidence || 'Not provided'}\n**Submitted by:** <@${interaction.user.id}>\n**Submitted:** ${unixTime(now)}\n**Status:** 🟡 Pending`);
  const channelId = getConfigValue(ctx.db, 'REPORT_CHANNEL_ID');
  let sentMessage;
  try {
    const channel = channelId && await interaction.client.channels.fetch(channelId);
    if (channel?.isTextBased() && channel.send) {
      sentMessage = await channel.send({ embeds: [embed], components: reportButtons(reportId) });
    }
  } catch (error) {
    console.error('Could not deliver a player report:', error.message);
  }
  if (sentMessage) {
    ctx.db.prepare('UPDATE reports SET channel_id = ?, message_id = ? WHERE id = ?').run(sentMessage.channelId, sentMessage.id, reportId);
  }
  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.warning, '🚨 Player Report Submitted', `Report #${reportId} • **${player}**\nSubmitted by: <@${interaction.user.id}>\nReason: ${reason}`)],
  });
  return interaction.reply({ content: sentMessage
    ? `Your report (#${reportId}) was sent privately to staff.`
    : `Your report (#${reportId}) was saved, but I could not deliver it. Staff should check REPORT_CHANNEL_ID and bot channel permissions.`, ephemeral: true });
}

async function updateReport(interaction, ctx) {
  const [, , rawId, status] = interaction.customId.split(':');
  const manager = await fetchGuildMember(interaction.guild, interaction.user.id);
  if (!manager || !hasRoleGroup(manager, ctx.db, 'management')) {
    return interaction.reply({ content: 'Only configured management roles can update report status.', ephemeral: true });
  }
  const reportId = Number(rawId);
  const report = ctx.db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
  if (!report) return interaction.reply({ content: 'This report record could not be found.', ephemeral: true });
  if (['resolved', 'rejected'].includes(report.status)) {
    return interaction.reply({ content: `This report is already ${report.status}.`, ephemeral: true });
  }

  const now = new Date().toISOString();
  ctx.db.prepare('UPDATE reports SET status = ?, reviewer_id = ?, updated_at = ? WHERE id = ?').run(status, interaction.user.id, now, reportId);
  const statusLabels = { reviewing: '🟡 Reviewing', resolved: '🟢 Resolved', rejected: '🔴 Rejected' };
  const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
    .setColor(status === 'resolved' ? config.EMBED_COLORS.active : status === 'rejected' ? config.EMBED_COLORS.error : config.EMBED_COLORS.warning)
    .setFooter({ text: `${statusLabels[status]} by ${interaction.user.username} • ${new Date(now).toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' })}` });
  await interaction.update({ embeds: [updatedEmbed], components: [reportButtons(reportId, status !== 'reviewing')[0]] });
  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.management, '🚨 Report Status Updated', `Report #${reportId} • ${statusLabels[status]}\nUpdated by: <@${interaction.user.id}>`)],
  });
}

function logModeration(db, action, staff, target, reason) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO moderation_logs (action, staff_id, staff_name, target_id, target_name, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(action, staff.id, staff.username, target.id, target.username, reason, now);
  return now;
}

async function moderationCommand(interaction, ctx) {
  const manager = await ensureManagement(interaction, ctx.db);
  if (!manager) return;

  const action = interaction.options.getSubcommand();
  const target = interaction.options.getUser('member', true);
  const reason = interaction.options.getString('reason', true);
  if (target.id === interaction.user.id || target.id === interaction.client.user.id) {
    return interaction.reply({ content: 'You cannot moderate yourself or this bot.', ephemeral: true });
  }

  let targetMember;
  let requiredPermission;
  if (action !== 'warn') {
    targetMember = await fetchGuildMember(interaction.guild, target.id);
    if (!targetMember) return interaction.reply({ content: 'That player is not currently in this server.', ephemeral: true });
    requiredPermission = {
      kick: PermissionFlagsBits.KickMembers,
      ban: PermissionFlagsBits.BanMembers,
      timeout: PermissionFlagsBits.ModerateMembers,
    }[action];
    const botMember = interaction.guild.members.me;
    if (!botMember?.permissions.has(requiredPermission)) {
      return interaction.reply({ content: `I need the ${action === 'timeout' ? 'Moderate Members' : `${action === 'kick' ? 'Kick' : 'Ban'} Members`} permission to do that.`, ephemeral: true });
    }
  }

  try {
    if (action === 'kick') await targetMember.kick(reason);
    if (action === 'ban') await interaction.guild.members.ban(target.id, { reason });
    if (action === 'timeout') {
      const minutes = interaction.options.getInteger('minutes', true);
      await targetMember.timeout(minutes * 60 * 1000, reason);
    }
  } catch (error) {
    console.error(`Could not ${action} ${target.id}:`, error.message);
    return interaction.reply({ content: `Discord did not allow that ${action}. Check the bot's role position, permissions, and the target's role hierarchy.`, ephemeral: true });
  }

  const now = logModeration(ctx.db, action, interaction.user, target, reason);
  const actionLabel = action === 'warn' ? 'Warn' : action[0].toUpperCase() + action.slice(1);
  const embed = makeEmbed(config.EMBED_COLORS.management, `🛡️ Player ${actionLabel}`,
    `**Staff:** <@${interaction.user.id}>\n**Target:** <@${target.id}>\n**Reason:** ${reason}\n**Date:** ${unixTime(now)}`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [embed] });
  return interaction.reply({ content: `${actionLabel} recorded for <@${target.id}>.`, ephemeral: true });
}

async function handleSafetyCommand(interaction, ctx) {
  if (interaction.commandName === 'report') return handleReportCommand(interaction);
  if (interaction.commandName === 'mod') return moderationCommand(interaction, ctx);
  return null;
}

module.exports = {
  handleReportCommand,
  handleSafetyCommand,
  reportButtons,
  submitReport,
  updateReport,
};