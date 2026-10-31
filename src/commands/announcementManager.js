const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
const config = require('../../config');
const {
  fetchGuildMember,
  getConfigValue,
  getStaffRoleName,
  logStaffAction,
  makeEmbed,
  unixTime,
  validId,
} = require('../utils/discord');
const { ensureManagement } = require('./staff');

const draftLifetimeMs = 15 * 60 * 1000;
const templateLabels = {
  session_started: 'Session Started',
  upcoming_session: 'Upcoming Session',
  special_event: 'Special Event',
  custom: 'Custom Announcement',
};

function templateMenu(draftId) {
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`gv:ann:template:${draftId}`)
    .setPlaceholder('Choose an announcement template')
    .addOptions(
      { label: 'Session Started', value: 'session_started', description: 'Announce a live RP session' },
      { label: 'Upcoming Session', value: 'upcoming_session', description: 'Share details for a future session' },
      { label: 'Special Event', value: 'special_event', description: 'Announce a special event' },
      { label: 'Custom Announcement', value: 'custom', description: 'Start with an empty announcement' },
    ))];
}

function newDraftData(hostId = null) {
  return {
    template: null,
    hostId,
    title: '',
    description: '',
    imageUrl: '',
    color: '#4388D1',
    sections: [],
    buttons: [],
    destinationChannelId: null,
    mentionEveryone: false,
  };
}

function createDraft(db, actorId, hostId = null, now = Date.now()) {
  const id = randomUUID().replaceAll('-', '');
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + draftLifetimeMs).toISOString();
  db.prepare(`
    INSERT INTO announcement_drafts (id, actor_id, data_json, status, created_at, expires_at)
    VALUES (?, ?, ?, 'draft', ?, ?)
  `).run(id, actorId, JSON.stringify(newDraftData(hostId)), createdAt, expiresAt);
  return id;
}

function getDraft(db, id) {
  if (!/^[a-f0-9]{32}$/.test(id ?? '')) return null;
  const row = db.prepare('SELECT * FROM announcement_drafts WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data_json) };
}

function saveDraft(db, draft) {
  db.prepare('UPDATE announcement_drafts SET data_json = ? WHERE id = ? AND status = \'draft\'')
    .run(JSON.stringify(draft.data), draft.id);
}

function templateData(template, data, ctx) {
  const result = { ...data, template };
  const sessionChannel = getConfigValue(ctx.db, 'SESSION_CHANNEL_ID');
  const eventChannel = getConfigValue(ctx.db, 'EVENT_CHANNEL_ID');
  const launch = { type: 'link', label: 'Launch Greenville RP', emoji: '🎮', target: '', optional: true };

  if (template === 'session_started') {
    return {
      ...result,
      title: '🎙️ RP Session Started',
      description: 'A new Greenville RP session is now live. Staff can join using the button below.',
      destinationChannelId: sessionChannel,
      buttons: [launch],
    };
  }
  if (template === 'upcoming_session') {
    return {
      ...result,
      title: '📅 Upcoming RP Session',
      description: 'A Greenville RP session is coming up. Add the date, time, host, and any details before publishing.',
      destinationChannelId: sessionChannel,
      buttons: [launch, ...(validId(sessionChannel) ? [{ type: 'channel', label: 'View Session Channel', emoji: '📍', target: sessionChannel }] : [])],
    };
  }
  if (template === 'special_event') {
    return {
      ...result,
      title: '🎉 Special Greenville RP Event',
      description: 'Join us for a special Greenville RP event. Add the event time and details before publishing.',
      destinationChannelId: eventChannel,
      buttons: validId(eventChannel) ? [{ type: 'channel', label: 'View Event Channel', emoji: '📍', target: eventChannel }] : [],
    };
  }
  return {
    ...result,
    title: '',
    description: '',
    imageUrl: '',
    color: '#4388D1',
    sections: [],
    buttons: [],
    destinationChannelId: getConfigValue(ctx.db, 'STAFF_ANNOUNCEMENT_CHANNEL_ID'),
  };
}

async function openAnnouncementManager(interaction, ctx, { hostId = null, authorized = false } = {}) {
  if (!authorized && !await ensureManagement(interaction, ctx.db)) return;
  if (hostId) {
    const host = await fetchGuildMember(interaction.guild, hostId);
    if (!host || !getStaffRoleName(host, ctx.db)) {
      return interaction.reply({ content: 'The session host must be a current member of a configured staff role.', ephemeral: true });
    }
  }
  const id = createDraft(ctx.db, interaction.user.id, hostId);
  return interaction.reply({
    content: 'Choose a template to start building your announcement. This draft expires after 15 minutes.',
    components: templateMenu(id),
    ephemeral: true,
  });
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseColor(value) {
  if (!/^#?[0-9a-f]{6}$/i.test(value ?? '')) return null;
  return Number.parseInt(value.replace(/^#/, ''), 16);
}

function parseSections(value) {
  if (!value.trim()) return [];
  return value.split('\n').map((line) => {
    const separator = line.indexOf('|');
    if (separator < 0) return { name: 'Details', value: line.trim() };
    return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1).trim() };
  }).filter((section) => section.value);
}

function emojiIsValid(value) {
  if (!value) return true;
  if (value.length > 100 || /\s/.test(value)) return false;
  if (/^<(a?):[A-Za-z0-9_]{2,32}:\d{17,20}>$/.test(value)) return true;
  return /\p{Extended_Pictographic}/u.test(value);
}

function validateDraft(data) {
  const errors = [];
  if (!data.title.trim()) errors.push('Add an embed title before publishing.');
  if (data.title.length > 256) errors.push('Embed titles must be 256 characters or fewer.');
  if (data.description.length > 4096) errors.push('Descriptions must be 4,096 characters or fewer.');
  if (data.imageUrl && !isHttpsUrl(data.imageUrl)) errors.push('Header images must use a valid HTTPS URL.');
  if (parseColor(data.color) === null) errors.push('Embed color must be a six-digit HEX value, such as #4388D1.');
  if (data.sections.length + (data.template === 'session_started' ? 3 : 0) > 25) {
    errors.push(`This embed can contain at most ${data.template === 'session_started' ? 22 : 25} additional sections.`);
  }
  for (const section of data.sections) {
    if (!section.name.trim() || section.name.length > 256) errors.push('Section headings must contain 1 to 256 characters.');
    if (!section.value.trim() || section.value.length > 1024) errors.push('Section text must contain 1 to 1,024 characters.');
  }
  const customButtonLimit = data.template === 'session_started' ? 4 : 5;
  if (data.buttons.length > customButtonLimit) {
    errors.push(`This template supports at most ${customButtonLimit} custom buttons${data.template === 'session_started' ? ' plus Join Session' : ''}.`);
  }
  for (const button of data.buttons) {
    if (!button.label?.trim() || button.label.length > 80) errors.push('Button labels must contain 1 to 80 characters.');
    if (!emojiIsValid(button.emoji ?? '')) errors.push(`The emoji on “${button.label || 'a button'}” is not valid.`);
    if (button.type === 'link' && button.target && !isHttpsUrl(button.target)) errors.push(`“${button.label}” must use a valid HTTPS URL.`);
    if (button.type === 'channel' && !validId(button.target)) errors.push(`Choose a valid channel destination for “${button.label}”.`);
    if (button.type === 'role' && !validId(button.target)) errors.push(`Choose a valid role destination for “${button.label}”.`);
  }
  const embedCharacters = data.title.length + data.description.length
    + data.sections.reduce((total, section) => total + section.name.length + section.value.length, 0)
    + (data.template === 'session_started' ? 100 : 0);
  if (embedCharacters > 6000) errors.push('The combined embed text must be 6,000 characters or fewer.');
  return [...new Set(errors)];
}

function setButtonEmoji(button, emoji) {
  if (!emoji) return button;
  const custom = emoji.match(/^<(a?):([A-Za-z0-9_]{2,32}):(\d{17,20})>$/);
  return button.setEmoji(custom
    ? { id: custom[3], name: custom[2], animated: custom[1] === 'a' }
    : { name: emoji });
}

function buildAnnouncementEmbed(data, { guildId, sessionId, startedAt } = {}) {
  const embed = makeEmbed(parseColor(data.color) ?? config.EMBED_COLORS.info,
    data.title || 'Untitled Announcement', data.description || ' ');
  if (data.imageUrl && isHttpsUrl(data.imageUrl)) embed.setImage(data.imageUrl);
  if (data.template === 'session_started') {
    const hostValue = data.hostId ? `<@${data.hostId}>` : 'Host not selected';
    embed.addFields(
      { name: 'Host', value: hostValue, inline: true },
      { name: 'Started', value: startedAt ? unixTime(startedAt) : 'At publication', inline: true },
    );
    if (sessionId) embed.addFields({ name: 'Session', value: `#${sessionId}`, inline: true });
  }
  if (data.sections.length) embed.addFields(...data.sections);
  embed.setFooter({ text: `GV GR • ${templateLabels[data.template] ?? 'Custom Announcement'}` });
  return embed;
}

function buildCustomButtons(data, draftId, guildId) {
  return data.buttons.flatMap((item) => {
    if (item.type === 'link' && !item.target) return [];
    let button = new ButtonBuilder().setLabel(item.label);
    button = setButtonEmoji(button, item.emoji ?? '');
    if (item.type === 'link') {
      return [button.setStyle(ButtonStyle.Link).setURL(item.target)];
    }
    if (item.type === 'channel') {
      return [button.setStyle(ButtonStyle.Link).setURL(`https://discord.com/channels/${guildId}/${item.target}`)];
    }
    if (item.type === 'role') {
      return [button.setStyle(ButtonStyle.Secondary).setCustomId(`gv:ann:role:${draftId}:${item.target}`)];
    }
    return [];
  });
}

function buildAnnouncementComponents(data, draftId, guildId, { preview = false, sessionId = null } = {}) {
  const buttons = buildCustomButtons(data, draftId, guildId);
  if (data.template === 'session_started') {
    const join = new ButtonBuilder()
      .setCustomId(preview ? 'gv:ann:preview_join' : `gv:session_join:${sessionId}`)
      .setLabel('Join Session')
      .setEmoji('🎙️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(preview);
    buttons.unshift(join);
  }
  return buttons.length ? [new ActionRowBuilder().addComponents(...buttons.slice(0, 5))] : [];
}

function buttonTargetSummary(button) {
  if (button.type === 'link') return button.target || 'URL not set';
  if (button.type === 'channel') return `<#${button.target}>`;
  return `<@&${button.target}>`;
}

function editorPayload(draft) {
  const data = draft.data;
  const destination = data.destinationChannelId ? `<#${data.destinationChannelId}>` : 'Not selected';
  const pending = data.buttons.filter((button) => button.type === 'link' && !button.target).length;
  const buttonSummary = data.buttons.length
    ? data.buttons.map((button, index) => `${index + 1}. ${button.emoji ? `${button.emoji} ` : ''}**${button.label}** · ${buttonTargetSummary(button)}`).join('\n')
    : 'No custom buttons';
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`gv:ann:edit:${draft.id}`)
    .setPlaceholder('Choose what to edit')
    .addOptions(
      { label: 'Edit title, description, image, and color', value: 'content' },
      { label: 'Edit additional sections', value: 'sections' },
      { label: 'Manage buttons', value: 'buttons' },
      { label: 'Set destination channel', value: 'destination' },
      { label: `Toggle @everyone (${data.mentionEveryone ? 'on' : 'off'})`, value: 'mention' },
    );
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:ann:preview:${draft.id}`).setLabel('Preview').setEmoji('👁️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gv:ann:publish:${draft.id}`).setLabel('Review & Publish').setEmoji('📣').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gv:ann:cancel:${draft.id}`).setLabel('Discard').setStyle(ButtonStyle.Danger),
  );
  return {
    content: `**${templateLabels[data.template] ?? 'Announcement'} draft** · Expires in 15 minutes`,
    embeds: [makeEmbed(config.EMBED_COLORS.info, data.title || 'Untitled Announcement',
      `**Destination:** ${destination}\n**@everyone:** ${data.mentionEveryone ? 'Enabled' : 'Disabled'}\n**Buttons:**\n${buttonSummary}${pending ? `\n\n${pending} optional link button(s) need a URL or can be removed.` : ''}`)],
    components: [new ActionRowBuilder().addComponents(menu), controls],
    ephemeral: true,
  };
}

function editorButtonMenu(draft) {
  const options = [
    { label: 'Add link button', value: 'add_link' },
    { label: 'Add channel button', value: 'add_channel' },
    { label: 'Add role contact button', value: 'add_role' },
  ];
  draft.data.buttons.forEach((button, index) => {
    options.push({ label: `Edit ${index + 1}: ${button.label}`.slice(0, 100), value: `edit_${index}` });
    options.push({ label: `Remove ${index + 1}: ${button.label}`.slice(0, 100), value: `remove_${index}` });
  });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`gv:ann:buttons:${draft.id}`)
    .setPlaceholder('Add, edit, or remove a button')
    .addOptions(options.slice(0, 25));
  return {
    content: `**Button editor** · ${draft.data.buttons.length} of ${draft.data.template === 'session_started' ? 4 : 5} custom buttons`,
    embeds: [],
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`gv:ann:edit:${draft.id}`).setLabel('Back to Editor').setStyle(ButtonStyle.Secondary)),
    ],
    ephemeral: true,
  };
}

function editorModal(draft, type, buttonIndex = null) {
  const data = draft.data;
  if (type === 'content') {
    const modal = new ModalBuilder().setCustomId(`gv:ann:content:${draft.id}`).setTitle('Edit Announcement');
    const fields = [
      ['title', 'Embed title', TextInputStyle.Short, 256, data.title],
      ['description', 'Description', TextInputStyle.Paragraph, 4000, data.description],
      ['image', 'Header image HTTPS URL (optional)', TextInputStyle.Short, 500, data.imageUrl],
      ['color', 'Embed color HEX, e.g. #4388D1', TextInputStyle.Short, 7, data.color],
    ];
    return modal.addComponents(...fields.map(([id, label, style, maxLength, value]) => {
      const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
        .setMaxLength(maxLength).setRequired(false);
      if (value) input.setValue(value.slice(0, maxLength));
      return new ActionRowBuilder().addComponents(input);
    }));
  }
  if (type === 'sections') {
    const value = data.sections.map((section) => `${section.name} | ${section.value}`).join('\n');
    const input = new TextInputBuilder().setCustomId('sections').setLabel('One section per line: Heading | Text')
      .setStyle(TextInputStyle.Paragraph).setMaxLength(4000).setRequired(false);
    if (value) input.setValue(value.slice(0, 4000));
    return new ModalBuilder().setCustomId(`gv:ann:sections:${draft.id}`).setTitle('Edit Additional Sections')
      .addComponents(new ActionRowBuilder().addComponents(input));
  }
  const current = buttonIndex === null ? null : data.buttons[buttonIndex];
  const buttonType = current?.type ?? type;
  const buttonLabel = new TextInputBuilder().setCustomId('label').setLabel('Button label')
    .setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
  const emoji = new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)')
    .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
  if (current?.label) buttonLabel.setValue(current.label);
  if (current?.emoji) emoji.setValue(current.emoji);
  const rows = [new ActionRowBuilder().addComponents(buttonLabel), new ActionRowBuilder().addComponents(emoji)];
  if (buttonType === 'link') {
    const url = new TextInputBuilder().setCustomId('url').setLabel('HTTPS URL (blank skips this button)')
      .setStyle(TextInputStyle.Short).setMaxLength(512).setRequired(false);
    if (current?.target) url.setValue(current.target);
    rows.push(new ActionRowBuilder().addComponents(url));
  }
  const action = buttonIndex === null ? `add_${buttonType}` : `edit_${buttonIndex}`;
  return new ModalBuilder().setCustomId(`gv:ann:button:${draft.id}:${action}`).setTitle('Edit Announcement Button')
    .addComponents(...rows);
}

function response(payload) {
  return { ...payload, ephemeral: true };
}

async function replyOrUpdate(interaction, payload) {
  if (typeof interaction.update === 'function' && interaction.message) return interaction.update(payload);
  if (interaction.replied || interaction.deferred) return interaction.followUp(response(payload));
  return interaction.reply(response(payload));
}

async function requireDraft(interaction, ctx, draftId) {
  if (!await ensureManagement(interaction, ctx.db)) return null;
  const draft = getDraft(ctx.db, draftId);
  if (!draft) {
    await replyOrUpdate(interaction, { content: 'This announcement draft was not found. Open the manager again to start a new draft.', components: [], embeds: [] });
    return null;
  }
  if (draft.actor_id !== interaction.user.id) {
    await replyOrUpdate(interaction, { content: 'This announcement draft belongs to another manager.', components: [], embeds: [] });
    return null;
  }
  if (draft.expires_at <= new Date().toISOString()) {
    ctx.db.prepare("UPDATE announcement_drafts SET status = 'expired' WHERE id = ? AND status = 'draft'").run(draft.id);
    await replyOrUpdate(interaction, { content: 'This announcement draft expired. Open the manager again to start a new draft.', components: [], embeds: [] });
    return null;
  }
  if (draft.status !== 'draft') {
    await replyOrUpdate(interaction, { content: draft.status === 'published'
      ? 'This announcement has already been published.'
      : 'This announcement draft can no longer be changed.', components: [], embeds: [] });
    return null;
  }
  return draft;
}

function buttonSelectionPrompt(draft, targetType) {
  const label = new TextInputBuilder().setCustomId('label').setLabel('Button label')
    .setStyle(TextInputStyle.Short).setMaxLength(80).setRequired(true);
  const emoji = new TextInputBuilder().setCustomId('emoji').setLabel('Emoji (optional)')
    .setStyle(TextInputStyle.Short).setMaxLength(100).setRequired(false);
  return new ModalBuilder().setCustomId(`gv:ann:button:${draft.id}:add_${targetType}`).setTitle('Add Announcement Button')
    .addComponents(new ActionRowBuilder().addComponents(label), new ActionRowBuilder().addComponents(emoji));
}

function previewPayload(draft, guildId) {
  const data = draft.data;
  const announcementButtons = buildAnnouncementComponents(data, draft.id, guildId, { preview: true });
  const controls = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:ann:edit:${draft.id}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gv:ann:publish:${draft.id}`).setLabel('Publish').setEmoji('📣').setStyle(ButtonStyle.Primary),
  );
  return {
    content: `**Preview** · ${templateLabels[data.template] ?? 'Announcement'} · Destination: ${data.destinationChannelId ? `<#${data.destinationChannelId}>` : 'not selected'}${data.mentionEveryone ? ' · @everyone enabled' : ''}`,
    embeds: [buildAnnouncementEmbed(data, { guildId })],
    components: [...announcementButtons, controls],
    ephemeral: true,
  };
}

function confirmationPayload(draft, guildId) {
  const payload = previewPayload(draft, guildId);
  payload.content = `Confirm publishing this announcement to <#${draft.data.destinationChannelId}>?${draft.data.mentionEveryone ? ' This will notify @everyone.' : ''}`;
  payload.components = [
    ...buildAnnouncementComponents(draft.data, draft.id, guildId, { preview: true }),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:ann:confirm:${draft.id}`).setLabel('Confirm Publish').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`gv:ann:edit:${draft.id}`).setLabel('Edit').setStyle(ButtonStyle.Secondary),
    ),
  ];
  return payload;
}

function applyButton(data, pending, target = '') {
  const button = { ...pending, target };
  if (pending.index === null) data.buttons.push(button);
  else data.buttons[pending.index] = button;
  delete data.pendingButton;
}

async function handleTemplateSelect(interaction, ctx, draft) {
  const template = interaction.values[0];
  if (!templateLabels[template]) {
    return replyOrUpdate(interaction, { content: 'Choose one of the available announcement templates.', components: [] });
  }
  if (template === 'session_started' && ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) {
    return replyOrUpdate(interaction, { content: 'A session is already active. End it before creating another Session Started announcement.', components: [] });
  }
  draft.data = templateData(template, draft.data, ctx);
  saveDraft(ctx.db, draft);
  if (template === 'session_started' && !draft.data.hostId) {
    const hostSelect = new UserSelectMenuBuilder().setCustomId(`gv:ann:host:${draft.id}`)
      .setPlaceholder('Choose the session host').setMinValues(1).setMaxValues(1);
    return replyOrUpdate(interaction, {
      content: 'Choose the staff member hosting this session.',
      embeds: [],
      components: [new ActionRowBuilder().addComponents(hostSelect)],
    });
  }
  return replyOrUpdate(interaction, editorPayload(draft));
}

async function handleEditorSelect(interaction, ctx, draft) {
  const selection = interaction.values[0];
  if (selection === 'content') return interaction.showModal(editorModal(draft, 'content'));
  if (selection === 'sections') return interaction.showModal(editorModal(draft, 'sections'));
  if (selection === 'buttons') return replyOrUpdate(interaction, editorButtonMenu(draft));
  if (selection === 'destination') {
    const channelMenu = new ChannelSelectMenuBuilder().setCustomId(`gv:ann:destination:${draft.id}`)
      .setPlaceholder('Choose the announcement channel').setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setMinValues(1).setMaxValues(1);
    return replyOrUpdate(interaction, {
      content: 'Select the destination channel.', embeds: [],
      components: [new ActionRowBuilder().addComponents(channelMenu), new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gv:ann:edit:${draft.id}`).setLabel('Back to Editor').setStyle(ButtonStyle.Secondary),
      )],
    });
  }
  if (selection === 'mention') {
    draft.data.mentionEveryone = !draft.data.mentionEveryone;
    saveDraft(ctx.db, draft);
    return replyOrUpdate(interaction, editorPayload(draft));
  }
  return replyOrUpdate(interaction, { content: 'That editor option is not recognized.', components: [] });
}

async function handleButtonMenu(interaction, ctx, draft) {
  const selection = interaction.values[0];
  if (selection.startsWith('remove_')) {
    const index = Number(selection.slice('remove_'.length));
    if (!Number.isSafeInteger(index) || !draft.data.buttons[index]) {
      return replyOrUpdate(interaction, { content: 'That button is no longer available.', components: [] });
    }
    draft.data.buttons.splice(index, 1);
    saveDraft(ctx.db, draft);
    return replyOrUpdate(interaction, editorButtonMenu(draft));
  }
  const isEdit = selection.startsWith('edit_');
  const index = isEdit ? Number(selection.slice('edit_'.length)) : null;
  if (isEdit && (!Number.isSafeInteger(index) || !draft.data.buttons[index])) {
    return replyOrUpdate(interaction, { content: 'That button is no longer available.', components: [] });
  }
  const type = isEdit ? draft.data.buttons[index].type : selection.slice('add_'.length);
  if (!['link', 'channel', 'role'].includes(type)) {
    return replyOrUpdate(interaction, { content: 'Choose a supported button action.', components: [] });
  }
  const limit = draft.data.template === 'session_started' ? 4 : 5;
  if (!isEdit && draft.data.buttons.length >= limit) {
    return replyOrUpdate(interaction, { content: `This template already has the maximum of ${limit} custom buttons.`, components: [] });
  }
  return interaction.showModal(editorModal(draft, type, index));
}

async function getDestination(interaction, ctx, data) {
  if (!validId(data.destinationChannelId)) return { error: 'Select a destination channel before publishing.' };
  let channel;
  try {
    channel = await interaction.client.channels.fetch(data.destinationChannelId);
  } catch {
    return { error: 'The destination channel could not be found.' };
  }
  if (!channel || channel.guildId !== interaction.guild.id || !channel.isTextBased() || !channel.send) {
    return { error: 'Choose a text channel in this server.' };
  }
  const botMember = interaction.guild.members.me;
  const permissions = botMember && channel.permissionsFor(botMember);
  if (!permissions || !permissions.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return { error: 'I need View Channel, Send Messages, and Embed Links permissions in the destination channel.' };
  }
  if (data.mentionEveryone && !permissions.has(PermissionFlagsBits.MentionEveryone)) {
    return { error: 'I need Mention Everyone permission in the destination channel to send this notification.' };
  }
  return { channel };
}

async function validateButtonDestinations(interaction, data) {
  for (const button of data.buttons) {
    if (button.type === 'channel') {
      try {
        const channel = await interaction.guild.channels.fetch(button.target);
        if (!channel || !channel.isTextBased()) return `Choose a text channel for “${button.label}”.`;
      } catch {
        return `The channel for “${button.label}” could not be found.`;
      }
    }
    if (button.type === 'role') {
      try {
        const role = await interaction.guild.roles.fetch(button.target);
        if (!role) return `The role for “${button.label}” could not be found.`;
      } catch {
        return `The role for “${button.label}” could not be found.`;
      }
    }
  }
  return null;
}

async function publishAnnouncement(interaction, ctx, draft) {
  const errors = validateDraft(draft.data);
  if (errors.length) {
    return replyOrUpdate(interaction, { content: errors.join('\n'), embeds: [], components: [
      new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`gv:ann:edit:${draft.id}`).setLabel('Edit Draft').setStyle(ButtonStyle.Secondary)),
    ] });
  }
  const destination = await getDestination(interaction, ctx, draft.data);
  if (destination.error) return replyOrUpdate(interaction, { content: destination.error, embeds: [], components: [] });
  const buttonDestinationError = await validateButtonDestinations(interaction, draft.data);
  if (buttonDestinationError) return replyOrUpdate(interaction, { content: buttonDestinationError, embeds: [], components: [] });

  let host;
  if (draft.data.template === 'session_started') {
    host = await fetchGuildMember(interaction.guild, draft.data.hostId);
    if (!host || !getStaffRoleName(host, ctx.db)) {
      return replyOrUpdate(interaction, { content: 'The selected session host no longer has a configured staff role.', embeds: [], components: [] });
    }
    if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) {
      return replyOrUpdate(interaction, { content: 'Another RP session is already active. This announcement was not published.', embeds: [], components: [] });
    }
  }

  const claimed = ctx.db.prepare("UPDATE announcement_drafts SET status = 'publishing' WHERE id = ? AND actor_id = ? AND status = 'draft'")
    .run(draft.id, interaction.user.id);
  if (!claimed.changes) {
    return replyOrUpdate(interaction, { content: 'This draft has already been submitted and cannot be published twice.', embeds: [], components: [] });
  }

  let sessionId = null;
  let startedAt = null;
  if (host) {
    startedAt = new Date().toISOString();
    try {
      const createSession = ctx.db.transaction(() => {
        if (ctx.db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) throw new Error('An RP session is already active.');
        const result = ctx.db.prepare(`
          INSERT INTO sessions (name, description, host_id, host_name, started_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(draft.data.title, draft.data.description, host.id, host.user.username, startedAt);
        const id = Number(result.lastInsertRowid);
        ctx.db.prepare('INSERT INTO session_participants (session_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)')
          .run(id, host.id, host.user.username, startedAt);
        return id;
      });
      sessionId = createSession();
    } catch (error) {
      ctx.db.prepare("UPDATE announcement_drafts SET status = 'failed' WHERE id = ?").run(draft.id);
      return replyOrUpdate(interaction, { content: `The session could not be started: ${error.message}`, embeds: [], components: [] });
    }
  }

  const payload = {
    content: draft.data.mentionEveryone ? '@everyone' : undefined,
    allowedMentions: { parse: draft.data.mentionEveryone ? ['everyone'] : [] },
    embeds: [buildAnnouncementEmbed(draft.data, { guildId: interaction.guild.id, sessionId, startedAt })],
    components: buildAnnouncementComponents(draft.data, draft.id, interaction.guild.id, { sessionId }),
  };
  let message;
  try {
    message = await destination.channel.send(payload);
  } catch (error) {
    ctx.db.prepare("UPDATE announcement_drafts SET status = 'failed' WHERE id = ? AND status = 'publishing'").run(draft.id);
    console.error('Could not publish announcement:', error.message);
    return replyOrUpdate(interaction, { content: 'The announcement could not be delivered. This draft is locked to prevent an accidental duplicate; open a new draft to retry.', embeds: [], components: [] });
  }

  ctx.db.prepare(`
    UPDATE announcement_drafts SET status = 'published', channel_id = ?, message_id = ? WHERE id = ?
  `).run(message.channelId, message.id, draft.id);
  if (sessionId) {
    ctx.db.prepare('UPDATE sessions SET channel_id = ?, message_id = ? WHERE id = ?')
      .run(message.channelId, message.id, sessionId);
  }
  const logEmbed = makeEmbed(config.EMBED_COLORS.management, '📣 Announcement Published',
    `**${draft.data.title}**\nPosted by <@${interaction.user.id}> in <#${message.channelId}>.`);
  logStaffAction(interaction.client, ctx.db, { embeds: [logEmbed] }).catch(() => {});
  return replyOrUpdate(interaction, { content: `Announcement published in <#${message.channelId}>.`, embeds: [], components: [] });
}

async function handleButtonInteraction(interaction, ctx, draft) {
  const [,, action] = interaction.customId.split(':');
  if (action === 'preview') return replyOrUpdate(interaction, previewPayload(draft, interaction.guild.id));
  if (action === 'edit') return replyOrUpdate(interaction, editorPayload(draft));
  if (action === 'publish') {
    const errors = validateDraft(draft.data);
    if (errors.length) return replyOrUpdate(interaction, {
      content: errors.join('\n'), embeds: [],
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`gv:ann:edit:${draft.id}`).setLabel('Edit Draft').setStyle(ButtonStyle.Secondary))],
    });
    const destination = await getDestination(interaction, ctx, draft.data);
    if (destination.error) return replyOrUpdate(interaction, { content: destination.error, embeds: [], components: [] });
    const buttonError = await validateButtonDestinations(interaction, draft.data);
    if (buttonError) return replyOrUpdate(interaction, { content: buttonError, embeds: [], components: [] });
    return replyOrUpdate(interaction, confirmationPayload(draft, interaction.guild.id));
  }
  if (action === 'confirm') return publishAnnouncement(interaction, ctx, draft);
  if (action === 'cancel') {
    ctx.db.prepare("UPDATE announcement_drafts SET status = 'cancelled' WHERE id = ? AND status = 'draft'").run(draft.id);
    return replyOrUpdate(interaction, { content: 'Announcement draft discarded.', embeds: [], components: [] });
  }
  return replyOrUpdate(interaction, { content: 'That announcement control is not recognized.', embeds: [], components: [] });
}

async function handleSelectInteraction(interaction, ctx, draft) {
  const customId = interaction.customId;
  if (customId.startsWith('gv:ann:template:')) return handleTemplateSelect(interaction, ctx, draft);
  if (customId.startsWith('gv:ann:host:')) {
    const hostId = interaction.values[0];
    const host = await fetchGuildMember(interaction.guild, hostId);
    if (!host || !getStaffRoleName(host, ctx.db)) {
      return replyOrUpdate(interaction, { content: 'Choose a current member of a configured staff role.', components: [] });
    }
    draft.data.hostId = hostId;
    saveDraft(ctx.db, draft);
    return replyOrUpdate(interaction, editorPayload(draft));
  }
  if (customId.startsWith('gv:ann:destination:')) {
    const channelId = interaction.values[0];
    const channel = await interaction.guild.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      return replyOrUpdate(interaction, { content: 'Choose a text channel in this server.', components: [] });
    }
    draft.data.destinationChannelId = channelId;
    saveDraft(ctx.db, draft);
    return replyOrUpdate(interaction, editorPayload(draft));
  }
  if (customId.startsWith('gv:ann:buttonchannel:') || customId.startsWith('gv:ann:buttonrole:')) {
    const target = interaction.values[0];
    if (!draft.data.pendingButton) return replyOrUpdate(interaction, { content: 'That button edit expired.', components: [] });
    applyButton(draft.data, draft.data.pendingButton, target);
    saveDraft(ctx.db, draft);
    return replyOrUpdate(interaction, editorPayload(draft));
  }
  if (customId.startsWith('gv:ann:edit:')) return handleEditorSelect(interaction, ctx, draft);
  if (customId.startsWith('gv:ann:buttons:')) return handleButtonMenu(interaction, ctx, draft);
  return replyOrUpdate(interaction, { content: 'That announcement selection is not recognized.', components: [] });
}

async function handleModalSubmit(interaction, ctx, draft) {
  const [, , type] = interaction.customId.split(':');
  if (type === 'content') {
    const title = interaction.fields.getTextInputValue('title').trim();
    const description = interaction.fields.getTextInputValue('description');
    const imageUrl = interaction.fields.getTextInputValue('image').trim();
    const color = interaction.fields.getTextInputValue('color').trim().toUpperCase();
    if (title.length > 256 || description.length > 4096 || (imageUrl && !isHttpsUrl(imageUrl)) || parseColor(color) === null) {
      return interaction.reply(response({ content: 'Check the title, description, HTTPS image URL, and six-digit HEX color, then submit again.' }));
    }
    draft.data.title = title;
    draft.data.description = description;
    draft.data.imageUrl = imageUrl;
    draft.data.color = color.startsWith('#') ? color : `#${color}`;
    saveDraft(ctx.db, draft);
    return replyOrUpdate(interaction, editorPayload(draft));
  }
  if (type === 'sections') {
    const sections = parseSections(interaction.fields.getTextInputValue('sections'));
    if (sections.length > 25 || sections.some((section) => !section.name || section.name.length > 256 || !section.value || section.value.length > 1024)) {
      return interaction.reply(response({ content: 'Use up to 25 sections. Each heading must be 1–256 characters and each section text 1–1,024 characters.' }));
    }
    draft.data.sections = sections;
    saveDraft(ctx.db, draft);
    return replyOrUpdate(interaction, editorPayload(draft));
  }
  if (type === 'button') {
    const action = interaction.customId.split(':').at(-1);
    const editing = action.startsWith('edit_');
    const index = editing ? Number(action.slice(5)) : null;
    const targetType = editing ? draft.data.buttons[index]?.type : action.slice(4);
    if (!['link', 'channel', 'role'].includes(targetType) || (editing && !draft.data.buttons[index])) {
      return interaction.reply(response({ content: 'That button edit is no longer available.' }));
    }
    const label = interaction.fields.getTextInputValue('label').trim();
    const emoji = interaction.fields.getTextInputValue('emoji').trim();
    if (!label || label.length > 80 || !emojiIsValid(emoji)) {
      return interaction.reply(response({ content: 'Enter a button label of 1–80 characters and a valid optional emoji.' }));
    }
    const pending = { index, type: targetType, label, emoji, target: editing ? draft.data.buttons[index].target : '' };
    if (targetType === 'link') {
      const url = interaction.fields.getTextInputValue('url').trim();
      if (url && !isHttpsUrl(url)) return interaction.reply(response({ content: 'Button links must use a valid HTTPS URL.' }));
      applyButton(draft.data, pending, url);
      saveDraft(ctx.db, draft);
      return replyOrUpdate(interaction, editorPayload(draft));
    }
    draft.data.pendingButton = pending;
    saveDraft(ctx.db, draft);
    const selector = targetType === 'channel'
      ? new ChannelSelectMenuBuilder().setCustomId(`gv:ann:buttonchannel:${draft.id}`).setPlaceholder('Choose a text channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1)
      : new RoleSelectMenuBuilder().setCustomId(`gv:ann:buttonrole:${draft.id}`).setPlaceholder('Choose a role').setMinValues(1).setMaxValues(1);
    return replyOrUpdate(interaction, {
      content: targetType === 'channel' ? 'Choose the channel this button should open.' : 'Choose the role this contact button should reference.',
      embeds: [], components: [new ActionRowBuilder().addComponents(selector)],
    });
  }
  return interaction.reply(response({ content: 'That announcement form is not recognized.' }));
}

async function handleRoleButton(interaction, ctx) {
  const [, , , draftId, roleId] = interaction.customId.split(':');
  const draft = getDraft(ctx.db, draftId);
  const roleConfigured = draft?.status === 'published'
    && draft.data.buttons.some((button) => button.type === 'role' && button.target === roleId);
  const role = roleConfigured ? await interaction.guild.roles.fetch(roleId).catch(() => null) : null;
  if (!role) return interaction.reply(response({ content: 'This role contact action is no longer available.' }));
  return interaction.reply({ content: `Contact role: <@&${roleId}>`, allowedMentions: { parse: [] }, ephemeral: true });
}

async function handleAnnouncementManagerInteraction(interaction, ctx) {
  if (interaction.customId.startsWith('gv:ann:role:')) return handleRoleButton(interaction, ctx);
  if (interaction.customId === 'gv:ann:open') return openAnnouncementManager(interaction, ctx);
  const parts = interaction.customId.split(':');
  const draftId = parts[3];
  const draft = await requireDraft(interaction, ctx, draftId);
  if (!draft) return null;
  if (interaction.isButton()) return handleButtonInteraction(interaction, ctx, draft);
  if (interaction.isModalSubmit()) return handleModalSubmit(interaction, ctx, draft);
  return handleSelectInteraction(interaction, ctx, draft);
}

module.exports = {
  buildAnnouncementComponents,
  buildAnnouncementEmbed,
  createDraft,
  handleAnnouncementManagerInteraction,
  isHttpsUrl,
  openAnnouncementManager,
  parseColor,
  parseSections,
  templateData,
  templateLabels,
  templateMenu,
  validateDraft,
};