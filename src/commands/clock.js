const config = require('../../config');
const { getOnDuty } = require('../services/clock');
const { checkInStaff, checkOutStaff } = require('../services/staffRewards');
const { formatDuration } = require('../utils/format');
const {
  createCheckoutReply,
  createStaffCenterComponents,
  createStaffStatsEmbed,
} = require('../utils/staffCenter');
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

function createPanelComponents() {
  return createStaffCenterComponents();
}

function canRefreshStaffPanel(member, guild, db) {
  return Boolean(member && (
    member.id === guild.ownerId
    || hasRoleGroup(member, db, 'management')
    || hasRoleGroup(member, db, 'owners')
  ));
}

async function buildPanelEmbed(db, guild) {
  const onDuty = getOnDuty(db);
  let staffOnline = 0;
  try {
    await guild.members.fetch();
    staffOnline = guild.members.cache.filter((member) =>
      (hasRoleGroup(member, db, 'staff') || hasRoleGroup(member, db, 'management'))
      && ['online', 'idle', 'dnd'].includes(member.presence?.status)).size;
  } catch (error) {
    console.error('Could not load online staff count:', error.message);
  }

  const activeSessions = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'").get().count;
  const today = new Date().toISOString().slice(0, 10);
  const eventsToday = db.prepare(`
    SELECT COUNT(*) AS count FROM events
    WHERE status = 'scheduled' AND starts_at >= ? AND starts_at < ?
  `).get(`${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`).count;

  return makeEmbed(config.EMBED_COLORS.management, '🕐 GV GR STAFF DUTY',
    'Clock in, clock out, or check who is currently on duty.\n\n'
    + '🟢 **Clock In**\nStart your GV GR staff shift.\n\n'
    + '🔴 **Clock Out**\nEnd your current staff shift.\n\n'
    + '📊 **Status**\nSee which staff members are currently on duty.\n\n'
    + '📈 **My Activity**\nView your staff hours and activity.')
    .addFields({
      name: '📋 STAFF INFORMATION',
      value: `🟢 Currently On Duty: **${onDuty.length}**\n👥 Staff Online: **${staffOnline}**\n🎙️ Active RP Sessions: **${activeSessions}**\n🎉 Events Today: **${eventsToday}**`,
    })
    .setFooter({ text: 'GV GR Staff • Use the buttons below to manage your shift' })
    .setTimestamp();
}

async function publishPanel(interaction, ctx) {
  const member = await fetchGuildMember(interaction.guild, interaction.user.id);
  if (!canRefreshStaffPanel(member, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'Only authorized management roles can post or refresh the staff panel.', ephemeral: true });
  }

  const channelId = getConfigValue(ctx.db, 'STAFF_ACTIVITY_CHANNEL_ID');
  if (!channelId) {
    return interaction.reply({ content: 'Set the staff activity channel in `config.js` or with `/staffconfig channel` first.', ephemeral: true });
  }

  let channel;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch (error) {
    console.error('Could not fetch the staff activity channel:', error.message);
  }
  if (!channel?.isTextBased() || !channel.send) {
    return interaction.reply({ content: 'I could not access the configured staff activity channel. Check the channel ID and my View Channel, Send Messages, and Embed Links permissions.', ephemeral: true });
  }

  const payload = { embeds: [await buildPanelEmbed(ctx.db, interaction.guild)], components: createPanelComponents() };
  let message;
  const savedMessageId = getConfigValue(ctx.db, 'panel_message');
  if (savedMessageId) {
    try {
      const previous = await channel.messages.fetch(savedMessageId);
      message = await previous.edit(payload);
    } catch {
      message = null;
    }
  }
  if (!message) message = await channel.send(payload);

  setConfigValue(ctx.db, 'panel_message', message.id);
  return interaction.reply({ content: `Staff duty panel ${savedMessageId ? 'refreshed' : 'posted'} in <#${channel.id}>.`, ephemeral: true });
}

function createStatusEmbeds(db) {
  const shifts = getOnDuty(db);
  const now = Date.now();
  const lines = shifts.map((shift) => {
    const started = Math.floor(new Date(shift.started_at).getTime() / 1000);
    const duration = formatDuration(Math.floor((now - started * 1000) / 1000));
    return `🟢 <@${shift.user_id}> • ${shift.role_name}\n   Started: <t:${started}:t>\n   Duration: ${duration}`;
  });
  const sections = [];
  let section = '';
  for (const line of lines.length ? lines : ['No staff members are currently on duty.']) {
    if (section.length + line.length > 3300) {
      sections.push(section);
      section = '';
    }
    section += `${section ? '\n\n' : ''}${line}`;
  }
  sections.push(section);
  return sections.map((description, index) => makeEmbed(config.EMBED_COLORS.info,
    `📊 GV GR STAFF STATUS${index ? ` • Page ${index + 1}` : ''}`,
    `${index === 0 ? '🟢 **CURRENTLY ON DUTY**\n\n' : ''}${description}${index === sections.length - 1 ? `\n\n**Total On Duty: ${shifts.length}**` : ''}`));
}

function createActivityEmbed(db, userId) {
  return createStaffStatsEmbed(db, userId, `<@${userId}>`);
}

async function safeEphemeralReply(interaction, payload, autoDeleteMs = 0) {
  const send = async () => {
    if (interaction.deferred) {
      return interaction.editReply(payload).catch(() => null);
    }
    if (interaction.replied) {
      return interaction.followUp({ ...payload, ephemeral: true }).catch(() => null);
    }
    return interaction.reply({ ...payload, ephemeral: true }).catch(() => null);
  };

  const result = await send();
  if (autoDeleteMs > 0 && result) {
    const deletionTimer = setTimeout(() => {
      interaction.deleteReply().catch(() => {});
    }, autoDeleteMs);
    deletionTimer.unref();
  }
  return result;
}

async function requireStaff(interaction, db) {
  const member = await fetchGuildMember(interaction.guild, interaction.user.id);
  const roleName = member && getStaffRoleName(member, db);
  if (roleName) return { member, roleName };
  await safeEphemeralReply(interaction, { content: 'This button is available to configured GV GR staff members only.' });
  return null;
}

async function handleClockButton(interaction, ctx) {
  const rawType = interaction.customId.slice('gv:'.length);
  const type = {
    'center:checkin': 'clock_in',
    'center:checkout': 'clock_out',
    'center:stats': 'activity',
  }[rawType] ?? rawType;
  await interaction.deferReply({ ephemeral: true });
  const staff = await requireStaff(interaction, ctx.db);
  if (!staff) return;

  if (type === 'clock_in') {
    const now = new Date().toISOString();
    const result = checkInStaff(ctx.db, {
      id: interaction.user.id,
      username: interaction.user.username,
      roleName: staff.roleName,
    }, now);
    if (result.unavailable) {
      return safeEphemeralReply(interaction, { content: `You cannot check in while your staff status is **${result.status}**${result.statusUntil ? ` until ${unixTime(result.statusUntil)}` : ''}.` });
    }
    if (result.alreadyOnDuty) {
      return safeEphemeralReply(interaction, { content: `You are already on duty. Your shift started ${unixTime(result.shift.started_at, 'R')}.` }, 120000);
    }

    const embed = makeEmbed(config.EMBED_COLORS.active, '🟢 Clocked In',
      `You are now on duty for GV GR.\nStarted: ${unixTime(now)}\nUse Clock Out when your shift ends.`);
    await logStaffAction(interaction.client, ctx.db, {
      embeds: [makeEmbed(config.EMBED_COLORS.active, '🟢 Staff Clocked In', `<@${interaction.user.id}> • ${staff.roleName}\nStarted: ${unixTime(now)}`)],
    });
    return safeEphemeralReply(interaction, { embeds: [embed] }, 60000);
  }

  if (type === 'clock_out') {
    const shift = checkOutStaff(ctx.db, interaction.user.id);
    if (!shift) return safeEphemeralReply(interaction, { content: 'You are not currently on duty, so there is no shift to clock out of.' }, 60000);

    await logStaffAction(interaction.client, ctx.db, {
      embeds: [makeEmbed(config.EMBED_COLORS.error, '🔴 Staff Clocked Out', `<@${interaction.user.id}> • ${shift.role_name}\nShift Length: **${formatDuration(shift.duration_seconds)}**\nStarted: ${unixTime(shift.started_at)}\nEnded: ${unixTime(shift.ended_at)}`)],
    });
    return safeEphemeralReply(interaction, createCheckoutReply(ctx.db, shift), 60000);
  }

  if (type === 'status') {
    const embeds = createStatusEmbeds(ctx.db);
    await safeEphemeralReply(interaction, { embeds: embeds.slice(0, 1) });
    for (const embed of embeds.slice(1)) await interaction.followUp({ embeds: [embed], ephemeral: true });
    return;
  }

  if (type === 'activity') {
    return safeEphemeralReply(interaction, { embeds: [createActivityEmbed(ctx.db, interaction.user.id)] });
  }

}

async function handleClockCommand(interaction, ctx) {
  if (interaction.commandName === 'staff-panel') return publishPanel(interaction, ctx);
  if (interaction.commandName === 'leaderboard') {
    const member = await fetchGuildMember(interaction.guild, interaction.user.id);
    if (!member || (!hasRoleGroup(member, ctx.db, 'staff') && !hasRoleGroup(member, ctx.db, 'management'))) {
      return interaction.reply({ content: 'The staff leaderboard is available to staff members only.', ephemeral: true });
    }

    const period = interaction.options.getString('period', true);
    const rankings = require('../services/activity').getLeaderboard(ctx.db, period);
    const medals = ['🥇', '🥈', '🥉'];
    const description = rankings.length
      ? rankings.map((row, index) => `${medals[index] ?? `**${index + 1}.**`} <@${row.user_id}> • **${formatDuration(row.total_seconds)}**`).join('\n')
      : 'No recorded shifts for this period yet.';
    const labels = { weekly: 'This Week', monthly: 'This Month', alltime: 'All Time' };
    return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, `🏆 Staff Leaderboard • ${labels[period]}`, description)], ephemeral: true });
  }
}

module.exports = {
  canRefreshStaffPanel,
  createActivityEmbed,
  createPanelComponents,
  createStatusEmbeds,
  handleClockButton,
  handleClockCommand,
};