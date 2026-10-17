const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ChannelSelectMenuBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
const sharp = require('sharp');
const { randomUUID } = require('node:crypto');
const { DateTime } = require('luxon');
const config = require('../../config');
const {
  EVENT_TYPES,
  RP_TYPES,
  claimEventReminder,
  createDraft,
  createEvent,
  createSession,
  deleteDraft,
  editEvent,
  finishEventReminder,
  formatDurationMinutes,
  getDraft,
  getDueEventReminders,
  parseDurationMinutes,
  parseStartAt,
  recordEventHistory,
  setEventAttendance,
  setSessionParticipation,
  updateDraft,
} = require('../services/operations');
const {
  fetchGuildMember,
  getConfigValue,
  getInteractionMember,
  getStaffRoleName,
  logStaffAction,
  makeEmbed,
  unixTime,
} = require('../utils/discord');
const { formatDuration } = require('../utils/format');

function isManagement(...args) {
  return require('./staffCenter').isManagement(...args);
}

function isStaff(...args) {
  return require('./staffCenter').isStaff(...args);
}

const COLORS = {
  'Police RP': '#2F80ED',
  'Fire/EMS RP': '#E74C3C',
  'DOT RP': '#E3A008',
  'Government RP': '#287A68',
  'Weather/Emergency': '#52616B',
  'Emergency RP': '#52616B',
  'Business RP': '#725A41',
  'Community Event': '#287A68',
  'General RP': '#287A68',
  Other: '#287A68',
};
const ICONS = {
  'Police RP': '🚔', 'Fire/EMS RP': '🚒', 'DOT RP': '🚧', 'Government RP': '🏛️',
  'Weather/Emergency': '🌪️', 'Emergency RP': '🌪️', 'Business RP': '🏢',
  'Community Event': '🎉', 'General RP': '🌆', Other: '🎭',
};

function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function modalText(id, label, style = TextInputStyle.Short, required = true, max = 100, placeholder = '') {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
    .setRequired(required).setMaxLength(max);
  if (placeholder) input.setPlaceholder(placeholder);
  return input;
}

function createEventBasicsModal(draftId, timeZone = 'UTC') {
  return new ModalBuilder().setCustomId(`gv:event:create:${draftId}:basics`).setTitle('Schedule a GV GR Event')
    .addComponents(
      row(modalText('name', 'Event name', TextInputStyle.Short, true, 100, 'Night Patrol RP')),
      row(modalText('date', `Date (${timeZone})`, TextInputStyle.Short, true, 40, 'October 4, 2026 or 10/04/2026')),
      row(modalText('time', `Start time (${timeZone})`, TextInputStyle.Short, true, 20, '6:30 PM')),
      row(modalText('duration', 'Duration', TextInputStyle.Short, true, 20, '2 hours')),
    );
}

function createEventDescriptionModal(draftId) {
  return new ModalBuilder().setCustomId(`gv:event:create:${draftId}:description`).setTitle('Event Description')
    .addComponents(row(modalText('description', 'What will happen during the event?', TextInputStyle.Paragraph, true, 1000)));
}

function createSessionModal(draftId, timeZone = 'UTC') {
  return new ModalBuilder().setCustomId(`gv:rp:create:${draftId}`).setTitle('Start a GV GR RP Session')
    .addComponents(
      row(modalText('name', 'RP session name', TextInputStyle.Short, true, 100, 'Friday Night Greenville RP')),
      row(modalText('description', 'Session description', TextInputStyle.Paragraph, true, 1000)),
      row(modalText('date', `Scheduled date (${timeZone})`, TextInputStyle.Short, true, 40, 'October 4, 2026')),
      row(modalText('time', `Scheduled start time (${timeZone})`, TextInputStyle.Short, true, 20, '6:30 PM')),
    );
}

function createSessionDetailsModal(draftId) {
  return new ModalBuilder().setCustomId(`gv:rp:create:${draftId}:details`).setTitle('Session Details')
    .addComponents(
      row(modalText('duration', 'Expected duration', TextInputStyle.Short, true, 30, '2 hours')),
      row(modalText('activity', 'Main activity', TextInputStyle.Paragraph, true, 1000)),
      row(modalText('image_url', 'Optional banner image URL (HTTPS)', TextInputStyle.Short, false, 500)),
    );
}

function typeSelect(customId, placeholder, values) {
  return row(new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder)
    .addOptions(values.map((value) => ({ label: value, value, emoji: ICONS[value] ?? '🎭' }))));
}

function simpleModal(customId, title, fields) {
  return new ModalBuilder().setCustomId(customId).setTitle(title)
    .addComponents(...fields.map((field) => row(modalText(...field))));
}

function safeText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

async function makeGraphic(type, title, label = 'GV GR EVENT') {
  const color = COLORS[type] ?? COLORS.Other;
  const icon = ICONS[type] ?? ICONS.Other;
  const titleLine = safeText(title.slice(0, 38));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="420" viewBox="0 0 1200 420"><rect width="1200" height="420" fill="#172321"/><path d="M0 310 430 0h290L300 420H0zm740 110L1050 0h150v117L890 420z" fill="${color}"/><path d="M0 0h1200v14H0z" fill="#f5f3ed"/><circle cx="1020" cy="210" r="145" fill="#172321" stroke="#f5f3ed" stroke-width="8"/><text x="1020" y="258" text-anchor="middle" font-size="124" font-family="sans-serif">${icon}</text><text x="72" y="125" fill="#f5f3ed" font-size="30" font-weight="700" font-family="sans-serif" letter-spacing="4">${safeText(label)}</text><text x="72" y="235" fill="#ffffff" font-size="64" font-weight="800" font-family="sans-serif">${titleLine}</text><text x="76" y="310" fill="#d3ddd8" font-size="24" font-family="sans-serif">GREENVILLE ROLEPLAY  •  OFFICIAL COMMUNITY EVENT</text></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new AttachmentBuilder(png, { name: 'gv-gr-event.png' });
}

function eventEmbed(event) {
  const timeZone = event.time_zone || 'UTC';
  const localDate = DateTime.fromISO(event.starts_at, { zone: 'utc' }).setZone(timeZone);
  const timestamp = Math.floor(localDate.toSeconds());
  const eventType = event.event_type || 'Other';
  const description = [
    `**${event.name.toUpperCase()}**`,
    `${ICONS[eventType] ?? '🎉'} **${eventType}**`,
    '',
    `📅 **Date**\n${localDate.toLocaleString(DateTime.DATE_FULL)}`,
    `⏰ **Start Time**\n${localDate.toLocaleString(DateTime.TIME_SIMPLE)} ${localDate.offsetNameShort} (${timeZone})`,
    `⌛ **Duration**\n${formatDurationMinutes(event.duration_minutes)}`,
    `🎤 **Host**\n<@${event.host_id}>`,
    `🔊 **Voice Channel**\n<#${event.voice_channel_id}>`,
    `🆔 **Event ID**\n\`${event.event_code}\``,
    '',
    `📝 **Description**\n${event.description}`,
  ].join('\n');
  return makeEmbed(config.EMBED_COLORS.management, '🎉 GV GR EVENT', description)
    .setColor(COLORS[eventType] ?? COLORS.Other)
    .setImage('attachment://gv-gr-event.png')
    .setFooter({ text: 'GV GR • Official Roleplay Event' })
    .setTimestamp(timestamp * 1000);
}

function eventAnnouncementComponents(eventId, disabled = false) {
  return [row(
    new ButtonBuilder().setCustomId(`gv:event:rsvp:${eventId}:going`).setLabel('Going').setEmoji('🟢').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gv:event:rsvp:${eventId}:cant_go`).setLabel("Can't Go").setEmoji('🔴').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gv:event:details:${eventId}`).setLabel('Event Details').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  )];
}

function eventManageComponents() {
  return [
    row(
      new ButtonBuilder().setCustomId('gv:center:event:create').setLabel('Create Event').setEmoji('➕').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:center:event:upcoming').setLabel('Upcoming Events').setEmoji('📅').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gv:center:event:edit').setLabel('Edit Event').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:center:event:cancel').setLabel('Cancel Event').setEmoji('❌').setStyle(ButtonStyle.Danger),
    ),
    row(
      new ButtonBuilder().setCustomId('gv:center:event:attendance').setLabel('Attendance').setEmoji('👥').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:center:event:history').setLabel('Event History').setEmoji('📋').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:center:event:host').setLabel('Change Host').setEmoji('🎤').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function channelSelectionComponents(kind, draftId, data = {}) {
  const selected = kind === 'event' ? data.announcementChannelId && data.voiceChannelId : data.voiceChannelId;
  const selectors = kind === 'event'
    ? [
      row(new ChannelSelectMenuBuilder().setCustomId(`gv:event:channel:${draftId}:announce`).setPlaceholder('Select announcement channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
      row(new ChannelSelectMenuBuilder().setCustomId(`gv:event:channel:${draftId}:voice`).setPlaceholder('Select event voice channel').setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)),
    ]
    : [row(new ChannelSelectMenuBuilder().setCustomId(`gv:rp:channel:${draftId}:voice`).setPlaceholder('Select session voice channel').setChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice))];
  selectors.push(row(new ButtonBuilder().setCustomId(`gv:${kind === 'event' ? 'event' : 'rp'}:publish:${draftId}`)
    .setLabel(kind === 'event' ? 'Publish Event' : 'Start Session').setEmoji(kind === 'event' ? '📢' : '🎮')
    .setStyle(ButtonStyle.Success).setDisabled(!selected)));
  return selectors;
}

function normalizeEventCode(value) {
  const code = value.trim().toUpperCase();
  return /^GV-EV-\d{4,}$/.test(code) ? code : null;
}

function createEventIdModal(action) {
  return simpleModal(`gv:event:manage:${action}`, `${action[0].toUpperCase()}${action.slice(1)} GV GR Event`, [
    ['event_id', 'Event ID (example: GV-EV-0001)', TextInputStyle.Short, true, 20],
  ]);
}

function createUpcomingEmbed(db) {
  const events = db.prepare(`SELECT event_code, name, event_type, host_id, starts_at, duration_minutes
    FROM events WHERE status = 'scheduled' AND starts_at >= ? ORDER BY starts_at LIMIT 10`).all(new Date().toISOString());
  const description = events.length ? events.map((event) =>
    `**${event.event_code} • ${event.name}**\n${ICONS[event.event_type] ?? '🎉'} ${event.event_type} • <t:${Math.floor(Date.parse(event.starts_at) / 1000)}:F> • ${formatDurationMinutes(event.duration_minutes)}\nHost: <@${event.host_id}>`)
    .join('\n\n') : 'No upcoming events are scheduled.';
  return makeEmbed(config.EMBED_COLORS.info, '📅 UPCOMING GV GR EVENTS', description)
    .setFooter({ text: 'Select Going or Can’t Go on an event announcement to update your RSVP.' });
}

function createEventHistoryEmbed(db) {
  const events = db.prepare(`SELECT event_code, name, event_type, host_id, starts_at, status, duration_minutes
    FROM events ORDER BY id DESC LIMIT 12`).all();
  const description = events.length ? events.map((event) =>
    `**${event.event_code} • ${event.name}**\n${event.event_type} • <t:${Math.floor(Date.parse(event.starts_at) / 1000)}:F> • ${event.status.toUpperCase()}\nHost: <@${event.host_id}> • ${formatDurationMinutes(event.duration_minutes)}`)
    .join('\n\n') : 'No event history is available.';
  return makeEmbed(config.EMBED_COLORS.management, '📋 GV GR EVENT HISTORY', description);
}

async function openEventPanel(interaction, ctx) {
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'The Events panel is available to configured staff only.', ephemeral: true });
  }
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.management, '📅 GV GR EVENTS',
    'Create and manage official events, review RSVPs, or browse the schedule. Public members can respond directly on each announcement.')],
  components: eventManageComponents(), ephemeral: true });
}

async function openRpControls(interaction, ctx) {
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'RP controls are available to configured staff only.', ephemeral: true });
  }
  const sessions = ctx.db.prepare("SELECT id, session_code, name, host_id, rp_type, lifecycle_status FROM sessions WHERE status = 'active' ORDER BY id DESC LIMIT 10").all();
  if (!sessions.length) return interaction.reply({
    embeds: [makeEmbed(config.EMBED_COLORS.info, '🎛️ RP SESSION CONTROLS', 'There are no active RP sessions.')],
    components: [row(new ButtonBuilder().setCustomId('gv:center:rp:history').setLabel('Session History').setEmoji('📚').setStyle(ButtonStyle.Secondary))],
    ephemeral: true,
  });
  const description = sessions.map((session) => `**${session.session_code} • ${session.name}**\n${session.rp_type} • ${session.lifecycle_status.toUpperCase()} • Host: <@${session.host_id}>`).join('\n\n');
  const rows = sessions.slice(0, 5).map((session) => row(new ButtonBuilder()
    .setCustomId(`gv:rp:info:${session.id}`).setLabel(`Control ${session.session_code}`).setStyle(ButtonStyle.Secondary)));
  rows.push(row(new ButtonBuilder().setCustomId('gv:center:rp:history').setLabel('Session History').setEmoji('📚').setStyle(ButtonStyle.Secondary)));
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.management, '🎛️ RP SESSION CONTROLS', description)], components: rows, ephemeral: true });
}

async function openSessionCreation(interaction, ctx, { hostId = interaction.user.id, hostName = interaction.user.username, managementOnly = false } = {}) {
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'Starting an official RP session is available to configured staff only.', ephemeral: true });
  }
  if (managementOnly && !isManagement(member, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'Management access is required to start a session for another host.', ephemeral: true });
  }
  const host = await fetchGuildMember(interaction.guild, hostId);
  if (!host || !getStaffRoleName(host, ctx.db) || !isStaff(host, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'The session host must be a current member of a configured staff role.', ephemeral: true });
  }
  if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) {
    return interaction.reply({ content: 'An RP session is already active. Open RP Controls to manage it.', ephemeral: true });
  }
  const timeZone = getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC';
  const draftId = createDraft(ctx.db, 'session_drafts', interaction.user.id, {
    hostId, hostName, timeZone, managementOnly,
  });
  return interaction.showModal(createSessionModal(draftId, timeZone));
}

function createSessionHistoryEmbed(db) {
  const rows = db.prepare(`SELECT s.session_code, s.name, s.host_id, s.rp_type, s.status, s.lifecycle_status,
      s.started_at, s.ended_at, s.duration_seconds, s.expected_duration,
      (SELECT COUNT(*) FROM session_participants p WHERE p.session_id = s.id) AS participant_count
    FROM sessions s WHERE s.status = 'completed' ORDER BY s.ended_at DESC, s.id DESC LIMIT 10`).all();
  const description = rows.length ? rows.map((session) =>
    `**\`${session.session_code}\` • ${session.name}**\n${session.rp_type} • ${session.lifecycle_status.toUpperCase()}\nHost: <@${session.host_id}> • <t:${Math.floor(Date.parse(session.started_at) / 1000)}:D>\nDuration: ${session.duration_seconds == null ? session.expected_duration || 'Not recorded' : formatDuration(session.duration_seconds)} • ${session.participant_count} participant${session.participant_count === 1 ? '' : 's'}`)
    .join('\n\n') : 'No completed RP sessions yet.';
  return makeEmbed(config.EMBED_COLORS.info, '📚 GV GR RP SESSION HISTORY', description);
}

async function handleStaffCenterControl(interaction, ctx) {
  const id = interaction.customId;
  if (id === 'gv:center:events') return openEventPanel(interaction, ctx);
  if (id === 'gv:center:rp:start') return openSessionCreation(interaction, ctx);
  if (id === 'gv:center:rp:controls') return openRpControls(interaction, ctx);
  if (id === 'gv:center:rp:history') {
    const member = await getInteractionMember(interaction);
    if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Session history is available to configured staff only.', ephemeral: true });
    return interaction.reply({ embeds: [createSessionHistoryEmbed(ctx.db)], ephemeral: true });
  }
  if (!id.startsWith('gv:center:event:')) return null;
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'The Events panel is available to configured staff only.', ephemeral: true });
  const action = id.split(':').at(-1);
  if (action === 'upcoming') return interaction.reply({ embeds: [createUpcomingEmbed(ctx.db)], ephemeral: true });
  if (action === 'history') {
    if (!isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required to view event history.', ephemeral: true });
    return interaction.reply({ embeds: [createEventHistoryEmbed(ctx.db)], ephemeral: true });
  }
  if (['edit', 'cancel', 'attendance', 'host'].includes(action)) {
    if (!isManagement(member, interaction.guild, ctx.db)) {
      return interaction.reply({ content: 'Management access is required for this event action.', ephemeral: true });
    }
    return interaction.showModal(createEventIdModal(action));
  }
  if (action === 'create') {
    const timeZone = getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC';
    const draftId = createDraft(ctx.db, 'event_drafts', interaction.user.id, { hostId: interaction.user.id, hostName: interaction.user.username, timeZone });
    return interaction.showModal(createEventBasicsModal(draftId, timeZone));
  }
  return interaction.reply({ content: 'That Events control is not recognized.', ephemeral: true });
}

function eventTimes(event) {
  const date = DateTime.fromISO(event.starts_at, { zone: 'utc' }).setZone(event.time_zone || 'UTC');
  const dateLabel = date.toFormat('MMMM d, yyyy');
  const timeLabel = date.toFormat('h:mm a');
  return { dateLabel, timeLabel };
}

function parseSessionStartAt(timeLabel, now = new Date(), timeZone = 'UTC') {
  const localNow = DateTime.fromJSDate(now).setZone(timeZone);
  if (!localNow.isValid) return null;
  const today = localNow.toFormat('yyyy-MM-dd');
  const parsedToday = parseStartAt(today, timeLabel, timeZone);
  if (!parsedToday) return null;
  const todayTimestamp = Date.parse(parsedToday);
  if (todayTimestamp > now.getTime()) return new Date(todayTimestamp).toISOString();
  const nextLocalDay = localNow.plus({ days: 1 }).toFormat('yyyy-MM-dd');
  return parseStartAt(nextLocalDay, timeLabel, timeZone);
}

async function submitEventModal(interaction, ctx) {
  const parts = interaction.customId.split(':');
  const isCreate = parts[2] === 'create';
  const isManage = parts[2] === 'manage';
  const action = isCreate ? 'create' : isManage ? parts[3] : null;
  const token = parts[3];
  const step = parts[4];
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Configured staff access is required.', ephemeral: true });

  if (action === 'create' && step === 'basics') {
    const draft = getDraft(ctx.db, 'event_drafts', token, interaction.user.id);
    if (!draft) return interaction.reply({ content: 'This event form expired. Open Events and start again.', ephemeral: true });
    const name = interaction.fields.getTextInputValue('name').trim();
    const timeZone = draft.timeZone ?? getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC';
    const startsAt = parseStartAt(interaction.fields.getTextInputValue('date'), interaction.fields.getTextInputValue('time'), timeZone);
    const durationMinutes = parseDurationMinutes(interaction.fields.getTextInputValue('duration'));
    if (!name) return interaction.reply({ content: 'Enter an event name.', ephemeral: true });
    if (!startsAt) return interaction.reply({ content: `Date/time is invalid in ${timeZone}. Check the date and local time, including daylight-saving transitions.`, ephemeral: true });
    if (Date.parse(startsAt) <= Date.now()) return interaction.reply({ content: `Choose a future date and time in ${timeZone}.`, ephemeral: true });
    if (!durationMinutes) return interaction.reply({ content: 'Duration must be a value such as `2 hours` or `90 minutes` (up to 7 days).', ephemeral: true });
    updateDraft(ctx.db, 'event_drafts', token, interaction.user.id, { name, startsAt, durationMinutes, timeZone });
    return interaction.reply({ content: `Choose an event type for **${name}**.`, components: [typeSelect(`gv:event:type:${token}`, 'Select event type', EVENT_TYPES)], ephemeral: true });
  }

  if (action === 'create' && step === 'description') {
    const draft = updateDraft(ctx.db, 'event_drafts', token, interaction.user.id, {
      description: interaction.fields.getTextInputValue('description').trim(),
    });
    if (!draft) return interaction.reply({ content: 'This event form expired. Open Events and start again.', ephemeral: true });
    return interaction.reply({ content: `Select the public announcement channel and event voice channel for **${draft.name}**. Times are stored in UTC and shown in ${draft.timeZone}.`,
      components: channelSelectionComponents('event', token, draft), ephemeral: true });
  }

  if (isManage && action === 'edit') {
    if (!isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required.', ephemeral: true });
    const eventCode = normalizeEventCode(interaction.fields.getTextInputValue('event_id'));
    const event = eventCode && ctx.db.prepare("SELECT * FROM events WHERE event_code = ? AND status = 'scheduled'").get(eventCode);
    if (!event) return interaction.reply({ content: 'No scheduled event was found for that Event ID.', ephemeral: true });
    const times = eventTimes(event);
    return interaction.showModal(new ModalBuilder().setCustomId(`gv:event:edit:${event.id}`).setTitle(`Edit ${event.event_code}`)
      .addComponents(
        row(modalText('name', 'Event name', TextInputStyle.Short, true, 100).setValue(event.name)),
        row(modalText('type', 'Event type', TextInputStyle.Short, true, 40, EVENT_TYPES.join(', ')).setValue(event.event_type)),
        row(modalText('date', `Date (${event.time_zone || 'UTC'})`, TextInputStyle.Short, true, 40).setValue(times.dateLabel)),
        row(modalText('time', `Start time (${event.time_zone || 'UTC'})`, TextInputStyle.Short, true, 20).setValue(times.timeLabel)),
        row(modalText('duration', 'Duration', TextInputStyle.Short, true, 20).setValue(formatDurationMinutes(event.duration_minutes))),
      ));
  }

  if (isManage && ['cancel', 'attendance', 'host'].includes(action)) {
    if (!isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required for event management and attendance.', ephemeral: true });
    const eventCode = normalizeEventCode(interaction.fields.getTextInputValue('event_id'));
    const event = eventCode && ctx.db.prepare('SELECT * FROM events WHERE event_code = ?').get(eventCode);
    if (!event) return interaction.reply({ content: 'No event was found for that Event ID.', ephemeral: true });
    if (action === 'attendance') {
      const attendance = ctx.db.prepare(`SELECT response, username, user_id FROM event_attendance WHERE event_id = ? ORDER BY response, username`).all(event.id);
      const going = attendance.filter((entry) => entry.response === 'going');
      const unavailable = attendance.filter((entry) => entry.response === 'cant_go');
      const list = (entries) => entries.length ? entries.slice(0, 30).map((entry) => `<@${entry.user_id}>`).join('\n') : 'No responses yet.';
      return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, `👥 EVENT ATTENDANCE • ${event.event_code}`,
        `**${event.name}**\n\n🟢 **Going (${going.length})**\n${list(going)}\n\n🔴 **Can’t Go (${unavailable.length})**\n${list(unavailable)}`)], ephemeral: true });
    }
    if (action === 'cancel') {
      if (!isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required.', ephemeral: true });
      if (event.status !== 'scheduled') return interaction.reply({ content: `${event.event_code} is already ${event.status}.`, ephemeral: true });
      const now = new Date().toISOString();
      ctx.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'").run(event.id);
      recordEventHistory(ctx.db, event.id, interaction.user.id, 'cancelled', {}, now);
      const embed = makeEmbed(config.EMBED_COLORS.error, '❌ GV GR EVENT CANCELLED', `**${event.name}** • \`${event.event_code}\`\nCancelled by <@${interaction.user.id}>.`);
      if (event.announcement_channel_id && event.announcement_message_id) {
        try {
          const channel = await interaction.client.channels.fetch(event.announcement_channel_id);
          const message = await channel.messages.fetch(event.announcement_message_id);
          await message.edit({ embeds: [embed], components: eventAnnouncementComponents(event.id, true) });
        } catch (error) { console.error(`Could not update cancelled event ${event.event_code}:`, error.message); }
      }
      await logStaffAction(interaction.client, ctx.db, { embeds: [embed] });
      return interaction.reply({ content: `${event.event_code} has been cancelled.`, ephemeral: true });
    }
    if (!isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required to change an event host.', ephemeral: true });
    return interaction.reply({
      content: `Select a configured staff member to host **${event.event_code} • ${event.name}**.`,
      components: [row(new UserSelectMenuBuilder()
        .setCustomId(`gv:event:host_select:${event.id}`)
        .setPlaceholder('Select the new staff host'))],
      ephemeral: true,
    });
  }
  return interaction.reply({ content: 'This event form is not recognized.', ephemeral: true });
}

async function submitEventEdit(interaction, ctx) {
  const member = await getInteractionMember(interaction);
  if (!member || !isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required to edit events.', ephemeral: true });
  const eventId = Number(interaction.customId.split(':').at(-1));
  const current = ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!current || current.status !== 'scheduled') return interaction.reply({ content: 'This event is no longer scheduled.', ephemeral: true });
  const timeZone = current.time_zone || getConfigValue(ctx.db, 'TIME_ZONE') || config.TIME_ZONE || 'UTC';
  const startsAt = parseStartAt(interaction.fields.getTextInputValue('date'), interaction.fields.getTextInputValue('time'), timeZone);
  const durationMinutes = parseDurationMinutes(interaction.fields.getTextInputValue('duration'));
  const eventType = interaction.fields.getTextInputValue('type').trim();
  if (!startsAt || Date.parse(startsAt) <= Date.now()) return interaction.reply({ content: `Enter a valid future date and time in ${timeZone}; check for daylight-saving transitions.`, ephemeral: true });
  if (!durationMinutes) return interaction.reply({ content: 'Enter a duration such as `2 hours` or `90 minutes`.', ephemeral: true });
  if (!EVENT_TYPES.includes(eventType)) return interaction.reply({ content: `Choose an event type from: ${EVENT_TYPES.join(', ')}.`, ephemeral: true });
  const event = editEvent(ctx.db, current.event_code, {
    name: interaction.fields.getTextInputValue('name').trim(),
    event_type: eventType,
    starts_at: startsAt,
    duration_minutes: durationMinutes,
    time_zone: timeZone,
  }, interaction.user.id);
  const embed = eventEmbed(event);
  if (event.announcement_channel_id && event.announcement_message_id) {
    try {
      const channel = await interaction.client.channels.fetch(event.announcement_channel_id);
      const message = await channel.messages.fetch(event.announcement_message_id);
      await message.edit({ embeds: [embed], files: [await makeGraphic(event.event_type, event.name)], components: eventAnnouncementComponents(event.id) });
    } catch (error) { console.error(`Could not update event announcement ${event.event_code}:`, error.message); }
  }
  const log = makeEmbed(config.EMBED_COLORS.management, '✏️ GV GR EVENT EDITED', `**${event.name}** • \`${event.event_code}\`\nEdited by <@${interaction.user.id}>\nNew date: <t:${Math.floor(Date.parse(event.starts_at) / 1000)}:F>`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [log] });
  return interaction.reply({ content: `${event.event_code} has been updated.`, ephemeral: true });
}

async function submitEventHost(interaction, ctx) {
  const member = await getInteractionMember(interaction);
  if (!member || !isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required.', ephemeral: true });
  const eventId = Number(interaction.customId.split(':').at(-1));
  const event = ctx.db.prepare("SELECT * FROM events WHERE id = ? AND status = 'scheduled'").get(eventId);
  if (!event) return interaction.reply({ content: 'This scheduled event could not be found.', ephemeral: true });
  const hostId = interaction.values?.[0]
    ?? interaction.fields.getTextInputValue('host_id').replace(/[<@!>]/g, '').trim();
  const host = /^\d{17,20}$/.test(hostId) ? await fetchGuildMember(interaction.guild, hostId) : null;
  if (!host || !getStaffRoleName(host, ctx.db) || !isStaff(host, interaction.guild, ctx.db)) return interaction.reply({ content: 'The host must be a current member of a configured staff role.', ephemeral: true });
  editEvent(ctx.db, event.event_code, { host_id: hostId, host_name: host.user.username }, interaction.user.id);
  const updated = ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(event.id);
  if (updated.announcement_channel_id && updated.announcement_message_id) {
    try {
      const channel = await interaction.client.channels.fetch(updated.announcement_channel_id);
      const message = await channel.messages.fetch(updated.announcement_message_id);
      await message.edit({ embeds: [eventEmbed(updated)], files: [await makeGraphic(updated.event_type, updated.name)] });
    } catch (error) { console.error(`Could not update event host ${updated.event_code}:`, error.message); }
  }
  const log = makeEmbed(config.EMBED_COLORS.management, '🎤 GV GR EVENT HOST CHANGED', `\`${updated.event_code}\` • ${updated.name}\nPrevious host: <@${event.host_id}>\nNew host: <@${hostId}>\nChanged by: <@${interaction.user.id}>`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [log] });
  return interaction.reply({ content: `Host updated for ${updated.event_code}.`, ephemeral: true });
}

async function submitEventDraft(interaction, ctx, draftId) {
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Configured staff access is required.', ephemeral: true });
  const draft = getDraft(ctx.db, 'event_drafts', draftId, interaction.user.id);
  if (!draft?.voiceChannelId || !draft?.announcementChannelId) return interaction.reply({ content: 'Select both an announcement channel and a voice channel before publishing.', ephemeral: true });
  const channel = await interaction.client.channels.fetch(draft.announcementChannelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.send) return interaction.reply({ content: 'The selected announcement channel is no longer available.', ephemeral: true });
  const event = createEvent(ctx.db, {
    name: draft.name, eventType: draft.eventType, startsAt: draft.startsAt,
    durationMinutes: draft.durationMinutes, description: draft.description, timeZone: draft.timeZone,
    hostId: interaction.user.id, hostName: interaction.user.username,
    voiceChannelId: draft.voiceChannelId, announcementChannelId: draft.announcementChannelId,
  });
  let message;
  try {
    message = await channel.send({ embeds: [eventEmbed(event)], files: [await makeGraphic(event.event_type, event.name)],
      components: eventAnnouncementComponents(event.id), allowedMentions: { users: [event.host_id] } });
  } catch (error) {
    console.error(`Could not announce event ${event.event_code}:`, error.message);
  }
  if (message) ctx.db.prepare('UPDATE events SET announcement_message_id = ? WHERE id = ?').run(message.id, event.id);
  deleteDraft(ctx.db, 'event_drafts', draftId);
  const log = makeEmbed(config.EMBED_COLORS.management, '🎉 GV GR EVENT CREATED', `**${event.name}** • \`${event.event_code}\`\nHost: <@${event.host_id}>\nDate: <t:${Math.floor(Date.parse(event.starts_at) / 1000)}:F>\nCreated by: <@${interaction.user.id}>`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [log] });
  return interaction.reply({ content: message ? `**${event.event_code}** is scheduled and announced in <#${event.announcement_channel_id}>.` :
    `**${event.event_code}** is saved, but its announcement could not be sent. Check the bot's channel permissions.`, ephemeral: true });
}

async function submitSessionDraft(interaction, ctx, draftId) {
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Configured staff access is required.', ephemeral: true });
  const draft = getDraft(ctx.db, 'session_drafts', draftId, interaction.user.id);
  if (!draft?.voiceChannelId) return interaction.reply({ content: 'Select a voice channel before starting the session.', ephemeral: true });
  if (!RP_TYPES.includes(draft.rpType)) return interaction.reply({ content: `Choose an RP type from: ${RP_TYPES.join(', ')}.`, ephemeral: true });
  const scheduledStartAt = draft.scheduledStartAt;
  if (!scheduledStartAt || !Number.isFinite(Date.parse(scheduledStartAt))) return interaction.reply({ content: 'The session start time is invalid. Reopen the Staff Center and try again.', ephemeral: true });
  if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) return interaction.reply({ content: 'Another RP session is already active.', ephemeral: true });
  const channelId = getConfigValue(ctx.db, 'SESSION_CHANNEL_ID');
  if (!channelId) return interaction.reply({ content: 'Configure SESSION_CHANNEL_ID with `/staffconfig channel` before starting a session.', ephemeral: true });
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.send) return interaction.reply({ content: 'The configured RP announcement channel is unavailable.', ephemeral: true });
  const host = await fetchGuildMember(interaction.guild, draft.hostId ?? interaction.user.id);
  if (!host || !getStaffRoleName(host, ctx.db) || !isStaff(host, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'The selected session host no longer has a configured staff role.', ephemeral: true });
  }
  const session = createSession(ctx.db, {
    ...draft,
    hostId: host.id,
    hostName: host.user.username,
    scheduledStartAt,
    timeZone: draft.timeZone,
    announcementChannelId: channelId,
    description: draft.description,
    imageUrl: draft.imageUrl || null,
  });
  ctx.db.prepare('UPDATE sessions SET session_start_label = ? WHERE id = ?').run(draft.startLabel, session.id);
  const displaySession = withSessionSettings(session, ctx.db);
  const embed = sessionEmbed(displaySession, draft.startLabel);
  let message;
  try {
    message = await channel.send({ embeds: [embed], files: displaySession.image_url ? [] : [await makeGraphic(session.rp_type, session.name, 'GV GR RP SESSION')],
      components: sessionPublicComponents(session.id, false, displaySession.join_url), allowedMentions: { users: [session.host_id] } });
  } catch (error) { console.error(`Could not announce session ${session.session_code}:`, error.message); }
  if (message) ctx.db.prepare('UPDATE sessions SET channel_id = ?, message_id = ? WHERE id = ?').run(message.channelId, message.id, session.id);
  deleteDraft(ctx.db, 'session_drafts', draftId);
  const log = makeEmbed(config.EMBED_COLORS.management, `🎮 GV GR RP SESSION ${session.lifecycle_status === 'scheduled' ? 'SCHEDULED' : 'STARTED'}`, `**${session.name}** • \`${session.session_code}\`\nHost: <@${session.host_id}>\nType: ${session.rp_type}\nStart: <t:${Math.floor(Date.parse(session.started_at) / 1000)}:F>`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [log] });
  return interaction.reply({ content: message ? `**${session.session_code}** ${session.lifecycle_status === 'scheduled' ? 'is scheduled for' : 'is live in'} <#${channelId}>.` : `**${session.session_code}** was saved, but the announcement could not be sent.`, ephemeral: true });
}

function withSessionSettings(session, db) {
  return {
    ...session,
    join_code: getConfigValue(db, 'SESSION_JOIN_CODE') ?? '',
    join_url: getConfigValue(db, 'SESSION_JOIN_URL') ?? '',
    image_url: session.image_url || getConfigValue(db, 'SESSION_DEFAULT_IMAGE_URL') || '',
  };
}

function sessionEmbed(session, startLabel = session.session_start_label) {
  const scheduledStart = session.scheduled_start_at ?? session.started_at;
  const actualStart = session.actual_started_at;
  const durationMinutes = parseDurationMinutes(session.expected_duration);
  const expectedEnd = durationMinutes ? new Date(Date.parse(actualStart ?? scheduledStart) + durationMinutes * 60_000) : null;
  const pauseNow = session.lifecycle_status === 'paused' && session.paused_at
    ? Math.max(0, Math.floor((Date.now() - Date.parse(session.paused_at)) / 1000)) : 0;
  const elapsed = session.duration_seconds ?? (actualStart
    ? Math.max(0, Math.floor((Date.now() - Date.parse(actualStart)) / 1000) - (session.paused_seconds ?? 0) - pauseNow)
    : 0);
  const participants = session.participant_count ?? 1;
  const timeZone = session.time_zone || 'UTC';
  const localStart = DateTime.fromISO(scheduledStart, { zone: 'utc' }).setZone(timeZone);
  const status = session.lifecycle_status === 'scheduled'
    ? '🟡 **SESSION SCHEDULED**'
    : session.lifecycle_status === 'paused' ? '⏸️ **SESSION PAUSED**'
      : session.lifecycle_status === 'cancelled' ? '⚫ **SESSION CANCELLED**'
        : session.lifecycle_status === 'completed' ? '⚫ **SESSION ENDED**' : '🟢 **SESSION LIVE**';
  const joinSection = session.join_code
    ? `**Custom Server Join Code**\n\`\`\`\n${session.join_code}\n\`\`\`\n**Join Instructions**\n1. Open Greenville.\n2. Open the Custom Servers menu.\n3. Search for GV GR or enter the code above.\n4. Join the session.`
    : 'The Owner has not configured the Greenville custom-server join code yet.';
  const expectedEndText = expectedEnd ? `<t:${Math.floor(expectedEnd.getTime() / 1000)}:F>` : 'Not set';
  const actualStartText = actualStart ? unixTime(actualStart) : 'Not started yet';
  return makeEmbed(config.EMBED_COLORS.management, '🎮 GV GR RP SESSION',
    `**${session.name.toUpperCase()}**\n${status}\n\n${session.description ? `${session.description}\n\n` : ''}📅 **Scheduled Start**\n<t:${Math.floor(Date.parse(scheduledStart) / 1000)}:F> (${timeZone})\n🟢 **Actual Start**\n${actualStartText}\n⌛ **Expected End**\n${expectedEndText}\n⏱️ **Active Duration**\n${formatDuration(elapsed)}\n\n🎭 **Session Type**\n${session.rp_type}\n🎯 **Activity**\n${session.activity || 'Community roleplay'}\n🎤 **Host**\n<@${session.host_id}>\n🔊 **Voice Channel**\n${session.voice_channel_id ? `<#${session.voice_channel_id}>` : 'Not configured'}\n🆔 **Session ID**\n\`${session.session_code}\`\n👥 **Participants**\n${participants} joined\n\n${joinSection}${session.join_url ? `\n\n[Open Greenville](${session.join_url})` : ''}${session.ended_at ? `\n\n⏹️ **Ended:** ${unixTime(session.ended_at)}` : ''}`)
    .setColor(COLORS[session.rp_type] ?? COLORS.Other)
    .setImage(session.image_url || 'attachment://gv-gr-event.png')
    .setFooter({ text: `GV GR • ${session.rp_type} • ${session.lifecycle_status === 'scheduled' ? 'Scheduled' : formatDuration(elapsed)}` });
}

function sessionPublicComponents(sessionId, disabled = false, joinUrl = '') {
  const buttons = [
    new ButtonBuilder().setCustomId(`gv:rp:join:${sessionId}`).setLabel('Join Session').setEmoji('🟢').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gv:rp:leave:${sessionId}`).setLabel('Leave Session').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`gv:rp:info:${sessionId}`).setLabel('Session Info').setEmoji('📋').setStyle(ButtonStyle.Secondary),
  ];
  if (joinUrl && !disabled) buttons.push(new ButtonBuilder().setLabel('Open Greenville').setStyle(ButtonStyle.Link).setURL(joinUrl));
  return [row(...buttons)];
}

function sessionControlComponents(session) {
  const lifecycle = session.lifecycle_status ?? 'active';
  const terminal = ['completed', 'cancelled'].includes(lifecycle);
  return [
    row(
      new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:start`).setLabel('Start Session').setEmoji('▶️').setStyle(ButtonStyle.Success).setDisabled(lifecycle !== 'scheduled'),
      new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:pause`).setLabel(lifecycle === 'paused' ? 'Resume Session' : 'Pause Session').setEmoji(lifecycle === 'paused' ? '▶️' : '⏸️').setStyle(ButtonStyle.Secondary).setDisabled(['scheduled', ...['completed', 'cancelled']].includes(lifecycle)),
      new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:remind`).setLabel('Send Reminder').setEmoji('🔔').setStyle(ButtonStyle.Secondary).setDisabled(terminal),
    ),
    row(
      new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:announce`).setLabel('RP Announcement').setEmoji('📢').setStyle(ButtonStyle.Primary).setDisabled(terminal),
      new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:participants`).setLabel('View Participants').setEmoji('👥').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:end`).setLabel('End Session').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(terminal),
    ),
    row(new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:cancel`).setLabel('Cancel Scheduled Session')
      .setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(lifecycle !== 'scheduled')),
  ];
}

function getSession(db, sessionId) {
  return db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM session_participants p WHERE p.session_id = s.id) AS participant_count
    FROM sessions s WHERE s.id = ?`).get(sessionId);
}

async function updateSessionAnnouncement(client, session, db) {
  if (!session.channel_id || !session.message_id) return;
  try {
    const channel = await client.channels.fetch(session.channel_id);
    const message = channel?.isTextBased() ? await channel.messages.fetch(session.message_id) : null;
    if (!message) return;
    const displaySession = withSessionSettings(session, db);
    await message.edit({
      embeds: [sessionEmbed(displaySession)],
      files: displaySession.image_url ? [] : [await makeGraphic(session.rp_type, session.name, 'GV GR RP SESSION')],
      components: sessionPublicComponents(session.id,
        session.status === 'completed' || session.lifecycle_status === 'cancelled', displaySession.join_url),
    });
  } catch (error) {
    console.error(`Could not refresh session announcement ${session.session_code}:`, error.message);
  }
}

async function handleEventButton(interaction, ctx) {
  const [, , action, rawId, response] = interaction.customId.split(':');
  const eventId = Number(rawId);
  if (!Number.isSafeInteger(eventId)) return interaction.reply({ content: 'This event control is invalid.', ephemeral: true });
  const event = ctx.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return interaction.reply({ content: 'This event is no longer available.', ephemeral: true });
  if (action === 'details') {
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply({ embeds: [eventEmbed(event)], files: [await makeGraphic(event.event_type, event.name)] });
  }
  if (action === 'rsvp') {
    if (event.status !== 'scheduled') return interaction.reply({ content: `RSVPs are closed because ${event.event_code} is ${event.status}.`, ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const changed = setEventAttendance(ctx.db, event.id, interaction.user.id, interaction.user.username, response);
    if (changed) {
      const now = new Date().toISOString();
      recordEventHistory(ctx.db, event.id, interaction.user.id, `attendance_${response}`, { username: interaction.user.username }, now);
      await logStaffAction(interaction.client, ctx.db, {
        embeds: [makeEmbed(config.EMBED_COLORS.info, '👥 GV GR EVENT RSVP UPDATED', `**${event.event_code}** • ${event.name}\nUser: <@${interaction.user.id}>\nResponse: **${response === 'going' ? 'Going' : "Can't Go"}**\nTime: ${unixTime(now)}`)],
      });
    }
    const counts = ctx.db.prepare(`SELECT response, COUNT(*) AS count FROM event_attendance WHERE event_id = ? GROUP BY response`).all(event.id);
    const going = counts.find((entry) => entry.response === 'going')?.count ?? 0;
    const no = counts.find((entry) => entry.response === 'cant_go')?.count ?? 0;
    return interaction.editReply({ content: `${changed ? `Your response is now **${response === 'going' ? 'Going' : "Can't Go"}**.` : 'Your response was already recorded.'}\n${event.event_code} • 🟢 ${going} going • 🔴 ${no} can’t go.` });
  }
  return interaction.reply({ content: 'This event control is not recognized.', ephemeral: true });
}

async function handleSessionButton(interaction, ctx) {
  const [, , action, rawId, subAction] = interaction.customId.split(':');
  const sessionId = Number(rawId);
  if (!Number.isSafeInteger(sessionId)) return interaction.reply({ content: 'This session control is invalid.', ephemeral: true });
  const session = getSession(ctx.db, sessionId);
  if (!session) return interaction.reply({ content: 'This RP session could not be found.', ephemeral: true });
  if (action === 'join' || action === 'leave') {
    const result = setSessionParticipation(ctx.db, session.id, interaction.user.id, interaction.user.username, action === 'join');
    if (!result.active) return interaction.reply({ content: 'This RP session has ended.', ephemeral: true });
    return interaction.reply({ content: result.changed ? (action === 'join' ? `You joined ${session.session_code}.` : `You left ${session.session_code}.`) : (action === 'join' ? 'You are already in this session.' : 'You were not listed as a participant.'), ephemeral: true });
  }
  const member = await getInteractionMember(interaction);
  const authorizedHost = interaction.user.id === session.host_id && member && isStaff(member, interaction.guild, ctx.db);
  const manager = member && isManagement(member, interaction.guild, ctx.db);
  if (action === 'info') {
    const controls = authorizedHost || manager ? sessionControlComponents(session) : [];
    const displaySession = withSessionSettings(session, ctx.db);
    await interaction.deferReply({ ephemeral: true });
    return interaction.editReply({ embeds: [sessionEmbed(displaySession)], components: controls,
      files: displaySession.image_url ? [] : [await makeGraphic(session.rp_type, session.name, 'GV GR RP SESSION')] });
  }
  if (action !== 'control') return interaction.reply({ content: 'This session control is not recognized.', ephemeral: true });
  if (!authorizedHost && !manager) return interaction.reply({ content: 'Only this session’s active staff host or management can use live controls.', ephemeral: true });
  if (subAction === 'participants') {
    const people = ctx.db.prepare('SELECT user_id, username FROM session_participants WHERE session_id = ? ORDER BY joined_at').all(session.id);
    const list = people.length ? people.slice(0, 40).map((person) => `<@${person.user_id}>`).join('\n') : 'No participants yet.';
    return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, `👥 SESSION PARTICIPANTS • ${session.session_code}`, `**${session.name}**\n\n${list}`)], ephemeral: true });
  }
  if (subAction === 'cancel_abort') {
    return interaction.update({ content: 'Session cancellation stopped.', embeds: [], components: [] });
  }
  if (subAction === 'cancel') {
    if (session.lifecycle_status !== 'scheduled') return interaction.reply({ content: 'Only a scheduled session can be cancelled.', ephemeral: true });
    return interaction.reply({
      content: `Cancel **${session.session_code} • ${session.name}**? Its announcement will be marked cancelled.`,
      components: [row(
        new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:cancel_confirm`).setLabel('Confirm Cancellation').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`gv:rp:control:${session.id}:cancel_abort`).setLabel('Keep Session').setStyle(ButtonStyle.Secondary),
      )],
      ephemeral: true,
    });
  }
  if (!['start', 'pause', 'remind', 'announce', 'end', 'cancel_confirm'].includes(subAction)) {
    return interaction.reply({ content: 'This RP session action is not recognized.', ephemeral: true });
  }
  if (subAction === 'start' && session.lifecycle_status !== 'scheduled') {
    return interaction.reply({ content: 'This session has already started or ended.', ephemeral: true });
  }
  if (subAction === 'pause' && ['completed', 'cancelled'].includes(session.lifecycle_status)) {
    return interaction.reply({ content: 'This session has already ended.', ephemeral: true });
  }
  if (subAction === 'end' && session.lifecycle_status === 'scheduled') {
    return interaction.reply({ content: 'This session has not started yet. Use the Start Session control at its scheduled time.', ephemeral: true });
  }
  if (subAction === 'end' && ['completed', 'cancelled'].includes(session.lifecycle_status)) {
    return interaction.reply({ content: 'This session has already ended.', ephemeral: true });
  }
  if (subAction === 'cancel_confirm' && session.lifecycle_status !== 'scheduled') {
    return interaction.reply({ content: 'This session is no longer scheduled and was not cancelled.', ephemeral: true });
  }
  if (['remind', 'announce'].includes(subAction) && ['completed', 'cancelled'].includes(session.lifecycle_status)) {
    return interaction.reply({ content: 'This session has ended; no further announcements can be sent.', ephemeral: true });
  }
  await interaction.deferUpdate();
  if (subAction === 'cancel_confirm') {
    const now = new Date().toISOString();
    const cancelled = ctx.db.prepare(`UPDATE sessions SET status = 'completed', lifecycle_status = 'cancelled', ended_at = ?
      WHERE id = ? AND status = 'active' AND lifecycle_status = 'scheduled'`).run(now, session.id);
    if (!cancelled.changes) return interaction.editReply({ content: 'This session changed state before cancellation; no changes were made.', components: [] });
    const updated = getSession(ctx.db, session.id);
    await updateSessionAnnouncement(interaction.client, updated, ctx.db);
    await logStaffAction(interaction.client, ctx.db, { embeds: [sessionEmbed(withSessionSettings(updated, ctx.db))] });
    return interaction.editReply({ content: `${session.session_code} was cancelled.`, embeds: [], components: [] });
  }
  if (subAction === 'start') {
    const now = new Date().toISOString();
    const started = ctx.db.prepare(`UPDATE sessions SET lifecycle_status = 'active', started_at = ?, actual_started_at = ?
      WHERE id = ? AND status = 'active' AND lifecycle_status = 'scheduled'`).run(now, now, session.id);
    if (!started.changes) return interaction.editReply({ content: 'This session changed state before it could start.', components: [] });
  } else if (subAction === 'pause') {
    if (session.lifecycle_status === 'paused') {
      const pausedSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(session.paused_at)) / 1000));
      ctx.db.prepare("UPDATE sessions SET lifecycle_status = 'active', paused_seconds = paused_seconds + ?, paused_at = NULL WHERE id = ? AND lifecycle_status = 'paused'").run(pausedSeconds, session.id);
    } else {
      ctx.db.prepare("UPDATE sessions SET lifecycle_status = 'paused', paused_at = ? WHERE id = ? AND lifecycle_status = 'active'").run(new Date().toISOString(), session.id);
    }
  } else if (subAction === 'remind' || subAction === 'announce') {
    const channelId = session.channel_id || session.announcement_channel_id;
    const channel = channelId && await interaction.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased() || !channel.send) return interaction.followUp({ content: 'The session announcement channel is unavailable.', ephemeral: true });
    const title = subAction === 'remind' ? '🔔 GV GR RP SESSION REMINDER' : '📢 GV GR RP SESSION ANNOUNCEMENT';
    const displaySession = withSessionSettings(session, ctx.db);
    const embed = sessionEmbed(displaySession).setTitle(title);
    await channel.send({ embeds: [embed], files: displaySession.image_url ? [] : [await makeGraphic(session.rp_type, session.name, 'GV GR RP SESSION')],
      components: sessionPublicComponents(session.id, false, displaySession.join_url), allowedMentions: { users: [session.host_id] } });
    return interaction.followUp({ content: `${subAction === 'remind' ? 'Reminder' : 'Announcement'} sent to <#${channelId}>.`, ephemeral: true });
  } else if (subAction === 'end') {
    const endedAt = new Date().toISOString();
    const pauseAtEnd = session.lifecycle_status === 'paused' && session.paused_at
      ? Math.max(0, Math.floor((Date.now() - Date.parse(session.paused_at)) / 1000)) : 0;
    const actualStart = session.actual_started_at ?? session.started_at;
    const durationSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(actualStart)) / 1000) - (session.paused_seconds ?? 0) - pauseAtEnd);
    const ended = ctx.db.prepare(`UPDATE sessions SET status = 'completed', lifecycle_status = 'completed', ended_at = ?,
      duration_seconds = ?, paused_seconds = paused_seconds + ? WHERE id = ? AND status = 'active'
      AND lifecycle_status IN ('active', 'paused')`).run(endedAt, durationSeconds, pauseAtEnd, session.id);
    if (!ended.changes) return interaction.editReply({ content: 'This session changed state before it could end.', components: [] });
    const completed = getSession(ctx.db, session.id);
    await updateSessionAnnouncement(interaction.client, completed, ctx.db);
    const summary = sessionEmbed(withSessionSettings(completed, ctx.db));
    await logStaffAction(interaction.client, ctx.db, { embeds: [summary] });
    return interaction.editReply({ content: `${session.session_code} ended. Active time: **${formatDuration(durationSeconds)}**.`, embeds: [], components: [] });
  }
  const updated = getSession(ctx.db, session.id);
  await updateSessionAnnouncement(interaction.client, updated, ctx.db);
  const actionEmbed = makeEmbed(config.EMBED_COLORS.management, `🎮 SESSION ${subAction.toUpperCase()}`,
    `\`${session.session_code}\` • ${session.name}\nUpdated by <@${interaction.user.id}>\nStatus: **${updated.lifecycle_status.toUpperCase()}**`);
  await logStaffAction(interaction.client, ctx.db, { embeds: [actionEmbed] });
  return interaction.editReply({ embeds: [sessionEmbed(withSessionSettings(updated, ctx.db))], components: sessionControlComponents(updated) });
}

async function handleEventChannelSelect(interaction, ctx) {
  const [, kind, , draftId, selection] = interaction.customId.split(':');
  const table = kind === 'event' ? 'event_drafts' : 'session_drafts';
  const key = selection === 'voice' ? 'voiceChannelId' : 'announcementChannelId';
  const data = updateDraft(ctx.db, table, draftId, interaction.user.id, { [key]: interaction.values[0] });
  if (!data) return interaction.reply({ content: 'This setup form expired. Start again from the Staff Center.', ephemeral: true });
  const target = interaction.values[0];
  return interaction.update({ content: `${key === 'voiceChannelId' ? 'Voice channel' : 'Announcement channel'} selected: <#${target}>. ${data.voiceChannelId && (kind !== 'event' || data.announcementChannelId) ? 'Ready to continue.' : 'Choose the remaining channel.'}`,
    components: channelSelectionComponents(kind, draftId, data) });
}

async function handleOperationTypeSelect(interaction, ctx, kind) {
  const [, , , draftId] = interaction.customId.split(':');
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Configured staff access is required.', ephemeral: true });
  const values = kind === 'event' ? EVENT_TYPES : RP_TYPES;
  const selectedType = interaction.values[0];
  if (!values.includes(selectedType)) return interaction.reply({ content: 'Choose a valid type from the menu.', ephemeral: true });
  const table = kind === 'event' ? 'event_drafts' : 'session_drafts';
  const key = kind === 'event' ? 'eventType' : 'rpType';
  const draft = updateDraft(ctx.db, table, draftId, interaction.user.id, { [key]: selectedType });
  if (!draft) return interaction.reply({ content: 'This setup form expired. Start again from the Staff Center.', ephemeral: true });
  if (kind === 'event') return interaction.showModal(createEventDescriptionModal(draftId));
  return interaction.reply({ content: `Select the voice channel for **${draft.name}**. The public announcement will use the configured RP session channel.`,
    components: channelSelectionComponents('rp', draftId, draft), ephemeral: true });
}

async function submitRpModal(interaction, ctx) {
  const parts = interaction.customId.split(':');
  const draftId = parts[3];
  const detailsStep = parts[4] === 'details';
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Configured staff access is required.', ephemeral: true });
  const existing = getDraft(ctx.db, 'session_drafts', draftId, interaction.user.id);
  if (!existing) return interaction.reply({ content: 'This session form expired. Open the Staff Center and start again.', ephemeral: true });
  if (existing.managementOnly && !isManagement(member, interaction.guild, ctx.db)) {
    return interaction.reply({ content: 'Management access is required to start this selected-host session.', ephemeral: true });
  }
  if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) return interaction.reply({ content: 'An RP session is already active.', ephemeral: true });
  const timeZone = existing.timeZone ?? getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC';
  if (!detailsStep) {
    const name = interaction.fields.getTextInputValue('name').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const dateLabel = interaction.fields.getTextInputValue('date').trim();
    const startLabel = interaction.fields.getTextInputValue('time').trim();
    const scheduledStartAt = parseStartAt(dateLabel, startLabel, timeZone);
    if (!name || !description) return interaction.reply({ content: 'Session title and description are required.', ephemeral: true });
    const host = await fetchGuildMember(interaction.guild, existing.hostId ?? interaction.user.id);
    if (!host || !getStaffRoleName(host, ctx.db) || !isStaff(host, interaction.guild, ctx.db)) {
      return interaction.reply({ content: 'The selected session host no longer has a configured staff role.', ephemeral: true });
    }
    if (!scheduledStartAt || Date.parse(scheduledStartAt) <= Date.now()) {
      return interaction.reply({ content: `Enter a valid future date and time in ${timeZone}; check daylight-saving transitions.`, ephemeral: true });
    }
    updateDraft(ctx.db, 'session_drafts', draftId, interaction.user.id, {
      name, description, dateLabel, startLabel, scheduledStartAt, timeZone,
      hostId: host.id, hostName: host.user.username,
    });
    return interaction.showModal(createSessionDetailsModal(draftId));
  }

  const duration = interaction.fields.getTextInputValue('duration').trim();
  const activity = interaction.fields.getTextInputValue('activity').trim();
  const imageUrl = interaction.fields.getTextInputValue('image_url').trim();
  if (!parseDurationMinutes(duration)) return interaction.reply({ content: 'Enter an expected duration such as `2 hours` or `90 minutes`.', ephemeral: true });
  if (!activity) return interaction.reply({ content: 'Session activity is required.', ephemeral: true });
  if (imageUrl) {
    try {
      if (new URL(imageUrl).protocol !== 'https:') throw new Error('HTTPS required');
    } catch {
      return interaction.reply({ content: 'The optional banner must be a valid HTTPS image URL.', ephemeral: true });
    }
  }
  const data = updateDraft(ctx.db, 'session_drafts', draftId, interaction.user.id, {
    expectedDuration: duration, activity, imageUrl,
  });
  return interaction.reply({ content: `Choose the RP type for **${data.name}**.`, components: [typeSelect(`gv:rp:type:${draftId}`, 'Select RP type', RP_TYPES)], ephemeral: true });
}

async function handleOperationButton(interaction, ctx) {
  const id = interaction.customId;
  if (id.startsWith('gv:center:event:')) return handleEventIdButton(interaction, ctx);
  if (id === 'gv:center:event:create') return handleEventStart(interaction, ctx);
  if (id.startsWith('gv:event:publish:')) return submitEventDraft(interaction, ctx, id.split(':').at(-1));
  if (id.startsWith('gv:rp:publish:')) return submitSessionDraft(interaction, ctx, id.split(':').at(-1));
  if (id.startsWith('gv:rp:')) return handleSessionButton(interaction, ctx);
  if (id.startsWith('gv:event:')) return handleEventButton(interaction, ctx);
  return null;
}

async function handleEventStart(interaction, ctx) {
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Configured staff access is required.', ephemeral: true });
  const timeZone = getConfigValue(ctx.db, 'TIME_ZONE') ?? config.TIME_ZONE ?? 'UTC';
  const draftId = createDraft(ctx.db, 'event_drafts', interaction.user.id, { hostId: interaction.user.id, hostName: interaction.user.username, timeZone });
  return interaction.showModal(createEventBasicsModal(draftId, timeZone));
}

async function handleEventIdButton(interaction, ctx) {
  const action = interaction.customId.split(':').at(-1);
  const member = await getInteractionMember(interaction);
  if (!member || !isStaff(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Configured staff access is required.', ephemeral: true });
  if (action === 'create') return handleEventStart(interaction, ctx);
  if (action === 'upcoming') return interaction.reply({ embeds: [createUpcomingEmbed(ctx.db)], ephemeral: true });
  if (action === 'history') {
    if (!isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required.', ephemeral: true });
    return interaction.reply({ embeds: [createEventHistoryEmbed(ctx.db)], ephemeral: true });
  }
  if (['edit', 'cancel', 'attendance', 'host'].includes(action)) {
    if (!isManagement(member, interaction.guild, ctx.db)) return interaction.reply({ content: 'Management access is required for event management and attendance.', ephemeral: true });
    return interaction.showModal(createEventIdModal(action));
  }
  return interaction.reply({ content: 'That Events control is not recognized.', ephemeral: true });
}

async function handleOperationModal(interaction, ctx) {
  const id = interaction.customId;
  if (id.startsWith('gv:event:create:') || id.startsWith('gv:event:manage:')) return submitEventModal(interaction, ctx);
  if (id.startsWith('gv:event:edit:')) return submitEventEdit(interaction, ctx);
  if (id.startsWith('gv:event:host:')) return submitEventHost(interaction, ctx);
  if (id.startsWith('gv:center:event:')) return submitEventModal(interaction, ctx);
  if (id.startsWith('gv:rp:create:')) return submitRpModal(interaction, ctx);
  return null;
}

async function handleOperationSelect(interaction, ctx) {
  if (interaction.customId.startsWith('gv:event:type:')) return handleOperationTypeSelect(interaction, ctx, 'event');
  if (interaction.customId.startsWith('gv:rp:type:')) return handleOperationTypeSelect(interaction, ctx, 'rp');
  if (interaction.customId.startsWith('gv:event:host_select:')) return submitEventHost(interaction, ctx);
  if (interaction.customId.startsWith('gv:event:channel:')) return handleEventChannelSelect(interaction, ctx);
  if (interaction.customId.startsWith('gv:rp:channel:')) return handleEventChannelSelect(interaction, ctx);
  return null;
}

async function processEventTasks(client, db, now = new Date()) {
  for (const event of getDueEventReminders(db, now)) {
    if (!claimEventReminder(db, event.id, event.reminder_type, now.toISOString())) continue;
    const titles = {
      one_hour: '⏰ GV GR EVENT REMINDER',
      fifteen_minutes: '🚨 EVENT STARTING SOON',
      started: '🎉 THE EVENT IS NOW STARTING',
    };
    const message = `${titles[event.reminder_type]}\n\n**${event.name}** • \`${event.event_code}\`\n${event.reminder_type === 'started' ? `Join <#${event.voice_channel_id}> now.` : `Starts <t:${Math.floor(Date.parse(event.starts_at) / 1000)}:R> in <#${event.voice_channel_id}>.`}\nHost: <@${event.host_id}>`;
    let delivered = false;
    try {
      const channel = event.announcement_channel_id && await client.channels.fetch(event.announcement_channel_id);
      if (channel?.isTextBased() && channel.send) {
        const stillScheduled = () => Boolean(db.prepare("SELECT id FROM events WHERE id = ? AND status = 'scheduled'").get(event.id));
        if (stillScheduled()) {
          const sent = await channel.send({ embeds: [makeEmbed(config.EMBED_COLORS.warning, titles[event.reminder_type], message)], allowedMentions: { users: [event.host_id] } });
          if (stillScheduled()) delivered = true;
          else await sent.delete().catch(() => {});
        }
      }
    } catch (error) { console.error(`Could not send ${event.reminder_type} reminder for ${event.event_code}:`, error.message); }
    finishEventReminder(db, event.id, event.reminder_type, delivered);
    if (event.reminder_type === 'started') {
      const log = makeEmbed(config.EMBED_COLORS.info, '🎉 GV GR EVENT STARTED', `\`${event.event_code}\` • ${event.name}\nHost: <@${event.host_id}>\nStarted: <t:${Math.floor(Date.parse(event.starts_at) / 1000)}:F>`);
      await logStaffAction(client, db, { embeds: [log] });
      recordEventHistory(db, event.id, event.host_id, 'started', {}, now.toISOString());
    }
  }

  const completedEvents = db.prepare(`SELECT * FROM events WHERE status = 'scheduled' AND starts_at <= ?`).all(now.toISOString());
  for (const event of completedEvents) {
    const endAt = Date.parse(event.starts_at) + event.duration_minutes * 60_000;
    if (endAt > now.getTime()) continue;
    const result = db.prepare("UPDATE events SET status = 'completed' WHERE id = ? AND status = 'scheduled'").run(event.id);
    if (!result.changes) continue;
    recordEventHistory(db, event.id, event.host_id, 'completed', {}, now.toISOString());
    await logStaffAction(client, db, { embeds: [makeEmbed(config.EMBED_COLORS.info, '✅ GV GR EVENT COMPLETED', `\`${event.event_code}\` • ${event.name}\nHost: <@${event.host_id}>\nEnded: <t:${Math.floor(endAt / 1000)}:F>`)] });
  }

  const startingSessions = db.prepare(`SELECT id FROM sessions
    WHERE status = 'active' AND lifecycle_status = 'scheduled' AND started_at <= ?`).all(now.toISOString());
  for (const { id } of startingSessions) {
    const claimed = db.prepare(`UPDATE sessions SET lifecycle_status = 'active', started_at = ?, actual_started_at = ?
      WHERE id = ? AND status = 'active' AND lifecycle_status = 'scheduled' AND started_at <= ?`)
      .run(now.toISOString(), now.toISOString(), id, now.toISOString());
    if (!claimed.changes) continue;
    const session = getSession(db, id);
    const embed = makeEmbed(config.EMBED_COLORS.active, '🎮 GV GR RP SESSION STARTED',
      `\`${session.session_code}\` • **${session.name}**\nHost: <@${session.host_id}>\nType: ${session.rp_type}\nVoice: <#${session.voice_channel_id}>\nStarted: <t:${Math.floor(Date.parse(session.started_at) / 1000)}:F>`);
    await updateSessionAnnouncement(client, session, db);
    await logStaffAction(client, db, { embeds: [embed] });
  }

  const expiredSessions = db.prepare("SELECT * FROM sessions WHERE status = 'active' AND lifecycle_status = 'active' AND expected_duration != ''").all();
  for (const session of expiredSessions) {
    const durationMinutes = parseDurationMinutes(session.expected_duration);
    const actualStart = session.actual_started_at ?? session.started_at;
    if (!durationMinutes || now.getTime() - Date.parse(actualStart) - (session.paused_seconds ?? 0) * 1000 < durationMinutes * 60_000) continue;
    const endedAt = now.toISOString();
    const durationSeconds = Math.max(0, Math.floor((now.getTime() - Date.parse(actualStart)) / 1000) - (session.paused_seconds ?? 0));
    const result = db.prepare("UPDATE sessions SET status = 'completed', lifecycle_status = 'completed', ended_at = ?, duration_seconds = ? WHERE id = ? AND status = 'active'").run(endedAt, durationSeconds, session.id);
    if (!result.changes) continue;
    const completed = getSession(db, session.id);
    await updateSessionAnnouncement(client, completed, db);
    const log = makeEmbed(config.EMBED_COLORS.info, '✅ GV GR RP SESSION COMPLETED', `\`${session.session_code}\` • ${session.name}\nHost: <@${session.host_id}>\nDuration: **${formatDuration(durationSeconds)}**\nParticipants: **${completed.participant_count}**\nClosed automatically at expected duration.`);
    await logStaffAction(client, db, { embeds: [log] });
  }
  db.prepare("DELETE FROM event_drafts WHERE expires_at <= ?").run(now.toISOString());
  db.prepare("DELETE FROM session_drafts WHERE expires_at <= ?").run(now.toISOString());
}

module.exports = {
  eventAnnouncementComponents,
  eventEmbed,
  eventManageComponents,
  makeGraphic,
  handleEventButton,
  handleOperationButton,
  handleOperationModal,
  handleOperationSelect,
  handleStaffCenterControl,
  createSessionHistoryEmbed,
  openRpControls,
  openSessionCreation,
  processEventTasks,
  parseSessionStartAt,
  sessionEmbed,
  sessionControlComponents,
  sessionPublicComponents,
};