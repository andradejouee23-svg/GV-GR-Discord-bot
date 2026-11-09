const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { formatDuration } = require('../utils/format');
const {
  fetchGuildMember,
  getConfigValue,
  getStaffRoleName,
  hasRoleGroup,
  logStaffAction,
  makeEmbed,
  setConfigValue,
  sendToChannel,
  unixTime,
} = require('../utils/discord');
const { ensureManagement } = require('./staff');
const { openAnnouncementManager } = require('./announcementManager');
const { getFormQuestion } = require('./forms');

function makeSessionModal(host, db) {
  const name = getFormQuestion(db, 'session', 'name');
  const description = getFormQuestion(db, 'session', 'description');
  return new ModalBuilder()
    .setCustomId(`gv:session_start:${host.id}`)
    .setTitle('Start an RP Session')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('name').setLabel(name.label).setStyle(TextInputStyle.Short)
        .setMaxLength(100).setRequired(true).setPlaceholder(name.placeholder)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('description').setLabel(description.label).setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000).setRequired(false).setPlaceholder(description.placeholder)),
    );
}

function makeSessionPanelModal(hostId, db) {
  const name = getFormQuestion(db, 'session', 'name');
  const description = getFormQuestion(db, 'session', 'description');
  return new ModalBuilder()
    .setCustomId(`gv:session_panel_start:${hostId}`)
    .setTitle('GV GR • Start RP Session')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('name').setLabel(name.label).setStyle(TextInputStyle.Short)
        .setMaxLength(100).setRequired(true).setPlaceholder(name.placeholder)),
      new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('description').setLabel(description.label).setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000).setRequired(false).setPlaceholder(description.placeholder)),
    );
}

function makeSessionButtons(sessionId, defaults = getSessionQuickStartDefaultsFromConfig()) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:session_join:${sessionId}`).setLabel(defaults.buttonLabel).setEmoji(defaults.buttonEmoji).setStyle(ButtonStyle.Primary),
  )];
}

function getSessionQuickStartDefaultsFromConfig() {
  return {
    name: config.SESSION_QUICK_START_NAME ?? 'Greenville RP Session',
    description: config.SESSION_QUICK_START_DESCRIPTION ?? 'A new Greenville RP session is now live. Staff can join using the button below.',
    imageUrl: null,
    color: config.EMBED_COLORS.info,
    footer: 'GREENVILLE ROLEPLAY • Staff can join this active session below',
    buttonLabel: 'Join Session',
    buttonEmoji: '🎙️',
  };
}

function getSessionQuickStartDefaults(db) {
  const defaults = getSessionQuickStartDefaultsFromConfig();
  const saved = {
    name: getConfigValue(db, 'SESSION_QUICK_START_NAME'),
    description: getConfigValue(db, 'SESSION_QUICK_START_DESCRIPTION'),
    imageUrl: getConfigValue(db, 'SESSION_QUICK_START_IMAGE_URL'),
    colorHex: getConfigValue(db, 'SESSION_QUICK_START_COLOR'),
    footer: getConfigValue(db, 'SESSION_QUICK_START_FOOTER'),
    buttonLabel: getConfigValue(db, 'SESSION_QUICK_START_BUTTON_LABEL'),
    buttonEmoji: getConfigValue(db, 'SESSION_QUICK_START_BUTTON_EMOJI'),
  };
  const colorHex = saved.colorHex ?? `#${defaults.color.toString(16).padStart(6, '0')}`;
  const color = /^#?[0-9a-f]{6}$/i.test(colorHex) ? Number.parseInt(colorHex.replace(/^#/, ''), 16) : defaults.color;
  return {
    name: saved.name ?? defaults.name,
    description: saved.description ?? defaults.description,
    imageUrl: saved.imageUrl ?? defaults.imageUrl,
    color,
    colorHex,
    footer: saved.footer ?? defaults.footer,
    buttonLabel: saved.buttonLabel ?? defaults.buttonLabel,
    buttonEmoji: saved.buttonEmoji ?? defaults.buttonEmoji,
  };
}

async function configureSessionQuickStart(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const options = interaction.options;
  const imageUrl = options.getString('image-url');
  const removeImage = options.getBoolean('remove-image') === true;
  if (imageUrl && removeImage) return interaction.reply({ content: 'Choose a new image URL or remove the saved image, not both.', ephemeral: true });
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) return interaction.reply({ content: 'The session image must use an HTTPS URL.', ephemeral: true });
  const color = options.getString('color');
  if (color && !/^#?[0-9a-f]{6}$/i.test(color)) return interaction.reply({ content: 'Enter a six-digit HEX color, such as #36A765.', ephemeral: true });
  const buttonEmoji = options.getString('button-emoji');
  if (buttonEmoji) {
    try { new ButtonBuilder().setEmoji(buttonEmoji).toJSON(); }
    catch { return interaction.reply({ content: 'Enter a valid Discord emoji for the join button.', ephemeral: true }); }
  }
  const changes = [];
  for (const [option, key] of [
    ['name', 'SESSION_QUICK_START_NAME'],
    ['description', 'SESSION_QUICK_START_DESCRIPTION'],
    ['footer', 'SESSION_QUICK_START_FOOTER'],
    ['button-label', 'SESSION_QUICK_START_BUTTON_LABEL'],
    ['button-emoji', 'SESSION_QUICK_START_BUTTON_EMOJI'],
  ]) {
    const value = options.getString(option);
    if (value !== null) changes.push([key, value.trim()]);
  }
  if (color) changes.push(['SESSION_QUICK_START_COLOR', color.startsWith('#') ? color.toUpperCase() : `#${color.toUpperCase()}`]);
  if (imageUrl) changes.push(['SESSION_QUICK_START_IMAGE_URL', imageUrl.trim()]);
  if (removeImage) changes.push(['SESSION_QUICK_START_IMAGE_URL', null]);
  if (!changes.length) return interaction.reply({ content: 'Provide at least one Quick Start default to change.', ephemeral: true });
  for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
  return interaction.reply({ content: `Saved Quick Start Session defaults: ${changes.map(([key]) => `**${key.replace('SESSION_QUICK_START_', '').replaceAll('_', ' ').toLowerCase()}**`).join(', ')}.`, ephemeral: true });
}

async function startSessionCommand(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const host = interaction.options.getUser('host', true);
  const hostMember = await fetchGuildMember(interaction.guild, host.id);
  if (!hostMember || !getStaffRoleName(hostMember, ctx.db)) {
    return interaction.reply({ content: 'The session host must be a current member of a configured staff role.', ephemeral: true });
  }
  const current = ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get();
  if (current) return interaction.reply({ content: `Session #${current.id} is already active. End it before starting another.`, ephemeral: true });
  return openAnnouncementManager(interaction, ctx, { hostId: host.id, authorized: true });
}

async function submitSessionModal(interaction, ctx) {
  const manager = await fetchGuildMember(interaction.guild, interaction.user.id);
  if (!manager || !hasRoleGroup(manager, ctx.db, 'management')) {
    return interaction.reply({ content: 'Your management role is required to start an RP session.', ephemeral: true });
  }

  const hostId = interaction.customId.split(':').at(-1);
  const host = await fetchGuildMember(interaction.guild, hostId);
  if (!host || !getStaffRoleName(host, ctx.db)) {
    return interaction.reply({ content: 'The selected host no longer has a configured staff role.', ephemeral: true });
  }
  const name = interaction.fields.getTextInputValue('name').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  if (!name) return interaction.reply({ content: 'Enter a session name before starting.', ephemeral: true });
  return publishSessionAnnouncement(interaction, ctx, host, name, description);
}

async function publishSessionAnnouncement(interaction, ctx, host, name, description, defaults = getSessionQuickStartDefaults(ctx.db)) {
  const now = new Date().toISOString();
  const sessionId = ctx.db.transaction(() => {
    if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) return null;
    const result = ctx.db.prepare(`
      INSERT INTO sessions (name, description, host_id, host_name, started_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(name, description, host.id, host.user.username, now);
    const id = Number(result.lastInsertRowid);
    ctx.db.prepare('INSERT INTO session_participants (session_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)')
      .run(id, host.id, host.user.username, now);
    return id;
  })();
  if (!sessionId) return interaction.reply({ content: 'Another RP session is already active. End it before starting a new one.', ephemeral: true });

  const embed = makeEmbed(defaults.color, `🎙️ GV GR • ${name}`,
    `${description ? `${description}\n\n` : ''}**SESSION LIVE**\n\n👤 **Host**\n<@${host.id}>\n\n🕒 **Started**\n${unixTime(now)}\n\n🆔 **Session**\n#${sessionId}`)
    .setFooter({ text: defaults.footer || 'GV GR • RP Session' })
    .setTimestamp(new Date(now));
  if (defaults.imageUrl) embed.setImage(defaults.imageUrl);
  if (interaction.guild?.iconURL()) embed.setAuthor({ name: 'GV GR • GREENVILLE ROLEPLAY', iconURL: interaction.guild.iconURL() });
  const channelId = getConfigValue(ctx.db, 'SESSION_CHANNEL_ID');
  let message;
  if (channelId) {
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      if (channel?.isTextBased() && channel.send) message = await channel.send({ embeds: [embed], components: makeSessionButtons(sessionId, defaults) });
    } catch (error) {
      console.error('Could not announce the RP session:', error.message);
    }
  }
  if (message) {
    ctx.db.prepare('UPDATE sessions SET channel_id = ?, message_id = ? WHERE id = ?').run(message.channelId, message.id, sessionId);
  }

  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.info, '🎙️ RP Session Started', `**${name}** • Host: <@${host.id}>\nStarted: ${unixTime(now)}\nSession #${sessionId}`)],
  });
  return interaction.reply({
    content: message ? `Session #${sessionId} started in <#${message.channelId}>.`
      : `Session #${sessionId} was saved, but I could not announce it. Configure SESSION_CHANNEL_ID and check my channel permissions.`,
    ephemeral: true,
  });
}

async function handleSessionPanelButton(interaction, ctx) {
  if (interaction.customId === 'gv:session_panel:quick-start') {
    const host = await fetchGuildMember(interaction.guild, interaction.user.id);
    if (!host || !getStaffRoleName(host, ctx.db)) {
      return interaction.reply({ content: 'Starting a GV GR session is available to configured staff members only.', ephemeral: true });
    }
    if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) {
      return interaction.reply({ content: 'An RP session is already active. End it before starting another.', ephemeral: true });
    }
    const defaults = getSessionQuickStartDefaults(ctx.db);
    return publishSessionAnnouncement(interaction, ctx, host, defaults.name, defaults.description, defaults);
  }
  if (interaction.customId === 'gv:session_panel:start') {
    const host = await fetchGuildMember(interaction.guild, interaction.user.id);
    if (!host || !getStaffRoleName(host, ctx.db)) {
      return interaction.reply({ content: 'Starting a GV GR session is available to configured staff members only.', ephemeral: true });
    }
    if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) {
      return interaction.reply({ content: 'An RP session is already active. End it before starting another.', ephemeral: true });
    }
    return interaction.showModal(makeSessionPanelModal(interaction.user.id, ctx.db));
  }
  if (interaction.customId === 'gv:session_panel:end') return endSession(interaction, ctx);
  return null;
}

async function handleSessionPanelModal(interaction, ctx) {
  const match = interaction.customId.match(/^gv:session_panel_start:(\d{17,20})$/);
  if (!match) return null;
  if (match[1] !== interaction.user.id) return interaction.reply({ content: 'Only the staff member who opened this session form can submit it.', ephemeral: true });
  const host = await fetchGuildMember(interaction.guild, interaction.user.id);
  if (!host || !getStaffRoleName(host, ctx.db)) return interaction.reply({ content: 'Your configured GV GR staff role is required to start a session.', ephemeral: true });
  const name = interaction.fields.getTextInputValue('name').trim();
  const description = interaction.fields.getTextInputValue('description').trim();
  if (!name) return interaction.reply({ content: 'Enter a session name before publishing.', ephemeral: true });
  return publishSessionAnnouncement(interaction, ctx, host, name, description);
}

async function endSession(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const session = ctx.db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!session) return interaction.reply({ content: 'There is no active RP session to end.', ephemeral: true });

  const endedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.floor((Date.parse(endedAt) - new Date(session.started_at).getTime()) / 1000));
  const claimed = ctx.db.prepare("UPDATE sessions SET ended_at = ?, duration_seconds = ?, status = 'completed' WHERE id = ? AND status = 'active'")
    .run(endedAt, durationSeconds, session.id);
  if (!claimed.changes) return interaction.reply({ content: 'This RP session was already ended.', ephemeral: true });

  const embed = makeEmbed(config.EMBED_COLORS.info, '🎙️ RP Session Ended',
    `**SESSION CONCLUDED**\n\n🎙️ **${session.name}**\n👤 **Host:** <@${session.host_id}>\n🕒 **Started:** ${unixTime(session.started_at)}\n🏁 **Ended:** ${unixTime(endedAt)}\n⏱️ **Duration:** ${formatDuration(durationSeconds)}`)
    .setFooter({ text: 'GREENVILLE ROLEPLAY • Session announcement' })
    .setTimestamp(new Date(endedAt));
  let originalUpdated = false;
  if (session.channel_id && session.message_id) {
    try {
      const channel = await interaction.client.channels.fetch(session.channel_id);
      const message = channel?.isTextBased() ? await channel.messages.fetch(session.message_id) : null;
      if (message && message.author?.id === interaction.client.user?.id) {
        await message.edit({ embeds: [embed], components: [] });
        originalUpdated = true;
      }
    } catch (error) {
      console.error(`Could not update session #${session.id} announcement:`, error.message);
    }
  }
  if (!originalUpdated) {
    await sendToChannel(interaction.client, getConfigValue(ctx.db, 'SESSION_CHANNEL_ID'), { embeds: [embed] });
  }
  return interaction.reply({ content: `Session #${session.id} ended. Duration: **${formatDuration(durationSeconds)}**.`, ephemeral: true });
}

async function sessionStatus(interaction, ctx) {
  const session = ctx.db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY id DESC LIMIT 1").get();
  if (!session) return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, '🎙️ RP Session Status', 'There is no active RP session.')], ephemeral: true });
  const participants = ctx.db.prepare('SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ?').get(session.id).count;
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(session.started_at).getTime()) / 1000));
  const embed = makeEmbed(config.EMBED_COLORS.info, `🎙️ RP Session: ${session.name}`,
    `${session.description ? `${session.description}\n\n` : ''}**Host:** <@${session.host_id}>\n**Started:** ${unixTime(session.started_at)}\n**Duration:** ${formatDuration(elapsed)}\n**Staff Participating:** ${participants}`);
  return interaction.reply({ embeds: [embed], ephemeral: true });
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
  const createdAt = new Date().toISOString();
  const result = ctx.db.prepare(`
    INSERT INTO events (name, description, host_id, host_name, starts_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, description, interaction.user.id, interaction.user.username, startsAt, createdAt);
  const eventId = Number(result.lastInsertRowid);
  const embed = makeEmbed(config.EMBED_COLORS.management, `🎉 ${name}`,
    `${description ? `${description}\n\n` : ''}**Host:** <@${interaction.user.id}>\n**When:** ${unixTime(startsAt)}\n**Event:** #${eventId}`)
    .setFooter({ text: 'GV GR Staff Event' })
    .setTimestamp(startsAtDate);
  const sent = await sendToChannel(interaction.client, getConfigValue(ctx.db, 'EVENT_CHANNEL_ID'), { embeds: [embed] });
  await logStaffAction(interaction.client, ctx.db, {
    embeds: [makeEmbed(config.EMBED_COLORS.management, '🎉 Staff Event Created', `**${name}** • Host: <@${interaction.user.id}>\nWhen: ${unixTime(startsAt)}\nEvent #${eventId}`)],
  });
  return interaction.reply({ content: sent ? `Event #${eventId} scheduled and announced.` : `Event #${eventId} was saved, but I could not announce it. Check EVENT_CHANNEL_ID and my channel permissions.`, ephemeral: true });
}

async function listEvents(interaction, ctx) {
  const now = new Date().toISOString();
  const events = ctx.db.prepare(`
    SELECT id, name, host_id, starts_at, description FROM events
    WHERE status = 'scheduled' AND starts_at >= ? ORDER BY starts_at ASC LIMIT 10
  `).all(now);
  const description = events.length
    ? events.map((event) => `**#${event.id} • ${event.name}**\n${unixTime(event.starts_at)} • Host: <@${event.host_id}>${event.description ? `\n${event.description}` : ''}`).join('\n\n')
    : 'No upcoming events are scheduled.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, '🎉 Upcoming GV GR Events', description)], ephemeral: true });
}

async function cancelEvent(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const eventId = interaction.options.getInteger('id', true);
  const result = ctx.db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'").run(eventId);
  if (!result.changes) return interaction.reply({ content: `Scheduled event #${eventId} was not found.`, ephemeral: true });
  const event = ctx.db.prepare('SELECT name FROM events WHERE id = ?').get(eventId);
  const embed = makeEmbed(config.EMBED_COLORS.error, 'Event Cancelled', `**${event.name}** • Event #${eventId}\nCancelled by <@${interaction.user.id}>.`);
  await sendToChannel(interaction.client, getConfigValue(ctx.db, 'EVENT_CHANNEL_ID'), { embeds: [embed] });
  await logStaffAction(interaction.client, ctx.db, { embeds: [embed] });
  return interaction.reply({ content: `Event #${eventId} cancelled.`, ephemeral: true });
}

async function handleOperationsCommand(interaction, ctx) {
  if (interaction.commandName === 'session') {
    const action = interaction.options.getSubcommand();
    if (action === 'configure') return configureSessionQuickStart(interaction, ctx);
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
  handleSessionPanelButton,
  handleSessionPanelModal,
  handleOperationsCommand,
  handleSessionJoin,
  makeSessionModal,
  makeSessionButtons,
  makeSessionPanelModal,
  getSessionQuickStartDefaults,
  publishSessionAnnouncement,
  configureSessionQuickStart,
  submitSessionModal,
};