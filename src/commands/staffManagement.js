const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
const { DateTime } = require('luxon');
const config = require('../../config');
const {
  addStaffNote,
  addStaffWarning,
  adjustStaffPoints,
  applyStaffStatus,
  closeShiftByManagement,
  correctCompletedShift,
  getAuditLogs,
  getManagementRoster,
  getPointsLeaderboard,
  getPunishments,
  getRecentReports,
  getRecentShiftActivity,
  getStaffStats,
  getWeekStart,
  logAudit,
  managementClockInStaff,
  resetStaffStreak,
} = require('../services/staffRewards');
const { formatDuration } = require('../utils/format');
const {
  fetchGuildMember,
  getConfigValue,
  getInteractionMember,
  getStaffRoleName,
  hasRoleGroup,
  makeEmbed,
  setConfigValue,
  unixTime,
} = require('../utils/discord');
const { isManagement, isOwner } = require('./staffCenter');
const { refreshStaffPanel } = require('./clock');

const pendingDuration = 5 * 60 * 1000;
const actionLabels = {
  add_points: 'Add Staff Points',
  remove_points: 'Remove Staff Points',
  warning: 'Staff Warning',
  break_1d: 'Take a 1-day Admin Break',
  break_3d: 'Take a 3-day Admin Break',
  break_7d: 'Take a 7-day Admin Break',
  suspend_7d: 'Suspend Staff for 7 days',
  demote: 'Demote Staff',
  remove: 'Remove From Staff',
  note: 'Add Private Note',
  reset_streak: 'Reset Staff Streak',
  close_shift: 'Clock Out Manually',
  manual_clock_in: 'Clock In Manually',
  correct_shift: 'Correct Most Recent Shift',
};

function memberIsManager(member, guild, db) {
  return isManagement(member, guild, db);
}

function memberIsOwner(member, guild, db) {
  return isOwner(member, guild, db);
}

function managementComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('mgmt:overview').setLabel('Overview').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mgmt:reports').setLabel('Daily Reports').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt:activity').setLabel('Recent Activity').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('mgmt:leaderboard').setLabel('Weekly Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId('mgmt:staff_history').setPlaceholder('View a staff member’s history'),
    ),
  ];
}

function ownerComponents(db) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('owner:overview').setLabel('Overview').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('owner:reports').setLabel('All Daily Reports').setEmoji('📝').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('owner:audit').setLabel('Audit Log').setEmoji('📚').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('owner:activity').setLabel('Recent Activity').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('owner:cleanup').setLabel('Message Cleanup').setEmoji('🧹').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId('owner:select_staff').setPlaceholder('Select a staff member for owner actions'),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('owner:settings').setLabel('Server Settings').setEmoji('⚙️').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('owner:automod:core').setLabel('AutoMod Thresholds').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('owner:automod:filters').setLabel('AutoMod Filters').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('owner:automod:exemptions').setLabel('AutoMod Exemptions').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('owner:automod:escalation').setLabel('AutoMod Escalation').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const ownerChannelSettings = {
  STAFF_ACTIVITY_CHANNEL_ID: 'Staff activity and panel',
  STAFF_ANNOUNCEMENT_CHANNEL_ID: 'Staff announcements',
  STAFF_LOG_CHANNEL_ID: 'Staff audit/activity logs',
  REPORT_CHANNEL_ID: 'Private player reports',
  SESSION_CHANNEL_ID: 'RP session announcements',
  EVENT_CHANNEL_ID: 'Event announcements',
  TICKET_TRANSCRIPT_CHANNEL_ID: 'Private ticket transcripts',
};

const ownerTicketCategories = {
  TICKET_SUPPORT_CATEGORY_ID: 'General support tickets category',
  TICKET_APPLICATION_CATEGORY_ID: 'Staff applications category',
  TICKET_RECRUITING_CATEGORY_ID: 'Admin testing and recruiting category',
};

const ownerRoleGroups = {
  staff: 'Staff roles',
  management: 'Management roles',
  owners: 'Owner roles',
  admin_recruiting: 'Admin testing/recruiting access role',
};

function configuredRoleGroup(db, group) {
  const saved = getConfigValue(db, `role_${group}`);
  if (Array.isArray(saved)) return saved;
  if (group === 'admin_recruiting') {
    const roleId = getConfigValue(db, 'ADMIN_RECRUITING_ROLE_ID');
    return /^\d{17,20}$/.test(roleId ?? '') ? [roleId] : [];
  }
  const key = { staff: 'STAFF_ROLE_IDS', management: 'MANAGEMENT_ROLE_IDS', owners: 'OWNER_ROLE_IDS' }[group];
  return getConfigValue(db, key) ?? [];
}

const ownerSessionSettings = {
  SESSION_JOIN_CODE: { label: 'Greenville custom-server join code', maxLength: 80 },
  SESSION_JOIN_URL: { label: 'Optional Greenville join link', maxLength: 500 },
  SESSION_DEFAULT_IMAGE_URL: { label: 'Default session banner URL', maxLength: 500 },
};

function ownerSettingsEmbed(db) {
  const channelLines = Object.entries(ownerChannelSettings).map(([key, label]) => {
    const channelId = getConfigValue(db, key);
    return `**${label}:** ${/^\d{17,20}$/.test(channelId ?? '') ? `<#${channelId}>` : 'Not configured'}`;
  });
  const roleLines = Object.entries(ownerRoleGroups).map(([group, label]) => {
    const roleIds = configuredRoleGroup(db, group);
    return `**${label}:** ${roleIds.length ? roleIds.map((roleId) => `<@&${roleId}>`).join(', ') : 'None configured'}`;
  });
  const categoryLines = Object.entries(ownerTicketCategories).map(([key, label]) => {
    const categoryId = getConfigValue(db, key);
    return `**${label}:** ${/^\d{17,20}$/.test(categoryId ?? '') ? `<#${categoryId}>` : 'Not configured'}`;
  });
  const zone = getConfigValue(db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC';
  const joinCodeStatus = getConfigValue(db, 'SESSION_JOIN_CODE') ? 'Configured' : 'Not configured';
  const automodStatus = getConfigValue(db, 'AUTOMOD_ENABLED') ? 'Enabled' : 'Disabled';
  const automodMode = getConfigValue(db, 'AUTOMOD_MODE') ?? config.AUTOMOD_MODE;
  return makeEmbed(config.EMBED_COLORS.management, '⚙️ GV GR SERVER SETTINGS',
    `**Timezone:** \`${zone}\`\n**Session join code:** ${joinCodeStatus}\n**AutoMod:** ${automodStatus} (${automodMode} mode)\n\n${channelLines.join('\n')}\n\n${categoryLines.join('\n')}\n\n${roleLines.join('\n')}\n\n**Message deletion logs:** Disabled`)
    .setFooter({ text: 'Changes are saved to SQLite and audited.' });
}

function ownerSettingsComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('owner:settings:channel')
        .setPlaceholder('Choose a channel setting to update')
        .addOptions(Object.entries(ownerChannelSettings).map(([value, label]) => ({ label, value }))),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('owner:settings:roles')
        .setPlaceholder('Choose a role group to update')
        .addOptions(Object.entries(ownerRoleGroups).map(([value, label]) => ({ label, value }))),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('owner:settings:categories')
        .setPlaceholder('Configure private ticket categories')
        .addOptions(Object.entries(ownerTicketCategories).map(([value, label]) => ({ label, value }))),
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('owner:settings:session')
        .setPlaceholder('Configure session join details')
        .addOptions(Object.entries(ownerSessionSettings).map(([value, setting]) => ({ label: setting.label, value }))),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('owner:settings:timezone').setLabel('Set Timezone').setEmoji('🕒').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('owner:overview').setLabel('Back to Owner Dashboard').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function createOwnerTimezoneModal(currentTimezone) {
  return new ModalBuilder().setCustomId('owner:settings:timezone_modal').setTitle('Set Server Timezone')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('timezone').setLabel('IANA timezone (example: America/Chicago)')
      .setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true)
      .setValue(currentTimezone)));
}

function createOwnerSessionSettingModal(setting, currentValue = '') {
  const definition = ownerSessionSettings[setting];
  return new ModalBuilder().setCustomId(`owner:settings:session_modal:${setting}`).setTitle(definition.label.slice(0, 45))
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('value').setLabel(definition.label).setStyle(TextInputStyle.Short)
      .setMaxLength(definition.maxLength).setRequired(false).setValue(currentValue.slice(0, definition.maxLength))));
}

function createAutomodModal(stage, db) {
  const field = (id, label, key, max = 4) => new ActionRowBuilder().addComponents(new TextInputBuilder()
    .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(true)
    .setValue(String(getConfigValue(db, key) ?? config[key])));
  const title = { core: 'AutoMod Thresholds', filters: 'AutoMod Filters', exemptions: 'AutoMod Exemptions', escalation: 'AutoMod Escalation' }[stage];
  const modal = new ModalBuilder().setCustomId(`owner:automod:${stage}_modal`).setTitle(title);
  if (stage === 'core') {
    return modal.addComponents(
      field('enabled', 'Enabled (true/false)', 'AUTOMOD_ENABLED'),
      field('mode', 'Mode: log, delete, or timeout', 'AUTOMOD_MODE', 10),
      field('spam_threshold', 'Messages per spam window (3-100)', 'AUTOMOD_SPAM_THRESHOLD'),
      field('spam_window', 'Spam window seconds (3-300)', 'AUTOMOD_SPAM_WINDOW_SECONDS'),
      field('repeat_threshold', 'Repeated message threshold (2-20)', 'AUTOMOD_REPEAT_THRESHOLD'),
    );
  }
  if (stage === 'filters') {
    return modal.addComponents(
      field('mention_limit', 'Mention limit (2-100)', 'AUTOMOD_MENTION_LIMIT'),
      field('filter_links', 'Filter non-allowlisted links (true/false)', 'AUTOMOD_FILTER_LINKS'),
      field('filter_invites', 'Filter Discord invites (true/false)', 'AUTOMOD_FILTER_INVITES'),
      field('raid_threshold', 'Join alert threshold (3-500)', 'AUTOMOD_RAID_THRESHOLD'),
      field('raid_window', 'Join alert window seconds (5-600)', 'AUTOMOD_RAID_WINDOW_SECONDS'),
    );
  }
  if (stage === 'exemptions') {
    return modal.addComponents(
      field('role_ids', 'Exempt role IDs, comma-separated', 'AUTOMOD_EXEMPT_ROLE_IDS', 1000),
      field('channel_ids', 'Exempt channel IDs, comma-separated', 'AUTOMOD_EXEMPT_CHANNEL_IDS', 1000),
      field('domains', 'Trusted domains, comma-separated', 'AUTOMOD_ALLOWLISTED_DOMAINS', 1000),
    );
  }
  return modal.addComponents(
    field('timeout_minutes', 'Timeout minutes (1-60)', 'AUTOMOD_TIMEOUT_MINUTES'),
    field('timeout_after', 'Incidents before timeout (1-20)', 'AUTOMOD_TIMEOUT_AFTER_INCIDENTS'),
  );
}

function rosterEmbed(db, owner = false) {
  const roster = getManagementRoster(db);
  const active = roster.filter((row) => row.active_started_at);
  const body = roster.slice(0, 18).map((row) => {
    const shift = row.active_started_at
      ? `On duty since ${unixTime(row.active_started_at, 'R')}`
      : `Last active ${row.last_active_at ? unixTime(row.last_active_at, 'R') : 'never'}`;
    return `<@${row.user_id}> • ${row.role_name} • ${row.status ?? 'active'}\n${shift} • ${formatDuration(row.completed_seconds)} • ${row.total_points} points • ${row.current_streak}-day streak`;
  });
  const leaderboard = getPointsLeaderboard(db, { start: `${getWeekStart()}T00:00:00.000Z`, end: `${new Date(Date.parse(`${getWeekStart()}T00:00:00.000Z`) + 7 * 86400_000).toISOString().slice(0, 10)}T00:00:00.000Z` });
  const weekRanks = leaderboard.slice(0, 5).map((row, index) => `${index + 1}. <@${row.user_id}> • ${row.points} points`).join('\n') || 'No weekly points yet.';
  const embed = makeEmbed(owner ? config.EMBED_COLORS.management : config.EMBED_COLORS.info,
    owner ? '👑 GV GR Owner Dashboard' : '🛡️ GV GR Management Dashboard',
    `Staff on duty: **${active.length}**\nStaff in database: **${roster.length}**\nWeekly goal: **${config.WEEKLY_GOAL_HOURS} hours**${owner ? '\nMessage deletion logs: **Disabled**' : ''}\n\n${body.join('\n\n') || 'No staff records yet.'}`)
    .addFields({ name: 'Weekly Points Leaders', value: weekRanks });
  if (roster.length > 18) embed.setFooter({ text: `Showing 18 of ${roster.length} staff records. Select a member for full history.` });
  return embed;
}

function activityEmbed(db) {
  const rows = getRecentShiftActivity(db, 12);
  const text = rows.map((row) => {
    const status = row.status === 'active'
      ? `checked in ${unixTime(row.started_at, 'R')}`
      : `checked out ${unixTime(row.ended_at, 'R')} • ${formatDuration(row.duration_seconds)}`;
    return `<@${row.user_id}> • ${status}`;
  }).join('\n');
  return makeEmbed(config.EMBED_COLORS.info, '📈 Recent Staff Activity', text || 'No shifts have been recorded.');
}

function reportEmbed(db) {
  const rows = getRecentReports(db, 12);
  const description = rows.map((row) =>
    `**${row.username} • ${row.report_date} • ${row.rating.toUpperCase()}**\nShift: ${formatDuration(row.shift_seconds)}${row.explanation ? `\n${row.explanation}` : ''}`)
    .join('\n\n');
  return makeEmbed(config.EMBED_COLORS.info, '📝 Recent Daily RP Reports', description || 'No daily RP reports have been submitted.');
}

function weeklyLeaderboardEmbed(db) {
  const weekStart = getWeekStart();
  const weekEndDate = new Date(`${weekStart}T00:00:00.000Z`);
  weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 7);
  const rows = getPointsLeaderboard(db, { start: `${weekStart}T00:00:00.000Z`, end: weekEndDate.toISOString() });
  const medals = ['🥇', '🥈', '🥉'];
  const description = rows.map((row, index) => `${medals[index] ?? `${index + 1}.`} <@${row.user_id}> • **${row.points} points**`).join('\n');
  return makeEmbed(config.EMBED_COLORS.info, '🏆 Weekly Staff Points', description || 'No points have been earned this week.');
}

function staffHistoryEmbed(db, userId) {
  const staff = db.prepare('SELECT * FROM staff WHERE user_id = ?').get(userId);
  if (!staff) return makeEmbed(config.EMBED_COLORS.warning, 'Staff History', 'This member does not have a staff record.');
  const stats = getStaffStats(db, userId);
  const reports = getRecentReports(db, 100).filter((row) => row.user_id === userId).slice(0, 5);
  const actions = getPunishments(db, userId, 5);
  const notes = db.prepare('SELECT author_id, note, created_at FROM staff_notes WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(userId);
  const recentReports = reports.map((row) => `${row.report_date} • ${row.rating.toUpperCase()} • ${formatDuration(row.shift_seconds)}`).join('\n') || 'None';
  const recentActions = actions.map((row) => `${row.action} • ${unixTime(row.created_at, 'd')} • ${row.reason || 'No reason recorded'}`).join('\n') || 'None';
  const recentNotes = notes.map((row) => `${unixTime(row.created_at, 'd')} by <@${row.author_id}>: ${row.note}`).join('\n') || 'None';
  return makeEmbed(config.EMBED_COLORS.management, `Staff History • ${staff.username}`,
    `**Role:** ${staff.role_name}\n**Points:** ${stats.totalPoints}\n**Total hours:** ${formatDuration(stats.totalSeconds)}\n**Weekly hours:** ${formatDuration(stats.weeklySeconds)}\n**Streak:** ${stats.currentStreak} days\n**Status:** ${require('../services/staffRewards').currentStatus(db, userId).status}`)
    .addFields(
      { name: 'Recent Daily Reports', value: recentReports.slice(0, 1024) },
      { name: 'Warnings and Actions', value: recentActions.slice(0, 1024) },
      { name: 'Management Notes', value: recentNotes.slice(0, 1024) },
    );
}

  function managementShiftActions(db, userId) {
    const choices = [];
    if (db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'active'").get(userId)) {
      choices.push({ label: 'Clock Out Manually', value: 'close_shift', emoji: '🔴' });
    } else {
      choices.push({ label: 'Clock In Manually', value: 'manual_clock_in', emoji: '🟢' });
    }
    if (db.prepare('SELECT id FROM shifts WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId)) {
      choices.push({ label: 'Correct Most Recent Shift', value: 'correct_shift', emoji: '🕒' });
    }
    if (!choices.length) return [];
    return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`mgmt:shift_action:${userId}`)
      .setPlaceholder('Manually clock or correct this staff member’s shift')
      .addOptions(choices))];
  }

function auditEmbed(db) {
  const rows = getAuditLogs(db, 12);
  const description = rows.map((row) =>
    `**${row.action}** • ${unixTime(row.created_at, 'R')}\nActor <@${row.actor_id}> → <@${row.target_id}>${row.reason ? ` • ${row.reason}` : ''}${row.previous_value != null || row.new_value != null ? `\n${row.previous_value ?? '—'} → ${row.new_value ?? '—'}` : ''}`)
    .join('\n\n');
  return makeEmbed(config.EMBED_COLORS.management, '📚 Staff Audit Log', description || 'No audited management actions yet.');
}

async function openManagementDashboard(interaction, ctx) {
  return interaction.reply({ embeds: [rosterEmbed(ctx.db)], components: managementComponents(), ephemeral: true });
}

async function openOwnerDashboard(interaction, ctx) {
  return interaction.reply({ embeds: [rosterEmbed(ctx.db, true)], components: ownerComponents(ctx.db), ephemeral: true });
}

async function requireManagerInteraction(interaction, ctx, ownerOnly = false) {
  const member = await getInteractionMember(interaction);
  const allowed = ownerOnly
    ? memberIsOwner(member, interaction.guild, ctx.db)
    : memberIsManager(member, interaction.guild, ctx.db);
  if (allowed) return true;
  await interaction.reply({ content: ownerOnly ? 'Only the server owner or a configured Owner role can use this control.' : 'A configured management role is required for this control.', ephemeral: true });
  return false;
}

async function handleManagementButton(interaction, ctx) {
  if (!interaction.customId.startsWith('mgmt:')) return null;
  if (!await requireManagerInteraction(interaction, ctx)) return;
  switch (interaction.customId) {
    case 'mgmt:overview': return interaction.update({ embeds: [rosterEmbed(ctx.db)], components: managementComponents() });
    case 'mgmt:reports': return interaction.update({ embeds: [reportEmbed(ctx.db)], components: managementComponents() });
    case 'mgmt:activity': return interaction.update({ embeds: [activityEmbed(ctx.db)], components: managementComponents() });
    case 'mgmt:leaderboard': return interaction.update({ embeds: [weeklyLeaderboardEmbed(ctx.db)], components: managementComponents() });
    default: return interaction.reply({ content: 'Unknown management control.', ephemeral: true });
  }
}

async function handleManagementSelect(interaction, ctx) {
  if (interaction.customId !== 'mgmt:staff_history') return null;
  if (!await requireManagerInteraction(interaction, ctx)) return;
  const userId = interaction.values[0];
  return interaction.update({
    embeds: [staffHistoryEmbed(ctx.db, userId)],
    components: [...managementComponents(), ...managementShiftActions(ctx.db, userId)],
  });
}

async function handleManagementShiftActionSelect(interaction, ctx) {
  if (!interaction.customId.startsWith('mgmt:shift_action:')) return null;
  if (!await requireManagerInteraction(interaction, ctx)) return;
  const userId = interaction.customId.split(':').at(-1);
  const action = interaction.values[0];
  if (!['close_shift', 'correct_shift', 'manual_clock_in'].includes(action)
    || !ctx.db.prepare('SELECT user_id FROM staff WHERE user_id = ?').get(userId)) {
    return interaction.reply({ content: 'Invalid staff shift action.', ephemeral: true });
  }
  if (action === 'close_shift' && !ctx.db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'active'").get(userId)) {
    return interaction.reply({ content: 'That active shift has already ended.', ephemeral: true });
  }
  if (action === 'correct_shift' && !ctx.db.prepare('SELECT id FROM shifts WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId)) {
    return interaction.reply({ content: 'This staff member has no shift to correct.', ephemeral: true });
  }
  const modal = new ModalBuilder()
    .setCustomId(`mgmt:shift_modal:${userId}:${action}`)
    .setTitle(action === 'close_shift' ? 'Manual Staff Clock-Out' : action === 'manual_clock_in' ? 'Manual Staff Clock-In' : 'Correct Staff Shift');
  if (action === 'correct_shift') {
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('started_at').setLabel('Correct start time (ISO 8601)').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ended_at').setLabel('Correct end time (ISO 8601)').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason for correction').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
    );
  } else {
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId('reason').setLabel(`Reason for ${action === 'manual_clock_in' ? 'clock-in' : 'clock-out'}`).setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1000).setRequired(true)));
  }
  return interaction.showModal(modal);
}

async function handleManagementShiftModal(interaction, ctx) {
  const [, , userId, action] = interaction.customId.split(':');
  if (!await requireManagerInteraction(interaction, ctx)) return;
  if (!['close_shift', 'correct_shift', 'manual_clock_in'].includes(action)
    || !ctx.db.prepare('SELECT user_id FROM staff WHERE user_id = ?').get(userId)) {
    return interaction.reply({ content: 'Invalid staff shift action.', ephemeral: true });
  }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return interaction.reply({ content: 'A reason is required to change a shift.', ephemeral: true });
  const data = action === 'correct_shift' ? {
    startedAt: interaction.fields.getTextInputValue('started_at').trim(),
    endedAt: interaction.fields.getTextInputValue('ended_at').trim(),
  } : {};
  const actionId = randomUUID();
  const now = new Date().toISOString();
  ctx.db.prepare(`
    INSERT INTO staff_pending_actions (action_id, actor_id, target_id, action, reason, data_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(actionId, interaction.user.id, userId, action, reason, JSON.stringify(data), new Date(Date.now() + pendingDuration).toISOString(), now);
  const staff = ctx.db.prepare('SELECT username FROM staff WHERE user_id = ?').get(userId);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`mgmt:shift_confirm:${actionId}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`mgmt:shift_cancel:${actionId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    embeds: [makeEmbed(config.EMBED_COLORS.warning, 'Confirm Staff Shift Change',
      `**Action:** ${actionLabels[action]}\n**Member:** ${staff.username} (<@${userId}>)\n**Reason:** ${reason}\n\nThis confirmation expires in 5 minutes.`)],
    components: [buttons], ephemeral: true,
  });
}

async function handleManagementShiftConfirm(interaction, ctx) {
  if (!interaction.customId.startsWith('mgmt:shift_confirm:')
    && !interaction.customId.startsWith('mgmt:shift_cancel:')) return null;
  if (!await requireManagerInteraction(interaction, ctx)) return;
  const [, verb, actionId] = interaction.customId.split(':');
  const pending = ctx.db.prepare('SELECT * FROM staff_pending_actions WHERE action_id = ?').get(actionId);
  if (!pending || pending.actor_id !== interaction.user.id || !['close_shift', 'correct_shift', 'manual_clock_in'].includes(pending.action)) {
    return interaction.reply({ content: 'This shift confirmation is missing or belongs to another manager.', ephemeral: true });
  }
  if (pending.status !== 'pending') return interaction.reply({ content: 'This shift action was already processed.', ephemeral: true });
  if (pending.expires_at <= new Date().toISOString()) {
    ctx.db.prepare("UPDATE staff_pending_actions SET status = 'expired' WHERE action_id = ? AND status = 'pending'").run(actionId);
    return interaction.reply({ content: 'This confirmation expired; create a new shift action if needed.', ephemeral: true });
  }
  if (verb === 'shift_cancel') {
    ctx.db.prepare("UPDATE staff_pending_actions SET status = 'cancelled' WHERE action_id = ? AND status = 'pending'").run(actionId);
    return interaction.update({ content: 'Shift action cancelled.', embeds: [], components: [] });
  }

  await interaction.deferUpdate();

  let targetMember;
  let targetRoleName;
  if (pending.action === 'manual_clock_in') {
    targetMember = await fetchGuildMember(interaction.guild, pending.target_id);
    targetRoleName = targetMember && getStaffRoleName(targetMember, ctx.db);
    if (!targetMember || !targetRoleName) {
      return interaction.editReply({ content: 'Manual clock-in requires the selected member to have a configured staff role.', embeds: [], components: [] });
    }
  }

  try {
    ctx.db.transaction(() => {
      const claimed = ctx.db.prepare("UPDATE staff_pending_actions SET status = 'confirmed' WHERE action_id = ? AND status = 'pending'").run(actionId);
      if (!claimed.changes) throw new Error('This shift action has already been processed.');
      const data = JSON.parse(pending.data_json);
      if (pending.action === 'manual_clock_in') {
        const result = managementClockInStaff(ctx.db, {
          member: { id: pending.target_id, username: targetMember.user.username, roleName: targetRoleName },
          actorId: interaction.user.id,
          reason: pending.reason,
        });
        if (result.alreadyOnDuty) throw new Error('This staff member is already on duty.');
        if (result.unavailable) throw new Error(`This staff member cannot clock in while their status is ${result.status}.`);
      } else if (pending.action === 'close_shift') {
        const shift = ctx.db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'active'").get(pending.target_id);
        if (!shift) throw new Error('The active shift has already ended.');
        closeShiftByManagement(ctx.db, { shiftId: shift.id, actorId: interaction.user.id, reason: pending.reason });
      } else {
        const shift = ctx.db.prepare('SELECT id FROM shifts WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(pending.target_id);
        if (!shift) throw new Error('No shift exists to correct.');
        correctCompletedShift(ctx.db, {
          shiftId: shift.id, actorId: interaction.user.id,
          startedAt: data.startedAt, endedAt: data.endedAt, reason: pending.reason,
        });
      }
    })();
    const response = await interaction.editReply({ content: 'The shift change was applied and saved to the audit log.', embeds: [], components: [] });
    await refreshStaffPanel(interaction.client, interaction.guild, ctx.db);
    return response;
  } catch (error) {
    console.error('Management shift action failed:', error);
    return interaction.editReply({ content: `Shift change was not applied: ${error.message}`, embeds: [], components: [] });
  }
}

function ownerActionComponents(userId, hasActiveShift) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`owner:action:${userId}`)
    .setPlaceholder('Choose a confirmed Owner action')
    .addOptions(
      { label: 'Add Staff Points', value: 'add_points', emoji: '⭐' },
      { label: 'Remove Staff Points', value: 'remove_points', emoji: '⭐' },
      { label: 'Issue Warning', value: 'warning', emoji: '⚠️' },
      { label: 'Admin Break (1 day)', value: 'break_1d', emoji: '⏸️' },
      { label: 'Admin Break (3 days)', value: 'break_3d', emoji: '⏸️' },
      { label: 'Admin Break (7 days)', value: 'break_7d', emoji: '⏸️' },
      { label: 'Suspend Staff (7 days)', value: 'suspend_7d', emoji: '🚫' },
      { label: 'Demote Staff', value: 'demote', emoji: '🔻' },
      { label: 'Remove From Staff', value: 'remove', emoji: '❌' },
      { label: 'Add Management Note', value: 'note', emoji: '📝' },
      { label: 'Reset Streak', value: 'reset_streak', emoji: '🔥' },
      { label: 'Correct Most Recent Shift', value: 'correct_shift', emoji: '🕒' },
      ...(hasActiveShift ? [{ label: 'Close Active Shift', value: 'close_shift', emoji: '🔴' }] : []),
    );
  return [
    new ActionRowBuilder().addComponents(menu),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('owner:overview').setLabel('Back to Owner Dashboard').setStyle(ButtonStyle.Secondary)),
  ];
}

async function handleOwnerSelect(interaction, ctx) {
  if (interaction.customId !== 'owner:select_staff') return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  const userId = interaction.values[0];
  const staff = ctx.db.prepare('SELECT * FROM staff WHERE user_id = ?').get(userId);
  if (!staff) return interaction.reply({ content: 'That member does not have a staff record.', ephemeral: true });
  const stats = getStaffStats(ctx.db, userId);
  const active = Boolean(stats.activeShift);
  const embed = makeEmbed(config.EMBED_COLORS.management, `👑 Owner Actions • ${staff.username}`,
    `**Role:** ${staff.role_name}\n**Status:** ${require('../services/staffRewards').currentStatus(ctx.db, userId).status}\n**Points:** ${stats.totalPoints}\n**Total hours:** ${formatDuration(stats.totalSeconds)}\n**Current streak:** ${stats.currentStreak} days\n**Active shift:** ${active ? formatDuration(stats.activeShift.durationSeconds) : 'No active shift'}\n\nChoose an action below. Important actions require confirmation.`);
  return interaction.update({ embeds: [embed], components: ownerActionComponents(userId, active) });
}

function createActionModal(userId, action) {
  const modal = new ModalBuilder()
    .setCustomId(`owner:modal:${userId}:${action}`)
    .setTitle(actionLabels[action].slice(0, 45));
  if (action === 'correct_shift') {
    return modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('started_at').setLabel('Correct start time (ISO 8601)').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ended_at').setLabel('Correct end time (ISO 8601)').setStyle(TextInputStyle.Short).setMaxLength(40).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason for correction').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)),
    );
  }
  const rows = [];
  if (['add_points', 'remove_points'].includes(action)) {
    rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Whole number of points').setStyle(TextInputStyle.Short).setMaxLength(6).setRequired(true)));
  }
  rows.push(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Reason (required)').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true)));
  return modal.addComponents(...rows);
}

async function handleOwnerActionSelect(interaction, ctx) {
  if (!interaction.customId.startsWith('owner:action:')) return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  const userId = interaction.customId.split(':').at(-1);
  const action = interaction.values[0];
  if (!actionLabels[action] || !ctx.db.prepare('SELECT user_id FROM staff WHERE user_id = ?').get(userId)) {
    return interaction.reply({ content: 'Invalid staff action or staff member.', ephemeral: true });
  }
  if (action === 'close_shift' && !ctx.db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'active'").get(userId)) {
    return interaction.reply({ content: 'This staff member has no active shift to close.', ephemeral: true });
  }
  return interaction.showModal(createActionModal(userId, action));
}

async function handleOwnerActionModal(interaction, ctx) {
  const [, , userId, action] = interaction.customId.split(':');
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  if (!actionLabels[action] || !ctx.db.prepare('SELECT user_id FROM staff WHERE user_id = ?').get(userId)) {
    return interaction.reply({ content: 'Invalid staff action or staff member.', ephemeral: true });
  }
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return interaction.reply({ content: 'A reason is required.', ephemeral: true });
  const data = {};
  data.actorName = interaction.user.username;
  if (['add_points', 'remove_points'].includes(action)) {
    const amount = Number(interaction.fields.getTextInputValue('amount'));
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 10000) {
      return interaction.reply({ content: 'Enter a whole number from 1 to 10000.', ephemeral: true });
    }
    data.amount = action === 'remove_points' ? -amount : amount;
  }
  if (action === 'correct_shift') {
    data.startedAt = interaction.fields.getTextInputValue('started_at').trim();
    data.endedAt = interaction.fields.getTextInputValue('ended_at').trim();
  }
  const now = new Date().toISOString();
  const actionId = randomUUID();
  ctx.db.prepare(`
    INSERT INTO staff_pending_actions (action_id, actor_id, target_id, action, reason, data_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(actionId, interaction.user.id, userId, action, reason, JSON.stringify(data), new Date(Date.now() + pendingDuration).toISOString(), now);

  const staff = ctx.db.prepare('SELECT username FROM staff WHERE user_id = ?').get(userId);
  const currentPoints = getStaffStats(ctx.db, userId).totalPoints;
  const pointLine = data.amount
    ? `\n**Points:** ${currentPoints} → ${currentPoints + data.amount}`
    : '';
  const confirm = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`owner:confirm:${actionId}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`owner:cancel:${actionId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  const embed = makeEmbed(config.EMBED_COLORS.warning, `Confirm: ${actionLabels[action]}`,
    `**Member:** ${staff.username} (<@${userId}>)${pointLine}\n**Reason:** ${reason}\n\nThis confirmation expires in 5 minutes.`);
  return interaction.reply({ embeds: [embed], components: [confirm], ephemeral: true });
}

function executeOwnerAction(db, pending, actorId) {
  const data = JSON.parse(pending.data_json);
  const common = { userId: pending.target_id, actorId, reason: pending.reason };
  switch (pending.action) {
    case 'add_points':
    case 'remove_points':
      return adjustStaffPoints(db, { ...common, amount: data.amount });
    case 'warning': {
      const staff = db.prepare('SELECT username FROM staff WHERE user_id = ?').get(pending.target_id);
      return addStaffWarning(db, { ...common, username: staff.username, actorName: data.actorName });
    }
    case 'break_1d':
    case 'break_3d':
    case 'break_7d':
      return applyStaffStatus(db, { ...common, action: 'break', durationSeconds: Number(pending.action.split('_')[1]) * 86400 });
    case 'suspend_7d':
      return applyStaffStatus(db, { ...common, action: 'suspend', durationSeconds: 7 * 86400 });
    case 'demote':
      return applyStaffStatus(db, { ...common, action: 'demote' });
    case 'remove':
      return applyStaffStatus(db, { ...common, action: 'remove' });
    case 'note': {
      const staff = db.prepare('SELECT username FROM staff WHERE user_id = ?').get(pending.target_id);
      return addStaffNote(db, { ...common, username: staff.username, actorName: data.actorName, note: pending.reason });
    }
    case 'reset_streak':
      return resetStaffStreak(db, common);
    case 'close_shift': {
      const shift = db.prepare("SELECT id FROM shifts WHERE user_id = ? AND status = 'active'").get(pending.target_id);
      if (!shift) throw new Error('The active shift has already ended.');
      return closeShiftByManagement(db, { shiftId: shift.id, actorId, reason: pending.reason });
    }
    case 'correct_shift': {
      const shift = db.prepare('SELECT id FROM shifts WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(pending.target_id);
      if (!shift) throw new Error('No shift exists to correct.');
      return correctCompletedShift(db, { shiftId: shift.id, actorId, startedAt: data.startedAt, endedAt: data.endedAt, reason: pending.reason });
    }
    default:
      throw new Error('This action is not supported.');
  }
}

async function handleOwnerConfirm(interaction, ctx) {
  const [namespace, verb, actionId] = interaction.customId.split(':');
  if (namespace !== 'owner' || !['confirm', 'cancel'].includes(verb)) return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  const pending = ctx.db.prepare('SELECT * FROM staff_pending_actions WHERE action_id = ?').get(actionId);
  if (!pending || pending.actor_id !== interaction.user.id) {
    return interaction.reply({ content: 'This confirmation is missing, expired, or belongs to another Owner.', ephemeral: true });
  }
  if (pending.status !== 'pending') return interaction.reply({ content: 'This action was already confirmed or cancelled.', ephemeral: true });
  if (pending.expires_at <= new Date().toISOString()) {
    ctx.db.prepare("UPDATE staff_pending_actions SET status = 'expired' WHERE action_id = ? AND status = 'pending'").run(actionId);
    return interaction.reply({ content: 'This confirmation expired. Start the action again if it is still needed.', ephemeral: true });
  }
  if (verb === 'cancel') {
    ctx.db.prepare("UPDATE staff_pending_actions SET status = 'cancelled' WHERE action_id = ? AND status = 'pending'").run(actionId);
    return interaction.update({ content: 'Action cancelled.', embeds: [], components: [] });
  }

  try {
    const result = ctx.db.transaction(() => {
      const claimed = ctx.db.prepare("UPDATE staff_pending_actions SET status = 'confirmed' WHERE action_id = ? AND status = 'pending'").run(actionId);
      if (!claimed.changes) throw new Error('This action has already been processed.');
      return executeOwnerAction(ctx.db, pending, interaction.user.id);
    })();
    return interaction.update({ content: `**${actionLabels[pending.action]}** confirmed for <@${pending.target_id}>. The action and audit record were saved.`, embeds: [], components: [] });
  } catch (error) {
    console.error('Owner action failed:', error);
    return interaction.reply({ content: `Action was not applied: ${error.message}`, ephemeral: true });
  }
}

async function handleOwnerSettingsSelect(interaction, ctx) {
  if (!interaction.customId.startsWith('owner:settings:')) return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;

  const [namespace, section, action, target] = interaction.customId.split(':');
  if (namespace !== 'owner' || section !== 'settings') return null;

  if (interaction.isStringSelectMenu() && action === 'channel') {
    const setting = interaction.values[0];
    if (!Object.hasOwn(ownerChannelSettings, setting)) {
      return interaction.reply({ content: 'That channel setting is not supported.', ephemeral: true });
    }
    return interaction.update({
      embeds: [makeEmbed(config.EMBED_COLORS.management, `⚙️ ${ownerChannelSettings[setting]}`,
        `Current channel: ${/^\d{17,20}$/.test(getConfigValue(ctx.db, setting) ?? '') ? `<#${getConfigValue(ctx.db, setting)}>` : 'Not configured'}\nSelect a replacement text channel.`)],
      components: [
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
          .setCustomId(`owner:settings:setchannel:${setting}`)
          .setPlaceholder('Select a text channel')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('owner:settings')
          .setLabel('Back to Server Settings').setStyle(ButtonStyle.Secondary)),
      ],
    });
  }

  if (interaction.isStringSelectMenu() && action === 'roles') {
    const group = interaction.values[0];
    if (!Object.hasOwn(ownerRoleGroups, group)) {
      return interaction.reply({ content: 'That role group is not supported.', ephemeral: true });
    }
    const settingKey = `role_${group}`;
    const current = configuredRoleGroup(ctx.db, group);
    return interaction.update({
      embeds: [makeEmbed(config.EMBED_COLORS.management, `⚙️ ${ownerRoleGroups[group]}`,
        `Current roles: ${current.length ? current.map((roleId) => `<@&${roleId}>`).join(', ') : 'None'}\nSelect all roles that should belong to this group. This replaces the current group.`)],
      components: [
        new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder()
          .setCustomId(`owner:settings:saveroles:${group}`)
          .setPlaceholder(`Select ${ownerRoleGroups[group].toLowerCase()}`)
          .setMinValues(0).setMaxValues(group === 'admin_recruiting' ? 1 : 25)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('owner:settings')
          .setLabel('Back to Server Settings').setStyle(ButtonStyle.Secondary)),
      ],
    });
  }

  if (interaction.isStringSelectMenu() && action === 'categories') {
    const setting = interaction.values[0];
    if (!Object.hasOwn(ownerTicketCategories, setting)) {
      return interaction.reply({ content: 'That ticket category setting is not supported.', ephemeral: true });
    }
    return interaction.update({
      embeds: [makeEmbed(config.EMBED_COLORS.management, ownerTicketCategories[setting],
        `Current category: ${/^\d{17,20}$/.test(getConfigValue(ctx.db, setting) ?? '') ? `<#${getConfigValue(ctx.db, setting)}>` : 'Not configured'}\nSelect a private Discord category.`)],
      components: [
        new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
          .setCustomId(`owner:settings:setcategory:${setting}`)
          .setPlaceholder('Select a category')
          .setChannelTypes(ChannelType.GuildCategory)),
        new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('owner:settings')
          .setLabel('Back to Server Settings').setStyle(ButtonStyle.Secondary)),
      ],
    });
  }

  if (interaction.isStringSelectMenu() && action === 'session') {
    const setting = interaction.values[0];
    if (!Object.hasOwn(ownerSessionSettings, setting)) {
      return interaction.reply({ content: 'That session setting is not supported.', ephemeral: true });
    }
    return interaction.showModal(createOwnerSessionSettingModal(setting, getConfigValue(ctx.db, setting) ?? ''));
  }

  if (interaction.isChannelSelectMenu() && action === 'setchannel') {
    const setting = target;
    if (!Object.hasOwn(ownerChannelSettings, setting)) {
      return interaction.reply({ content: 'That channel setting is not supported.', ephemeral: true });
    }
    const channelId = interaction.values[0];
    const previous = getConfigValue(ctx.db, setting);
    setConfigValue(ctx.db, setting, channelId);
    logAudit(ctx.db, {
      action: 'configuration_change', targetId: interaction.guild.id, actorId: interaction.user.id,
      reason: `Updated ${ownerChannelSettings[setting]}`, previousValue: previous ?? 'not configured', newValue: channelId,
      details: { setting },
    });
    return interaction.update({ embeds: [ownerSettingsEmbed(ctx.db)], components: ownerSettingsComponents() });
  }

  if (interaction.isChannelSelectMenu() && action === 'setcategory') {
    const setting = target;
    if (!Object.hasOwn(ownerTicketCategories, setting)) {
      return interaction.reply({ content: 'That ticket category setting is not supported.', ephemeral: true });
    }
    const categoryId = interaction.values[0];
    const previous = getConfigValue(ctx.db, setting);
    setConfigValue(ctx.db, setting, categoryId);
    logAudit(ctx.db, {
      action: 'configuration_change', targetId: interaction.guild.id, actorId: interaction.user.id,
      reason: `Updated ${ownerTicketCategories[setting]}`, previousValue: previous ?? 'not configured', newValue: categoryId,
      details: { setting },
    });
    return interaction.update({ embeds: [ownerSettingsEmbed(ctx.db)], components: ownerSettingsComponents() });
  }

  if (interaction.isRoleSelectMenu() && action === 'saveroles') {
    const group = target;
    if (!Object.hasOwn(ownerRoleGroups, group)) {
      return interaction.reply({ content: 'That role group is not supported.', ephemeral: true });
    }
    const settingKey = `role_${group}`;
    const previous = configuredRoleGroup(ctx.db, group);
    const updated = [...new Set(interaction.values)];
    if (group === 'admin_recruiting' && updated.length > 1) {
      return interaction.reply({ content: 'Admin testing/recruiting access must use exactly one role.', ephemeral: true });
    }
    setConfigValue(ctx.db, settingKey, updated);
    logAudit(ctx.db, {
      action: 'permission_change', targetId: interaction.guild.id, actorId: interaction.user.id,
      reason: `Updated ${ownerRoleGroups[group]}`, previousValue: previous.join(',') || 'none', newValue: updated.join(',') || 'none',
      details: { group },
    });
    return interaction.update({ embeds: [ownerSettingsEmbed(ctx.db)], components: ownerSettingsComponents() });
  }

  return interaction.reply({ content: 'That Owner Settings control is not recognized.', ephemeral: true });
}

async function handleOwnerSettingsModal(interaction, ctx) {
  const sessionSetting = interaction.customId.startsWith('owner:settings:session_modal:')
    ? interaction.customId.split(':').at(-1) : null;
  const automodStage = interaction.customId.startsWith('owner:automod:')
    ? interaction.customId.split(':').at(-1).replace(/_modal$/, '') : null;
  if (interaction.customId !== 'owner:settings:timezone_modal' && !sessionSetting && !automodStage) return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  if (sessionSetting) {
    const definition = ownerSessionSettings[sessionSetting];
    if (!definition) return interaction.reply({ content: 'That session setting is not supported.', ephemeral: true });
    let value = interaction.fields.getTextInputValue('value').trim();
    if (sessionSetting === 'SESSION_JOIN_CODE' && /[\r\n`]/.test(value)) {
      return interaction.reply({ content: 'The join code must be one line and cannot contain code-fence characters.', ephemeral: true });
    }
    if (sessionSetting !== 'SESSION_JOIN_CODE' && value) {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Invalid HTTPS URL');
        value = url.toString();
      } catch {
        return interaction.reply({ content: 'Enter a valid HTTPS URL, or leave the field blank to clear it.', ephemeral: true });
      }
    }
    const previous = getConfigValue(ctx.db, sessionSetting) ?? '';
    setConfigValue(ctx.db, sessionSetting, value);
    logAudit(ctx.db, {
      action: 'configuration_change', targetId: interaction.guild.id, actorId: interaction.user.id,
      reason: `Updated ${definition.label}`, previousValue: previous || 'not configured', newValue: value || 'not configured',
      details: { setting: sessionSetting },
    });
    return interaction.reply({ embeds: [ownerSettingsEmbed(ctx.db)], components: ownerSettingsComponents(), ephemeral: true });
  }
  if (automodStage) {
    const read = (field) => interaction.fields.getTextInputValue(field).trim();
    const bool = (value, label) => {
      if (!['true', 'false'].includes(value.toLowerCase())) throw new Error(`${label} must be true or false.`);
      return value.toLowerCase() === 'true';
    };
    const integer = (value, label, minimum, maximum) => {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${label} must be a whole number from ${minimum} to ${maximum}.`);
      }
      return parsed;
    };
    let updates;
    try {
      if (automodStage === 'core') {
        const mode = read('mode').toLowerCase();
        if (!['log', 'warn', 'delete', 'timeout'].includes(mode)) throw new Error('Mode must be log, warn, delete, or timeout.');
        updates = {
          AUTOMOD_ENABLED: bool(read('enabled'), 'Enabled'),
          AUTOMOD_MODE: mode,
          AUTOMOD_SPAM_THRESHOLD: integer(read('spam_threshold'), 'Spam threshold', 3, 100),
          AUTOMOD_SPAM_WINDOW_SECONDS: integer(read('spam_window'), 'Spam window', 3, 300),
          AUTOMOD_REPEAT_THRESHOLD: integer(read('repeat_threshold'), 'Repeat threshold', 2, 20),
        };
      } else if (automodStage === 'filters') {
        updates = {
          AUTOMOD_MENTION_LIMIT: integer(read('mention_limit'), 'Mention limit', 2, 100),
          AUTOMOD_FILTER_LINKS: bool(read('filter_links'), 'Link filter'),
          AUTOMOD_FILTER_INVITES: bool(read('filter_invites'), 'Invite filter'),
          AUTOMOD_RAID_THRESHOLD: integer(read('raid_threshold'), 'Join alert threshold', 3, 500),
          AUTOMOD_RAID_WINDOW_SECONDS: integer(read('raid_window'), 'Join alert window', 5, 600),
        };
      } else if (automodStage === 'exemptions') {
        const parseIds = (value, label) => {
          const ids = value.split(/[\s,]+/).filter(Boolean);
          if (ids.length > 25 || ids.some((id) => !/^\d{17,20}$/.test(id))) throw new Error(`${label} must contain valid Discord IDs (up to 25).`);
          return [...new Set(ids)];
        };
        const domains = read('domains').split(/[\s,]+/).filter(Boolean).map((domain) => domain.toLowerCase());
        if (domains.length > 25 || domains.some((domain) => !/^(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain))) {
          throw new Error('Trusted domains must be hostnames such as `example.com` (up to 25).');
        }
        updates = {
          AUTOMOD_EXEMPT_ROLE_IDS: parseIds(read('role_ids'), 'Exempt roles'),
          AUTOMOD_EXEMPT_CHANNEL_IDS: parseIds(read('channel_ids'), 'Exempt channels'),
          AUTOMOD_ALLOWLISTED_DOMAINS: [...new Set(domains)],
        };
      } else if (automodStage === 'escalation') {
        updates = {
          AUTOMOD_TIMEOUT_MINUTES: integer(read('timeout_minutes'), 'Timeout duration', 1, 60),
          AUTOMOD_TIMEOUT_AFTER_INCIDENTS: integer(read('timeout_after'), 'Incidents before timeout', 1, 20),
        };
      } else {
        return interaction.reply({ content: 'That AutoMod settings form is not supported.', ephemeral: true });
      }
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    const previous = Object.fromEntries(Object.keys(updates).map((key) => [key, getConfigValue(ctx.db, key)]));
    ctx.db.transaction(() => {
      for (const [key, value] of Object.entries(updates)) setConfigValue(ctx.db, key, value);
      logAudit(ctx.db, {
        action: 'configuration_change', targetId: interaction.guild.id, actorId: interaction.user.id,
        reason: `Updated AutoMod ${automodStage} settings`,
        previousValue: JSON.stringify(previous), newValue: JSON.stringify(updates),
        details: { settings: Object.keys(updates) },
      });
    })();
    const content = updates.AUTOMOD_ENABLED === true
      ? 'AutoMod settings saved. Enable the Message Content privileged intent in Discord Developer Portal, then restart before relying on text/link filters. No bans are automated.'
      : 'AutoMod settings saved. No message monitoring is active while AutoMod is disabled.';
    return interaction.reply({ content, embeds: [ownerSettingsEmbed(ctx.db)], components: ownerSettingsComponents(), ephemeral: true });
  }
  const timezone = interaction.fields.getTextInputValue('timezone').trim();
  const zone = DateTime.now().setZone(timezone);
  if (!zone.isValid || !zone.zoneName) {
    return interaction.reply({ content: 'That timezone is not valid. Enter an IANA timezone such as `America/Chicago` or `UTC`.', ephemeral: true });
  }
  const normalizedTimezone = zone.zoneName;
  const previous = getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC';
  setConfigValue(ctx.db, 'TIME_ZONE', normalizedTimezone);
  logAudit(ctx.db, {
    action: 'configuration_change', targetId: interaction.guild.id, actorId: interaction.user.id,
    reason: 'Updated server timezone', previousValue: previous, newValue: normalizedTimezone,
  });
  return interaction.reply({ embeds: [ownerSettingsEmbed(ctx.db)], components: ownerSettingsComponents(), ephemeral: true });
}

async function handleOwnerButton(interaction, ctx) {
  if (!interaction.customId.startsWith('owner:')) return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  if (interaction.customId.startsWith('owner:automod:')) {
    const stage = interaction.customId.split(':').at(-1);
    if (!['core', 'filters', 'exemptions', 'escalation'].includes(stage)) {
      return interaction.reply({ content: 'That AutoMod settings action is not supported.', ephemeral: true });
    }
    return interaction.showModal(createAutomodModal(stage, ctx.db));
  }
  if (interaction.customId === 'owner:toggle_message_delete_logging') {
    return interaction.update({
      content: 'Message deletion logging is disabled and can no longer be enabled here.',
      embeds: [rosterEmbed(ctx.db, true)],
      components: ownerComponents(ctx.db),
    });
  }
  if (interaction.customId === 'owner:cleanup') {
    const selector = new StringSelectMenuBuilder().setCustomId('owner:cleanup:category')
      .setPlaceholder('Select a safe cleanup category')
      .addOptions({ label: 'Completed session announcements older than 14 days', value: 'completed_sessions' });
    return interaction.reply({
      content: 'Cleanup only includes completed session announcements tracked by the bot. Panels, active sessions, session records, and untracked messages are excluded.',
      components: [new ActionRowBuilder().addComponents(selector)], ephemeral: true,
    });
  }
  if (interaction.customId.startsWith('owner:cleanup:confirm:')
    || interaction.customId.startsWith('owner:cleanup:cancel:')) {
    return handleOwnerCleanupConfirmation(interaction, ctx);
  }
  switch (interaction.customId) {
    case 'owner:settings': return interaction.update({ embeds: [ownerSettingsEmbed(ctx.db)], components: ownerSettingsComponents() });
    case 'owner:settings:timezone': return interaction.showModal(createOwnerTimezoneModal(getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC'));
    case 'owner:overview': return interaction.update({ embeds: [rosterEmbed(ctx.db, true)], components: ownerComponents(ctx.db) });
    case 'owner:reports': return interaction.update({ embeds: [reportEmbed(ctx.db)], components: ownerComponents(ctx.db) });
    case 'owner:audit': return interaction.update({ embeds: [auditEmbed(ctx.db)], components: ownerComponents(ctx.db) });
    case 'owner:activity': return interaction.update({ embeds: [activityEmbed(ctx.db)], components: ownerComponents(ctx.db) });
    default: return null;
  }
}

async function handleOwnerCleanupSelect(interaction, ctx) {
  if (interaction.customId !== 'owner:cleanup:category') return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  if (interaction.values[0] !== 'completed_sessions') {
    return interaction.reply({ content: 'That cleanup category is not supported.', ephemeral: true });
  }
  const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString();
  const items = ctx.db.prepare(`SELECT id, session_code, name, channel_id, message_id, ended_at
    FROM sessions WHERE status = 'completed' AND lifecycle_status = 'completed'
      AND ended_at <= ? AND channel_id IS NOT NULL AND message_id IS NOT NULL
    ORDER BY ended_at ASC`).all(cutoff);
  if (!items.length) {
    return interaction.reply({ content: 'No completed session announcements older than 14 days are safely identified. No messages were changed.', ephemeral: true });
  }
  const previewId = randomUUID();
  const now = new Date().toISOString();
  ctx.db.prepare(`INSERT INTO message_cleanup_previews (preview_id, owner_id, category, items_json, expires_at, created_at)
    VALUES (?, ?, 'completed_sessions', ?, ?, ?)`)
    .run(previewId, interaction.user.id, JSON.stringify(items), new Date(Date.now() + pendingDuration).toISOString(), now);
  const previewLines = items.slice(0, 8).map((item) => `• ${item.session_code || `Session #${item.id}`} ${item.name} • <#${item.channel_id}>`).join('\n');
  const rowButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`owner:cleanup:confirm:${previewId}`).setLabel(`Delete ${items.length} tracked posts`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`owner:cleanup:cancel:${previewId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return interaction.reply({
    content: `Preview: **${items.length}** completed session announcement(s), all older than 14 days. Only stored message IDs authored by this bot will be deleted. Session records and history are preserved.\n\n${previewLines}${items.length > 8 ? `\n…and ${items.length - 8} more.` : ''}\n\nThis preview expires in 5 minutes.`,
    components: [rowButtons], ephemeral: true,
  });
}

async function handleOwnerCleanupConfirmation(interaction, ctx) {
  const [, , action, previewId] = interaction.customId.split(':');
  const preview = ctx.db.prepare('SELECT * FROM message_cleanup_previews WHERE preview_id = ?').get(previewId);
  if (!preview || preview.owner_id !== interaction.user.id || preview.category !== 'completed_sessions') {
    return interaction.reply({ content: 'This cleanup preview is missing or belongs to another Owner.', ephemeral: true });
  }
  if (preview.status !== 'pending') return interaction.reply({ content: 'This cleanup preview was already processed.', ephemeral: true });
  if (preview.expires_at <= new Date().toISOString()) {
    ctx.db.prepare("UPDATE message_cleanup_previews SET status = 'expired' WHERE preview_id = ? AND status = 'pending'").run(previewId);
    return interaction.reply({ content: 'This cleanup preview expired. Create a new preview to continue.', ephemeral: true });
  }
  if (action === 'cancel') {
    ctx.db.prepare("UPDATE message_cleanup_previews SET status = 'cancelled' WHERE preview_id = ? AND status = 'pending'").run(previewId);
    return interaction.update({ content: 'Cleanup cancelled. No messages were changed.', embeds: [], components: [] });
  }
  if (action !== 'confirm') return interaction.reply({ content: 'That cleanup action is not supported.', ephemeral: true });

  const claimed = ctx.db.prepare("UPDATE message_cleanup_previews SET status = 'processing' WHERE preview_id = ? AND status = 'pending'").run(previewId);
  if (!claimed.changes) return interaction.reply({ content: 'This cleanup preview was already claimed.', ephemeral: true });
  await interaction.deferUpdate();

  const items = JSON.parse(preview.items_json);
  const deletedMessageIds = [];
  const skipped = [];
  for (const item of items) {
    const current = ctx.db.prepare(`SELECT status, lifecycle_status, channel_id, message_id FROM sessions WHERE id = ?`).get(item.id);
    if (!current || current.status !== 'completed' || current.lifecycle_status !== 'completed'
      || current.channel_id !== item.channel_id || current.message_id !== item.message_id) {
      skipped.push({ messageId: item.message_id, reason: 'session state or message reference changed' });
      continue;
    }
    try {
      const channel = await interaction.client.channels.fetch(item.channel_id);
      const message = channel?.isTextBased() ? await channel.messages.fetch(item.message_id) : null;
      if (!message || message.author?.id !== interaction.client.user.id) {
        skipped.push({ messageId: item.message_id, reason: 'message missing or not authored by this bot' });
        continue;
      }
      await message.delete();
      deletedMessageIds.push(item.message_id);
    } catch (error) {
      skipped.push({ messageId: item.message_id, reason: error.message });
    }
  }

  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE message_cleanup_previews SET status = 'completed' WHERE preview_id = ? AND status = 'processing'").run(previewId);
    logAudit(ctx.db, {
      action: 'message_cleanup', targetId: interaction.guild.id, actorId: interaction.user.id,
      reason: 'Owner-approved cleanup of completed session announcements',
      details: { category: preview.category, deletedMessageIds, skipped },
    });
  })();
  return interaction.editReply({ content: `Cleanup finished: **${deletedMessageIds.length}** message(s) deleted; **${skipped.length}** skipped. Session records and history were preserved.`, embeds: [], components: [] });
}

async function handleOwnerHistorySelect(interaction, ctx) {
  if (!interaction.customId.startsWith('owner:')) return null;
  if (!await requireManagerInteraction(interaction, ctx, true)) return;
  if (interaction.customId !== 'owner:select_staff') return null;
  const userId = interaction.values[0];
  if (!ctx.db.prepare('SELECT user_id FROM staff WHERE user_id = ?').get(userId)) {
    return interaction.reply({ content: 'That member does not have a staff record.', ephemeral: true });
  }
  return interaction.update({ embeds: [staffHistoryEmbed(ctx.db, userId)], components: [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`owner:action:${userId}`)
      .setPlaceholder('Choose an Owner-only staff action')
      .addOptions(Object.entries(actionLabels).map(([value, label]) => ({ label, value })))),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('owner:overview').setLabel('Back to Owner Dashboard').setStyle(ButtonStyle.Secondary)),
  ] });
}

module.exports = {
  handleManagementButton,
  handleManagementSelect,
  handleManagementShiftActionSelect,
  handleManagementShiftConfirm,
  handleManagementShiftModal,
  handleOwnerActionModal,
  handleOwnerActionSelect,
  handleOwnerButton,
  handleOwnerCleanupSelect,
  handleOwnerConfirm,
  handleOwnerHistorySelect,
  handleOwnerSettingsSelect,
  handleOwnerSettingsModal,
  openManagementDashboard,
  openOwnerDashboard,
};
