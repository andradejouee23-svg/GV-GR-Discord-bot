const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const {
  awardStaffOfWeek,
  checkInStaff,
  checkOutStaff,
  currentStatus,
  getOverdueShifts,
  getPendingDailyReportReminders,
  getStaffStats,
  getWeekStart,
  getWeeklyGoalReminderCandidates,
  recordDailyReportReminder,
  recordReminderAttempt,
  recordWeeklyGoalReminder,
  submitDailyReport,
} = require('../services/staffRewards');
const { formatDuration } = require('../utils/format');
const {
  fetchGuildMember,
  getConfigValue,
  getInteractionMember,
  getStaffRoleName,
  hasRoleGroup,
  logStaffAction,
  makeEmbed,
  sendToChannel,
  unixTime,
} = require('../utils/discord');
const {
  createCheckoutReply,
  createDailyReportComponents,
  createManagerReportsEmbed,
  createPermanentLeaderboardEmbed,
  createReportsEmbed,
  createStaffCenterComponents,
  createStaffStatsEmbed,
  createStreakEmbed,
  createWeeklyGoalEmbed,
} = require('../utils/staffCenter');

function isOwner(member, guild, db) {
  return member?.id === guild.ownerId || hasRoleGroup(member, db, 'owners');
}

function isManagement(member, guild, db) {
  if (isOwner(member, guild, db)) return true;
  return hasRoleGroup(member, db, 'management')
    && currentStatus(db, member.id).status === 'active';
}

function isStaff(member, guild, db) {
  if (isOwner(member, guild, db)) return true;
  const status = currentStatus(db, member.id).status;
  return !['suspended', 'demoted', 'removed'].includes(status)
    && (hasRoleGroup(member, db, 'staff') || hasRoleGroup(member, db, 'management'));
}

async function replyEphemeral(interaction, payload, autoDeleteMs = 0) {
  let response;
  if (interaction.deferred) response = await interaction.editReply(payload);
  else if (interaction.replied) response = await interaction.followUp({ ...payload, ephemeral: true });
  else response = await interaction.reply({ ...payload, ephemeral: true });

  if (autoDeleteMs > 0) {
    const deletionTimer = setTimeout(() => interaction.deleteReply().catch(() => {}), autoDeleteMs);
    deletionTimer.unref();
  }
  return response;
}

function createReminderComponents(shift) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:shiftrem:${shift.id}:still`).setLabel('Still Working').setEmoji('🟢').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gv:shiftrem:${shift.id}:end`).setLabel('End My Shift').setEmoji('🔴').setStyle(ButtonStyle.Danger),
  )];
}

function createDailyReportReminderComponents(shift) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`gv:daily:remind:${shift.id}`)
      .setLabel('Complete Daily Report')
      .setEmoji('📝')
      .setStyle(ButtonStyle.Primary),
  )];
}

function createDailyReportModal(shiftId, rating) {
  return new ModalBuilder()
    .setCustomId(`gv:daily:submit:${shiftId}:${rating}`)
    .setTitle('Daily RP Report')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('explanation')
      .setLabel('Briefly explain how RP went today')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1000)
      .setRequired(false)));
}

async function handleStaffCenterCommand(interaction, ctx) {
  if (!['staff-center', 'management-dashboard', 'owner-dashboard'].includes(interaction.commandName)) return null;
  const member = await getInteractionMember(interaction);
  if (interaction.commandName === 'staff-center') {
    if (!member || !isStaff(member, interaction.guild, ctx.db)) {
      return interaction.reply({ content: 'The Staff Center is available to configured staff only.', ephemeral: true });
    }
    const status = currentStatus(ctx.db, interaction.user.id);
    const embed = createStaffStatsEmbed(ctx.db, interaction.user.id, interaction.user.username)
      .setFooter({ text: `Staff status: ${status.status}` });
    return interaction.reply({ embeds: [embed], components: createStaffCenterComponents(), ephemeral: true });
  }

  if (interaction.commandName === 'management-dashboard') {
    if (!member || !isManagement(member, interaction.guild, ctx.db)) {
      return interaction.reply({ content: 'This dashboard is only available to configured management roles.', ephemeral: true });
    }
    return require('./staffManagement').openManagementDashboard(interaction, ctx);
  }

  if (interaction.commandName === 'owner-dashboard') {
    if (!member || !isOwner(member, interaction.guild, ctx.db)) {
      return interaction.reply({ content: 'The Owner Dashboard is restricted to the server owner and configured Owner roles.', ephemeral: true });
    }
    return require('./staffManagement').openOwnerDashboard(interaction, ctx);
  }
  return null;
}

async function handleStaffCenterButton(interaction, ctx) {
  const id = interaction.customId;
  if (!id.startsWith('gv:center:')) return null;
  await interaction.deferReply({ ephemeral: true });
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) {
    return replyEphemeral(interaction, { content: 'This Staff Center control is available to configured staff only.' });
  }

  if (id === 'gv:center:checkin') {
    const roleName = getStaffRoleName(member, ctx.db) ?? (isOwner(member, interaction.guild, ctx.db) ? 'Owner' : 'Staff');
    const result = checkInStaff(ctx.db, {
      id: interaction.user.id,
      username: interaction.user.username,
      roleName,
    });
    if (result.alreadyOnDuty) {
      return replyEphemeral(interaction, { content: `You are already checked in. Your shift started ${unixTime(result.shift.started_at, 'R')}.` });
    }
    if (result.unavailable) {
      return replyEphemeral(interaction, { content: `Check-in is unavailable while your status is **${result.status}**${result.statusUntil ? ` until ${unixTime(result.statusUntil)}` : ''}.` });
    }
    await logStaffAction(interaction.client, ctx.db, {
      embeds: [makeEmbed(config.EMBED_COLORS.active, '🟢 Staff Checked In', `<@${interaction.user.id}> • ${roleName}\nStarted: ${unixTime(result.shift.started_at)}`)],
    });
    return replyEphemeral(interaction, { embeds: [makeEmbed(config.EMBED_COLORS.active, '🟢 Checked In', `Your GV GR shift started ${unixTime(result.shift.started_at)}.`)] }, 60000);
  }

  if (id === 'gv:center:checkout') {
    const shift = checkOutStaff(ctx.db, interaction.user.id);
    if (!shift) return replyEphemeral(interaction, { content: 'You are not currently checked in.' });
    await logStaffAction(interaction.client, ctx.db, {
      embeds: [makeEmbed(config.EMBED_COLORS.error, '🔴 Staff Checked Out', `<@${interaction.user.id}> • ${shift.role_name}\nShift: **${formatDuration(shift.duration_seconds)}**\nHourly Points: **+${shift.hourly_points}**\nEnded: ${unixTime(shift.ended_at)}`)],
    });
    return replyEphemeral(interaction, createCheckoutReply(ctx.db, shift), 60000);
  }

  if (id === 'gv:center:stats') {
    return replyEphemeral(interaction, { embeds: [createStaffStatsEmbed(ctx.db, interaction.user.id, interaction.user.username)] });
  }
  if (id === 'gv:center:leaderboard') {
    return replyEphemeral(interaction, { embeds: [createPermanentLeaderboardEmbed(ctx.db)] });
  }
  if (id === 'gv:center:weekly') {
    return replyEphemeral(interaction, { embeds: [createWeeklyGoalEmbed(ctx.db, interaction.user.id)] });
  }
  if (id === 'gv:center:streak') {
    return replyEphemeral(interaction, { embeds: [createStreakEmbed(ctx.db, interaction.user.id, interaction.user.username)] });
  }
  if (id.startsWith('gv:center:reports:')) {
    const page = Number(id.split(':').at(-1));
    if (!Number.isSafeInteger(page)) return replyEphemeral(interaction, { content: 'Invalid report page.' });
    const result = createReportsEmbed(ctx.db, interaction.user.id, page);
    return replyEphemeral(interaction, { embeds: [result.embed], components: result.components });
  }

  return replyEphemeral(interaction, { content: 'That Staff Center control is not recognized.' });
}

async function handleDailyReportSelect(interaction, ctx) {
  const shiftId = Number(interaction.customId.split(':').at(-1));
  if (!Number.isSafeInteger(shiftId) || shiftId < 1) {
    return interaction.reply({ content: 'This report form is invalid.', ephemeral: true });
  }
  const shift = ctx.db.prepare('SELECT * FROM shifts WHERE id = ? AND user_id = ? AND status = \'completed\'').get(shiftId, interaction.user.id);
  if (!shift) return interaction.reply({ content: 'This checkout is not linked to one of your completed shifts.', ephemeral: true });
  const alreadySubmitted = ctx.db.prepare('SELECT id FROM daily_rp_reports WHERE user_id = ? AND report_date = ?').get(interaction.user.id, shift.ended_at.slice(0, 10));
  if (alreadySubmitted) return interaction.reply({ content: 'A daily RP report has already been submitted for this date. The report bonus cannot be earned twice.', ephemeral: true });
  return interaction.showModal(createDailyReportModal(shiftId, interaction.values[0]));
}

async function handleDailyReportReminder(interaction, ctx) {
  const shiftId = Number(interaction.customId.split(':').at(-1));
  if (!Number.isSafeInteger(shiftId) || shiftId < 1) {
    return interaction.reply({ content: 'This daily report reminder is invalid.', ephemeral: true });
  }
  const shift = ctx.db.prepare("SELECT * FROM shifts WHERE id = ? AND user_id = ? AND status = 'completed'")
    .get(shiftId, interaction.user.id);
  if (!shift) return interaction.reply({ content: 'This reminder is not linked to one of your completed shifts.', ephemeral: true });
  const existing = ctx.db.prepare('SELECT id FROM daily_rp_reports WHERE user_id = ? AND report_date = ?')
    .get(interaction.user.id, shift.ended_at.slice(0, 10));
  if (existing) return interaction.reply({ content: 'Your report for this date is already saved. No additional points are awarded.', ephemeral: true });
  return interaction.reply({
    content: 'Choose your RP rating. Your report is private; checkout and shift points are already saved.',
    components: createDailyReportComponents(shiftId),
    ephemeral: true,
  });
}

async function handleDailyReportModal(interaction, ctx) {
  await interaction.deferReply({ ephemeral: true });
  const [, , rawShiftId, rating] = interaction.customId.split(':');
  const shiftId = Number(rawShiftId);
  if (!Number.isSafeInteger(shiftId) || shiftId < 1) {
    return replyEphemeral(interaction, { content: 'This daily report is invalid.' });
  }
  const result = submitDailyReport(ctx.db, {
    userId: interaction.user.id,
    shiftId,
    rating,
    explanation: interaction.fields.getTextInputValue('explanation').trim(),
  });
  if (!result.saved) {
    return replyEphemeral(interaction, { content: result.reason === 'already_reported'
      ? 'You already submitted a report for this date; no extra bonus was added.'
      : 'This report must belong to one of your completed shifts.' });
  }
  for (const reminder of result.reminders ?? []) {
    if (!reminder.channel_id || !reminder.message_id) continue;
    try {
      const channel = await interaction.client.channels.fetch(reminder.channel_id);
      const message = channel?.isTextBased() ? await channel.messages.fetch(reminder.message_id) : null;
      await message?.delete();
    } catch (error) {
      console.error(`Could not remove completed daily-report reminder ${reminder.message_id}:`, error.message);
    }
  }
  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.info, '📝 Daily RP Report Submitted', `Staff: <@${interaction.user.id}>\nDate: **${result.reportDate}**\nRating: **${rating.toUpperCase()}**\nReport: #${result.reportId}`)],
  });
  return replyEphemeral(interaction, {
    embeds: [makeEmbed(config.EMBED_COLORS.active, '📝 Daily Report Saved', `Your RP report was saved.\n🎁 Checkout Bonus: **+1 Staff Point**\n⭐ Total Points: **${result.totalPoints}**`)],
  });
}

async function handleShiftReminder(interaction, ctx) {
  const [, , rawShiftId, action] = interaction.customId.split(':');
  const shiftId = Number(rawShiftId);
  if (!Number.isSafeInteger(shiftId) || shiftId < 1 || !['still', 'end'].includes(action)) {
    return interaction.reply({ content: 'This shift reminder is invalid.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const shift = ctx.db.prepare("SELECT * FROM shifts WHERE id = ? AND status = 'active'").get(shiftId);
  if (!shift || shift.user_id !== interaction.user.id) {
    return replyEphemeral(interaction, { content: 'This reminder belongs to someone else or the shift has already ended.' });
  }
  if (interaction.message) {
    await interaction.message.edit({ components: [] }).catch(() => {});
  }
  if (action === 'still') {
    recordReminderAttempt(ctx.db, shiftId, 'acknowledged');
    return replyEphemeral(interaction, { content: 'You are still checked in. Your shift continues, and you will be reminded again later if it remains active.' });
  }

  const completed = checkOutStaff(ctx.db, interaction.user.id);
  if (!completed) return replyEphemeral(interaction, { content: 'This shift was already closed.' });
  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.error, '🔴 Staff Checked Out From Reminder', `<@${interaction.user.id}>\nShift: **${formatDuration(completed.duration_seconds)}**\nHourly Points: **+${completed.hourly_points}**`)],
  });
  return replyEphemeral(interaction, createCheckoutReply(ctx.db, completed));
}

async function processShiftReminders(client, db) {
  const channelId = getConfigValue(db, 'STAFF_ACTIVITY_CHANNEL_ID');
  if (!channelId) return;
  for (const shift of getOverdueShifts(db)) {
    const elapsed = Math.floor((Date.now() - Date.parse(shift.started_at)) / 1000);
    let messageId = null;
    let deliveryStatus = 'failed';
    try {
      const channel = await client.channels.fetch(channelId);
      if (channel?.isTextBased() && channel.send) {
        const message = await channel.send({
          embeds: [makeEmbed(config.EMBED_COLORS.warning, '⏰ STAFF SHIFT REMINDER', `<@${shift.user_id}>, you have been checked in for **${formatDuration(elapsed)}**. Are you still on duty?`)],
          components: createReminderComponents(shift),
          allowedMentions: { users: [shift.user_id] },
        });
        messageId = message.id;
        deliveryStatus = 'sent';
      }
    } catch (error) {
      console.error(`Could not send shift reminder for shift ${shift.id}:`, error.message);
    }
    recordReminderAttempt(db, shift.id, deliveryStatus, messageId);
  }
}

async function processDailyReportReminders(client, db, now = new Date()) {
  const channelId = getConfigValue(db, 'STAFF_ACTIVITY_CHANNEL_ID');
  for (const shift of getPendingDailyReportReminders(db, now)) {
    let messageId = null;
    let deliveryStatus = 'failed';
    try {
      const channel = channelId && await client.channels.fetch(channelId);
      if (channel?.isTextBased() && channel.send) {
        const message = await channel.send({
          embeds: [makeEmbed(config.EMBED_COLORS.warning, '📝 DAILY RP REPORT REMINDER',
            `<@${shift.user_id}>, your checkout is saved. Complete the short RP report to receive the daily-report bonus.`)],
          components: createDailyReportReminderComponents(shift),
          allowedMentions: { users: [shift.user_id] },
        });
        messageId = message.id;
        deliveryStatus = 'sent';
      }
    } catch (error) {
      console.error(`Could not send daily-report reminder for shift ${shift.id}:`, error.message);
    }
    recordDailyReportReminder(db, shift.id, { status: deliveryStatus, channelId, messageId, now: now.toISOString() });
  }
}

async function processWeeklyGoalReminders(client, db, now = new Date()) {
  const channelId = getConfigValue(db, 'STAFF_ACTIVITY_CHANNEL_ID');
  const weekStart = getWeekStart(now);
  for (const member of getWeeklyGoalReminderCandidates(db, now)) {
    const stats = getStaffStats(db, member.user_id, now);
    let messageId = null;
    let deliveryStatus = 'failed';
    try {
      const channel = channelId && await client.channels.fetch(channelId);
      if (channel?.isTextBased() && channel.send) {
        const message = await channel.send({
          embeds: [makeEmbed(config.EMBED_COLORS.info, '🎯 WEEKLY STAFF GOAL REMINDER',
            `<@${member.user_id}>, you have **${(stats.weeklySeconds / 3600).toFixed(1)} / ${stats.weeklyGoalHours} hours** this week. Your goal progress is still available in the Staff Center.`)],
          allowedMentions: { users: [member.user_id] },
        });
        messageId = message.id;
        deliveryStatus = 'sent';
      }
    } catch (error) {
      console.error(`Could not send weekly-goal reminder for ${member.user_id}:`, error.message);
    }
    recordWeeklyGoalReminder(db, member.user_id, weekStart, { status: deliveryStatus, messageId, now: now.toISOString() });
  }
}

async function processStaffOfWeek(client, db) {
  const now = new Date();
  const result = awardStaffOfWeek(db, now);
  if (!result?.winner) return result;
  let username = 'Staff member';
  try {
    username = (await client.users.fetch(result.winner.user_id)).username;
  } catch {
    // The stored mention remains available even if the user cannot be fetched.
  }
  const channelId = getConfigValue(db, 'STAFF_ANNOUNCEMENT_CHANNEL_ID');
  const embed = makeEmbed(config.EMBED_COLORS.management, '🏆 GV GR STAFF OF THE WEEK',
    `Congratulations <@${result.winner.user_id}>!\n\nHours: **${formatDuration(result.winner.hours_seconds)}**\nStaff Points earned: **${result.winner.points}**\nDaily RP reports: **${result.winner.reports}**\nAwarded: **+${config.STAFF_OF_WEEK_BONUS_POINTS} Staff Points**\nWeek of: **${result.weekStart}**`)
    .setFooter({ text: `Well done, ${username}!` });
  try {
    const channel = channelId && await client.channels.fetch(channelId);
    if (channel?.isTextBased() && channel.send) {
      const message = await channel.send({ embeds: [embed], allowedMentions: { users: [result.winner.user_id] } });
      db.prepare('UPDATE staff_weekly_awards SET announcement_message_id = ? WHERE week_start = ?').run(message.id, result.weekStart);
    }
  } catch (error) {
    console.error('Could not announce Staff of the Week:', error.message);
  }
  return result;
}

async function handleManagementDashboardButton(interaction, ctx) {
  if (interaction.customId !== 'mgmt:reports') return null;
  const member = await getInteractionMember(interaction);
  if (!member || !isManagement(member, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'Management access is required.', ephemeral: true });
  }
  return interaction.reply({ embeds: [createManagerReportsEmbed(ctx.db)], ephemeral: true });
}

module.exports = {
  createDailyReportModal,
  createDailyReportReminderComponents,
  createReminderComponents,
  handleDailyReportModal,
  handleDailyReportReminder,
  handleDailyReportSelect,
  handleManagementDashboardButton,
  handleShiftReminder,
  handleStaffCenterButton,
  handleStaffCenterCommand,
  isManagement,
  isOwner,
  isStaff,
  processShiftReminders,
  processDailyReportReminders,
  processWeeklyGoalReminders,
  processStaffOfWeek,
};