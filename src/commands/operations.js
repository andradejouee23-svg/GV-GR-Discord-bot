const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('../../config');
const { formatDuration } = require('../utils/format');
const {
  fetchGuildMember,
  getConfigValue,
  getStaffRoleName,
  logStaffAction,
  makeEmbed,
  unixTime,
} = require('../utils/discord');
const { createEvent: createEventRecord, createSession, endSessionRecord, getCurrentSession, getUpcomingEvents } = require('../services/operations');
const { ensureManagement } = require('./staff');

function makeSessionButtons(sessionId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:session_join:${sessionId}`).setLabel('Join Session').setEmoji('🎙️').setStyle(ButtonStyle.Primary),
  )];
}

async function startSessionCommand(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const host = interaction.options.getUser('host', true);
  const { openSessionCreation } = require('./events');
  return openSessionCreation(interaction, ctx, {
    hostId: host.id,
    hostName: host.username,
    managementOnly: true,
  });
}

async function submitSessionModal(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;

  const hostId = interaction.customId.split(':').at(-1);
  const host = await fetchGuildMember(interaction.guild, hostId);
  if (!host || !getStaffRoleName(host, ctx.db)) {
    return interaction.reply({ content: 'The selected host no longer has a configured staff role.', ephemeral: true });
  }
  if (getCurrentSession(ctx.db)) {
    return interaction.reply({ content: 'An RP session was started while this form was open. Check `/session status`.', ephemeral: true });
  }

  const now = new Date().toISOString();
  const name = interaction.fields.getTextInputValue('name').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  if (!name) return interaction.reply({ content: 'Enter a session name before starting.', ephemeral: true });

  let session;
  try {
    session = createSession(ctx.db, {
      name,
      description,
      hostId: host.id,
      hostName: host.user.username,
      rpType: 'General RP',
      activity: description || name,
      expectedDuration: '2 hours',
      scheduledStartAt: now,
      timeZone: getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC',
      announcementChannelId: getConfigValue(ctx.db, 'SESSION_CHANNEL_ID'),
    }, now);
  } catch (error) {
    if (/already active or scheduled/i.test(error.message)) {
      return interaction.reply({ content: 'Another RP session was started while this form was open. Check `/session status`.', ephemeral: true });
    }
    throw error;
  }
  return require('./events').publishSession(interaction, ctx, session);
}

async function endSession(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const session = getCurrentSession(ctx.db);
  if (!session) return interaction.reply({ content: 'There is no active RP session to end.', ephemeral: true });
  const completed = endSessionRecord(ctx.db, session.id);
  if (!completed) return interaction.reply({ content: 'The scheduled session has not started yet, or the session already ended.', ephemeral: true });
  const { sessionEmbed, updateSessionAnnouncement, withSessionSettings } = require('./events');
  await updateSessionAnnouncement(interaction.client, completed, ctx.db);
  const duration = formatDuration(completed.duration_seconds);
  const embed = makeEmbed(config.EMBED_COLORS.info, '🎙️ RP Session Ended',
    `**${completed.name}** • Host: <@${completed.host_id}>\nStarted: ${unixTime(completed.actual_started_at ?? completed.started_at)}\nEnded: ${unixTime(completed.ended_at)}\nDuration: **${duration}**`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [embed] });
  return interaction.reply({ content: `Session ${completed.session_code ?? `#${completed.id}`} ended. Duration: **${duration}**.`, embeds: [sessionEmbed(withSessionSettings(completed, ctx.db))], ephemeral: true });
}

async function sessionStatus(interaction, ctx) {
  const current = getCurrentSession(ctx.db);
  const session = current && require('./events').getSession(ctx.db, current.id);
  if (!session) return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, '🎙️ RP Session Status', 'There is no active RP session.')], ephemeral: true });
  const { sessionEmbed, withSessionSettings } = require('./events');
  return interaction.reply({ embeds: [sessionEmbed(withSessionSettings({
    ...session,
    session_code: session.session_code ?? `#${session.id}`,
  }, ctx.db))], ephemeral: true });
}

async function createEvent(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const name = interaction.options.getString('name', true).trim();
  const datetime = interaction.options.getString('datetime', true).trim();
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(datetime)) {
    return interaction.reply({ content: 'Include a timezone in the date/time, such as `2026-10-04T18:00:00Z` or `2026-10-04T18:00:00-04:00`.', ephemeral: true });
  }
  const startsAtDate = new Date(datetime);
  if (!Number.isFinite(startsAtDate.getTime())) {
    return interaction.reply({ content: 'That date/time could not be read. Use an ISO 8601 date with a timezone.', ephemeral: true });
  }
  if (startsAtDate.getTime() <= Date.now()) {
    return interaction.reply({ content: 'Choose a future date/time for the event.', ephemeral: true });
  }

  const description = interaction.options.getString('description')?.trim() ?? '';
  const startsAt = startsAtDate.toISOString();
  const { getEventAnnouncementChannel, publishEventAnnouncement } = require('./events');
  await interaction.deferReply({ ephemeral: true });
  const { channel, error } = await getEventAnnouncementChannel(interaction, getConfigValue(ctx.db, 'EVENT_CHANNEL_ID'));
  if (error) return interaction.editReply({ content: error });
  const event = createEventRecord(ctx.db, {
    name, description, startsAt, eventType: 'Other', durationMinutes: 120,
    hostId: interaction.user.id, hostName: interaction.user.username,
    voiceChannelId: null, announcementChannelId: channel.id,
    timeZone: getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC',
  });
  const publication = await publishEventAnnouncement(interaction, ctx, event, channel);
  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.management, '🎉 Staff Event Created', `**${name}** • Host: <@${interaction.user.id}>\nWhen: ${unixTime(startsAt)}\n${event.event_code}`)],
  });
  return interaction.editReply({ content: publication.warning ? `${event.event_code} ${publication.warning}` : publication.message ? `${event.event_code} scheduled and announced.` : `Event ${event.event_code} was saved, but I could not announce it. Check the event channel and permissions; the event record was preserved.` });
}

async function listEvents(interaction, ctx) {
  const events = getUpcomingEvents(ctx.db);
  const description = events.length
    ? events.map((event) => `**${event.event_code ?? `#${event.id}`} • ${event.name}**\n${unixTime(event.starts_at)} • Host: <@${event.host_id}>${event.description ? `\n${event.description}` : ''}`).join('\n\n')
    : 'No upcoming events are scheduled.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, '🎉 Upcoming GV GR Events', description)], ephemeral: true });
}

async function cancelEvent(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const eventId = interaction.options.getInteger('id', true);
  const event = await require('./events').cancelScheduledEvent(interaction, ctx, eventId);
  if (!event) return interaction.reply({ content: `Scheduled event #${eventId} was not found or has already changed.`, ephemeral: true });
  return interaction.reply({ content: `${event.event_code ?? `#${event.id}`} cancelled.`, ephemeral: true });
}

async function handleOperationsCommand(interaction, ctx) {
  if (interaction.commandName === 'session') {
    const action = interaction.options.getSubcommand();
    if (action === 'start') return startSessionCommand(interaction, ctx);
    if (action === 'end') return endSession(interaction, ctx);
    return sessionStatus(interaction, ctx);
  }
  if (interaction.commandName === 'event') {
    const action = interaction.options.getSubcommand();
    if (action === 'create') return createEvent(interaction, ctx);
    if (action === 'cancel') return cancelEvent(interaction, ctx);
    return listEvents(interaction, ctx);
  }
  return null;
}

async function handleSessionJoin(interaction, ctx, sessionId) {
  const member = await fetchGuildMember(interaction.guild, interaction.user.id);
  if (!member || !getStaffRoleName(member, ctx.db)) {
    return interaction.reply({ content: 'Joining RP sessions is available to configured staff members only.', ephemeral: true });
  }
  const session = ctx.db.prepare("SELECT id FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) return interaction.reply({ content: 'This RP session has ended or is no longer available.', ephemeral: true });
  const result = ctx.db.prepare(`
    INSERT OR IGNORE INTO session_participants (session_id, user_id, username, joined_at)
    VALUES (?, ?, ?, ?)
  `).run(sessionId, interaction.user.id, interaction.user.username, new Date().toISOString());
  return interaction.reply({ content: result.changes ? 'You joined the RP session.' : 'You are already marked as participating in this session.', ephemeral: true });
}

module.exports = {
  handleOperationsCommand,
  handleSessionJoin,
  makeSessionButtons,
  submitSessionModal,
};