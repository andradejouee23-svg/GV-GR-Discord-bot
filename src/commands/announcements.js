const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { logAudit } = require('../services/staffRewards');
const {
  getConfigValue,
  getInteractionMember,
  validId,
} = require('../utils/discord');
const { createStaffCenterComponents, createStaffStatsEmbed } = require('../utils/staffCenter');
const { isManagement, isStaff } = require('./staffCenter');

const draftLifetimeMs = 30 * 60_000;
const announcementChannels = [
  ['STAFF_ANNOUNCEMENT_CHANNEL_ID', 'Staff announcements'],
  ['EVENT_CHANNEL_ID', 'Events'],
  ['SESSION_CHANNEL_ID', 'RP sessions'],
  ['STAFF_ACTIVITY_CHANNEL_ID', 'Staff activity'],
];

function channelOptions(db) {
  const options = new Map();
  for (const [key, label] of announcementChannels) {
    const channelId = getConfigValue(db, key);
    if (validId(channelId) && !options.has(channelId)) options.set(channelId, { label, value: channelId });
  }
  return [...options.values()];
}

function textInput(id, label, style, maxLength, required, value = '') {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
    .setMaxLength(maxLength).setRequired(required);
  if (value) input.setValue(String(value).slice(0, maxLength));
  return new ActionRowBuilder().addComponents(input);
}

function createContentModal(draftId, payload = {}) {
  return new ModalBuilder().setCustomId(`gv:announce:content:${draftId}`).setTitle('Announcement Content')
    .addComponents(
      textInput('title', 'Title', TextInputStyle.Short, 256, true, payload.title),
      textInput('description', 'Description', TextInputStyle.Paragraph, 3500, true, payload.description),
      textInput('color', 'Color as hex (example: #286F61)', TextInputStyle.Short, 7, true, payload.color || '#286F61'),
      textInput('footer', 'Footer (optional)', TextInputStyle.Short, 2048, false, payload.footer),
      textInput('timestamp', 'Timestamp ISO 8601 (optional)', TextInputStyle.Short, 40, false, payload.timestamp),
    );
}

function createDetailsModal(draftId, payload = {}) {
  return new ModalBuilder().setCustomId(`gv:announce:details:${draftId}`).setTitle('Announcement Details')
    .addComponents(
      textInput('image_url', 'Image URL (HTTPS, optional)', TextInputStyle.Short, 500, false, payload.imageUrl),
      textInput('thumbnail_url', 'Thumbnail URL (HTTPS, optional)', TextInputStyle.Short, 500, false, payload.thumbnailUrl),
      textInput('start_at', 'Starting time ISO 8601 (optional)', TextInputStyle.Short, 40, false, payload.startAt),
      textInput('end_at', 'Ending time ISO 8601 (optional)', TextInputStyle.Short, 40, false, payload.endAt),
      textInput('fields_json', 'Fields JSON array (optional, up to 5)', TextInputStyle.Paragraph, 2000, false,
        payload.fields?.length ? JSON.stringify(payload.fields) : ''),
    );
}

function createCustomMessageModal(draftId, payload = {}) {
  return new ModalBuilder().setCustomId(`gv:announce:custom_content:${draftId}`).setTitle('Compose Custom Message')
    .addComponents(
      textInput('content', 'Message text (optional)', TextInputStyle.Paragraph, 2000, false, payload.content),
      textInput('embeds_json', 'Embeds JSON (0-10, HTTPS images)', TextInputStyle.Paragraph, 4000, false,
        payload.embeds?.length ? JSON.stringify(payload.embeds, null, 2) : ''),
      textInput('reactions', 'Emoji reactions (comma-separated)', TextInputStyle.Short, 200, false,
        (payload.reactions ?? []).join(', ')),
      textInput('buttons_json', 'HTTPS link buttons JSON (0-5)', TextInputStyle.Paragraph, 1000, false,
        payload.buttons?.length ? JSON.stringify(payload.buttons, null, 2) : ''),
    );
}

function createLinkButtonModal(draftId, payload = {}) {
  return new ModalBuilder().setCustomId(`gv:announce:link:${draftId}`).setTitle('Announcement Link Button')
    .addComponents(
      textInput('button_label', 'Button label', TextInputStyle.Short, 80, true, payload.buttonLabel),
      textInput('button_url', 'HTTPS URL', TextInputStyle.Short, 500, true, payload.buttonUrl),
    );
}

function createTemplateNameModal(draftId) {
  return new ModalBuilder().setCustomId(`gv:announce:template_name:${draftId}`).setTitle('Save Announcement Template')
    .addComponents(textInput('name', 'Template name', TextInputStyle.Short, 80, true));
}

function normalizeHttpsUrl(value, label) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) throw new Error('Invalid URL');
    return url.toString();
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
}

function parseFields(value) {
  if (!value.trim()) return [];
  let fields;
  try {
    fields = JSON.parse(value);
  } catch {
    throw new Error('Fields must be valid JSON.');
  }
  if (!Array.isArray(fields) || fields.length > 5) throw new Error('Provide a JSON array with no more than 5 fields.');
  return fields.map((field) => {
    if (!field || typeof field.name !== 'string' || typeof field.value !== 'string'
      || !field.name.trim() || !field.value.trim() || field.name.length > 256 || field.value.length > 1024) {
      throw new Error('Each field needs a name (1-256 characters) and value (1-1024 characters).');
    }
    return { name: field.name.trim(), value: field.value.trim(), inline: Boolean(field.inline) };
  });
}

function validateDate(value, label) {
  if (!value) return '';
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be ISO 8601 with an explicit timezone.`);
  }
  return new Date(value).toISOString();
}

function createAnnouncementEmbed(payload) {
  const colorText = payload.color?.replace(/^#/, '') ?? '';
  if (!/^[0-9a-fA-F]{6}$/.test(colorText)) throw new Error('Color must be a six-digit hex value.');
  if ((payload.title?.length ?? 0) > 256 || (payload.description?.length ?? 0) > 4096
    || (payload.footer?.length ?? 0) > 2048) {
    throw new Error('Title, description, or footer exceeds its Discord embed limit.');
  }
  const totalText = (payload.title?.length ?? 0) + (payload.description?.length ?? 0)
    + (payload.footer?.length ?? 0) + (payload.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (totalText > 6000) throw new Error('Combined embed text exceeds Discord’s 6000-character limit.');
  const embed = new EmbedBuilder().setColor(Number.parseInt(colorText, 16))
    .setTitle(payload.title).setDescription(payload.description);
  if (payload.footer) embed.setFooter({ text: payload.footer });
  if (payload.timestamp) embed.setTimestamp(new Date(payload.timestamp));
  if (payload.imageUrl) embed.setImage(payload.imageUrl);
  if (payload.thumbnailUrl) embed.setThumbnail(payload.thumbnailUrl);
  if (payload.startAt) embed.addFields({ name: 'Starts', value: `<t:${Math.floor(Date.parse(payload.startAt) / 1000)}:F>`, inline: true });
  if (payload.endAt) embed.addFields({ name: 'Ends', value: `<t:${Math.floor(Date.parse(payload.endAt) / 1000)}:F>`, inline: true });
  if (payload.fields?.length) embed.addFields(payload.fields);
  return embed;
}

function parseCustomJson(value, label, fallback) {
  if (!value.trim()) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} must be valid JSON.`); }
}

function validateCustomEmbed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Each embed must be a JSON object.');
  const embed = {};
  const text = (key, max, required = false) => {
    if (value[key] == null) return;
    if (typeof value[key] !== 'string' || value[key].length > max || (required && !value[key].trim())) {
      throw new Error(`Embed ${key} must be text no longer than ${max} characters.`);
    }
    embed[key] = value[key];
  };
  text('title', 256);
  text('description', 4096);
  text('url', 2048);
  if (embed.url) embed.url = normalizeHttpsUrl(embed.url, 'Embed URL');
  if (value.color != null) {
    if (typeof value.color === 'number' && Number.isInteger(value.color) && value.color >= 0 && value.color <= 0xffffff) {
      embed.color = value.color;
    } else if (typeof value.color === 'string' && /^#?[0-9a-fA-F]{6}$/.test(value.color)) {
      embed.color = Number.parseInt(value.color.replace(/^#/, ''), 16);
    } else throw new Error('Embed color must be a six-digit hex value or an integer from 0 to 16777215.');
  }
  if (value.fields != null) {
    if (!Array.isArray(value.fields) || value.fields.length > 25) throw new Error('An embed can contain no more than 25 fields.');
    embed.fields = value.fields.map((field) => {
      if (!field || typeof field.name !== 'string' || !field.name.trim() || field.name.length > 256
        || typeof field.value !== 'string' || !field.value.trim() || field.value.length > 1024) {
        throw new Error('Embed fields need a name (1-256 characters) and value (1-1024 characters).');
      }
      return { name: field.name, value: field.value, inline: Boolean(field.inline) };
    });
  }
  for (const key of ['author', 'footer']) {
    if (value[key] == null) continue;
    const item = value[key];
    const nameKey = key === 'author' ? 'name' : 'text';
    const max = key === 'author' ? 256 : 2048;
    if (!item || typeof item[nameKey] !== 'string' || !item[nameKey].trim() || item[nameKey].length > max) {
      throw new Error(`Embed ${key} ${nameKey} must contain 1-${max} characters.`);
    }
    embed[key] = { [nameKey]: item[nameKey] };
    if (key === 'author' && item.url) embed.author.url = normalizeHttpsUrl(item.url, 'Author URL');
    if (item.icon_url) embed[key].icon_url = normalizeHttpsUrl(item.icon_url, `${key} icon URL`);
  }
  for (const key of ['thumbnail', 'image']) {
    if (value[key] == null) continue;
    if (typeof value[key].url !== 'string' || !value[key].url.trim()) throw new Error(`Embed ${key} must include a URL.`);
    embed[key] = { url: normalizeHttpsUrl(value[key].url, `Embed ${key} URL`) };
  }
  if (value.timestamp != null) {
    if (typeof value.timestamp !== 'string' || !Number.isFinite(Date.parse(value.timestamp))) throw new Error('Embed timestamp must be a valid ISO date.');
    embed.timestamp = new Date(value.timestamp).toISOString();
  }
  const textLength = (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
    + (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0)
    + (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (textLength === 0) throw new Error('Each embed needs a title, description, author, footer, or field.');
  return embed;
}

function validateCustomMessage(fields, guild) {
  const content = fields.content.trim();
  if (content.length > 2000) throw new Error('Message text cannot exceed 2000 characters.');
  const rawEmbeds = parseCustomJson(fields.embeds_json, 'Embeds', []);
  if (!Array.isArray(rawEmbeds) || rawEmbeds.length > 10) throw new Error('Embeds must be an array with no more than 10 items.');
  const embeds = rawEmbeds.map(validateCustomEmbed);
  const totalText = embeds.reduce((total, embed) => total + (embed.title?.length ?? 0) + (embed.description?.length ?? 0)
    + (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0)
    + (embed.fields ?? []).reduce((fieldTotal, field) => fieldTotal + field.name.length + field.value.length, 0), 0);
  if (totalText > 6000) throw new Error('Combined embed text cannot exceed Discord’s 6000-character limit.');
  if (!content && !embeds.length) throw new Error('Add message text or at least one embed.');

  const reactions = fields.reactions.split(/[\n,]+/).map((emoji) => emoji.trim()).filter(Boolean);
  if (reactions.length > 10) throw new Error('Choose no more than 10 reactions.');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const normalizedReactions = reactions.map((emoji) => {
    const custom = /^<a?:[A-Za-z0-9_]{2,32}:(\d{17,20})>$/.exec(emoji);
    if (custom) {
      if (!guild.emojis?.cache?.has(custom[1])) throw new Error(`Custom emoji ${emoji} is not available in this server.`);
      return emoji;
    }
    if ([...segmenter.segment(emoji)].length !== 1 || !/\p{Emoji_Presentation}/u.test(emoji)) {
      throw new Error(`${emoji} is not a single supported emoji.`);
    }
    return emoji;
  });

  const rawButtons = parseCustomJson(fields.buttons_json, 'Buttons', []);
  if (!Array.isArray(rawButtons) || rawButtons.length > 5) throw new Error('Buttons must be an array with no more than 5 items.');
  const buttons = rawButtons.map((button) => {
    if (!button || typeof button.label !== 'string' || !button.label.trim() || button.label.length > 80
      || typeof button.url !== 'string') throw new Error('Each link button needs a label (1-80 characters) and an HTTPS URL.');
    return { label: button.label.trim(), url: normalizeHttpsUrl(button.url, 'Button URL') };
  });
  return { kind: 'custom', content, embeds, reactions: normalizedReactions, buttons };
}

function buildCustomEmbeds(embeds) {
  return embeds.map((value) => {
    const embed = new EmbedBuilder();
    if (value.title) embed.setTitle(value.title);
    if (value.description) embed.setDescription(value.description);
    if (value.url) embed.setURL(value.url);
    if (value.color != null) embed.setColor(value.color);
    if (value.author) embed.setAuthor({ name: value.author.name, url: value.author.url, iconURL: value.author.icon_url });
    if (value.footer) embed.setFooter({ text: value.footer.text, iconURL: value.footer.icon_url });
    if (value.thumbnail) embed.setThumbnail(value.thumbnail.url);
    if (value.image) embed.setImage(value.image.url);
    if (value.fields?.length) embed.addFields(value.fields);
    if (value.timestamp) embed.setTimestamp(new Date(value.timestamp));
    return embed;
  });
}

function customLinkComponents(buttons) {
  if (!buttons?.length) return [];
  return [new ActionRowBuilder().addComponents(buttons.map((button) => new ButtonBuilder()
    .setLabel(button.label).setStyle(ButtonStyle.Link).setURL(button.url)))];
}

function customPreviewComponents(draft) {
  return [
    ...customLinkComponents(draft.payload.buttons),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:announce:publish:${draft.draft_id}`).setLabel('Publish').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gv:announce:revise:${draft.draft_id}`).setLabel('Edit').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gv:announce:save_template:${draft.draft_id}`).setLabel('Save Template').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gv:announce:cancel:${draft.draft_id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function validateCustomPermissions(channel, interaction, payload) {
  const botMember = interaction.guild.members.me ?? interaction.client.user;
  const permissions = channel.permissionsFor?.(botMember);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages)) {
    throw new Error('I need View Channel and Send Messages permissions in the selected destination.');
  }
  if (payload.embeds.length && !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    throw new Error('I need Embed Links permission to publish this custom message.');
  }
  if (payload.reactions.length && !permissions.has(PermissionFlagsBits.AddReactions)) {
    throw new Error('I need Add Reactions permission to apply the selected reactions.');
  }
}

function createDraft(db, ownerId, flow, payload, publishedId = null) {
  const draftId = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO announcement_drafts
    (draft_id, owner_id, flow, published_id, payload_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(draftId, ownerId, flow, publishedId, JSON.stringify(payload), new Date(Date.now() + draftLifetimeMs).toISOString(), now);
  return draftId;
}

function getDraft(db, draftId, ownerId) {
  const row = db.prepare(`SELECT * FROM announcement_drafts WHERE draft_id = ? AND owner_id = ?
    AND status = 'pending' AND expires_at > ?`).get(draftId, ownerId, new Date().toISOString());
  return row ? { ...row, payload: JSON.parse(row.payload_json) } : null;
}

function updateDraft(db, draft, payload, channelId = draft.channel_id) {
  db.prepare('UPDATE announcement_drafts SET payload_json = ?, channel_id = ? WHERE draft_id = ? AND owner_id = ? AND status = \'pending\'')
    .run(JSON.stringify(payload), channelId, draft.draft_id, draft.owner_id);
  return { ...draft, payload, channel_id: channelId };
}

function actionRows(draft, preview = true, announcementId = null) {
  if (draft.payload.kind === 'custom') {
    return preview ? customPreviewComponents(draft) : customLinkComponents(draft.payload.buttons);
  }
  const rows = [];
  if (draft.payload.buttonType === 'link' && draft.payload.buttonUrl) {
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setLabel(draft.payload.buttonLabel).setStyle(ButtonStyle.Link).setURL(draft.payload.buttonUrl)));
  } else if (draft.payload.buttonType === 'staff_center') {
    rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId('gv:announce:staff_center')
      .setLabel(draft.payload.buttonLabel || 'Open Staff Center').setStyle(ButtonStyle.Primary).setDisabled(preview)));
  }
  if (preview) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:announce:publish:${draft.draft_id}`)
        .setLabel(draft.flow === 'edit' ? 'Update Announcement' : 'Publish').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gv:announce:save_template:${draft.draft_id}`).setLabel('Save Template').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gv:announce:revise:${draft.draft_id}`).setLabel('Revise').setStyle(ButtonStyle.Secondary),
    ));
  }
  return rows;
}

function previewContent(draft) {
  return `${draft.flow === 'edit' ? 'Preview of the update' : 'Preview before publishing'}${draft.channel_id ? ` in <#${draft.channel_id}>` : ''}. Check the embed and button before confirming.`;
}

function channelSelect(draftId, db) {
  const channels = channelOptions(db);
  if (!channels.length) return null;
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`gv:announce:channel:${draftId}`).setPlaceholder('Choose an authorized announcement channel')
    .addOptions(channels.map((channel) => ({ label: channel.label, value: channel.value }))))];
}

function resolveAnnouncementTemplate(payload, db) {
  const joinCode = getConfigValue(db, 'SESSION_JOIN_CODE') ?? '';
  const joinUrl = getConfigValue(db, 'SESSION_JOIN_URL') ?? '';
  const tokens = {
    join_code: joinCode || 'Not configured by the Owner',
    join_url: joinUrl ? `[Open Greenville](${joinUrl})` : '',
    join_instructions: joinCode
      ? '1. Open Greenville.\n2. Open the Custom Servers menu.\n3. Search for GV GR or enter the code above.\n4. Join the session.'
      : 'The Owner has not configured a custom-server join code.',
  };
  const replace = (value) => {
    if (typeof value === 'string') return value.replace(/\{(join_code|join_url|join_instructions)\}/g, (_, key) => tokens[key]);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]));
    return value;
  };
  return replace(payload);
}

async function replyWithPreview(interaction, draft, db, update = false) {
  let embeds;
  if (draft.payload.kind === 'custom') {
    embeds = buildCustomEmbeds(draft.payload.embeds);
  } else {
    try {
      embeds = [createAnnouncementEmbed(draft.payload)];
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
  }
  const preview = {
    content: draft.payload.kind === 'custom'
      ? `${previewContent(draft)}${draft.payload.content ? `\n\n${draft.payload.content}` : ''}`
      : previewContent(draft),
    embeds,
    components: actionRows(draft),
    allowedMentions: { parse: [] },
  };
  return update ? interaction.update(preview) : interaction.reply({ ...preview, ephemeral: true });
}

async function openChannelChoice(interaction, draft, db) {
  const components = channelSelect(draft.draft_id, db);
  if (!components) return interaction.reply({ content: 'Configure at least one announcement destination in Owner Settings before publishing.', ephemeral: true });
  return interaction.reply({ content: 'Choose a configured public announcement channel.', components, ephemeral: true });
}

async function startCustomAnnouncement(interaction, ctx) {
  if (!await requireManagement(interaction, ctx.db)) return;
  const channels = channelOptions(ctx.db);
  if (!channels.length) return interaction.reply({ content: 'Configure an announcement destination in Owner Settings before composing a custom message.', ephemeral: true });
  const draftId = createDraft(ctx.db, interaction.user.id, 'create', {
    kind: 'custom', content: '', embeds: [], reactions: [], buttons: [],
  });
  return interaction.reply({
    content: 'Choose a configured destination for the custom message.',
    components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`gv:announce:custom_channel:${draftId}`).setPlaceholder('Choose a destination channel')
      .addOptions(channels.map((channel) => ({ label: channel.label, value: channel.value }))))],
    ephemeral: true,
  });
}

async function requireManagement(interaction, db) {
  const member = await getInteractionMember(interaction);
  if (member && isManagement(member, interaction.guild, db)) return true;
  await interaction.reply({ content: 'The announcement builder is available to configured management roles only.', ephemeral: true });
  return false;
}

async function handleAnnouncementCommand(interaction, ctx) {
  if (interaction.commandName !== 'announcement-builder') return null;
  if (!await requireManagement(interaction, ctx.db)) return;
  const action = interaction.options.getSubcommand();
  if (action === 'create') {
    ctx.db.prepare('DELETE FROM announcement_drafts WHERE expires_at <= ?').run(new Date().toISOString());
    const draftId = createDraft(ctx.db, interaction.user.id, 'create', {
      title: '', description: '', color: '#286F61', footer: '', timestamp: '', imageUrl: '', thumbnailUrl: '',
      startAt: '', endAt: '', fields: [], buttonType: 'none', buttonLabel: '', buttonUrl: '',
    });
    return interaction.showModal(createContentModal(draftId));
  }
  if (action === 'edit') {
    const announcements = ctx.db.prepare(`SELECT id, title, channel_id, created_at FROM bot_announcements
      ORDER BY updated_at DESC LIMIT 25`).all();
    if (!announcements.length) return interaction.reply({ content: 'No bot-published announcement is available to edit.', ephemeral: true });
    return interaction.reply({ content: 'Select a bot-published announcement to edit.', components: [new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('gv:announce:edit_select').setPlaceholder('Choose an announcement')
        .addOptions(announcements.map((entry) => ({ label: entry.title.slice(0, 100), description: `<#${entry.channel_id}> • ${entry.created_at.slice(0, 10)}`, value: String(entry.id) }))),
    )], ephemeral: true });
  }
  const templates = ctx.db.prepare('SELECT id, name FROM announcement_templates ORDER BY name COLLATE NOCASE LIMIT 25').all();
  if (!templates.length) return interaction.reply({ content: 'No reusable announcement templates have been saved yet.', ephemeral: true });
  return interaction.reply({ content: 'Choose a template to preview and publish.', components: [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('gv:announce:template_select').setPlaceholder('Choose a saved template')
      .addOptions(templates.map((template) => ({ label: template.name.slice(0, 100), value: String(template.id) }))),
  )], ephemeral: true });
}

async function handleAnnouncementModal(interaction, ctx) {
  if (!await requireManagement(interaction, ctx.db)) return;
  const [, , step, draftId] = interaction.customId.split(':');
  let draft = getDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This announcement draft expired. Start again with `/announcement-builder create`.', ephemeral: true });
  const payload = { ...draft.payload };

  if (step === 'content') {
    payload.title = interaction.fields.getTextInputValue('title').trim();
    payload.description = interaction.fields.getTextInputValue('description').trim();
    payload.color = interaction.fields.getTextInputValue('color').trim();
    payload.footer = interaction.fields.getTextInputValue('footer').trim();
    try {
      payload.timestamp = validateDate(interaction.fields.getTextInputValue('timestamp').trim(), 'Timestamp');
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    if (!payload.title || !payload.description) return interaction.reply({ content: 'Title and description are required.', ephemeral: true });
    try { createAnnouncementEmbed(payload); } catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
    draft = updateDraft(ctx.db, draft, payload);
    return interaction.showModal(createDetailsModal(draftId, payload));
  }

  if (step === 'custom_content') {
    let customPayload;
    try {
      customPayload = validateCustomMessage({
        content: interaction.fields.getTextInputValue('content'),
        embeds_json: interaction.fields.getTextInputValue('embeds_json'),
        reactions: interaction.fields.getTextInputValue('reactions'),
        buttons_json: interaction.fields.getTextInputValue('buttons_json'),
      }, interaction.guild);
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    const updated = updateDraft(ctx.db, draft, customPayload, draft.channel_id);
    return replyWithPreview(interaction, updated, ctx.db);
  }

  if (step === 'details') {
    try {
      payload.imageUrl = normalizeHttpsUrl(interaction.fields.getTextInputValue('image_url').trim(), 'Image URL');
      payload.thumbnailUrl = normalizeHttpsUrl(interaction.fields.getTextInputValue('thumbnail_url').trim(), 'Thumbnail URL');
      payload.startAt = validateDate(interaction.fields.getTextInputValue('start_at').trim(), 'Starting time');
      payload.endAt = validateDate(interaction.fields.getTextInputValue('end_at').trim(), 'Ending time');
      if (payload.startAt && payload.endAt && Date.parse(payload.endAt) <= Date.parse(payload.startAt)) {
        throw new Error('Ending time must be after starting time.');
      }
      payload.fields = parseFields(interaction.fields.getTextInputValue('fields_json'));
      createAnnouncementEmbed(payload);
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    updateDraft(ctx.db, draft, payload);
    return interaction.reply({ content: 'Choose an optional button. Only HTTPS links and the built-in Staff Center action are supported.',
      components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
        .setCustomId(`gv:announce:button_type:${draftId}`).setPlaceholder('Choose button behavior')
        .addOptions(
          { label: 'No button', value: 'none' },
          { label: 'HTTPS link button', value: 'link' },
          { label: 'Open Staff Center', value: 'staff_center' },
        ))], ephemeral: true });
  }

  if (step === 'link') {
    const label = interaction.fields.getTextInputValue('button_label').trim();
    if (!label) return interaction.reply({ content: 'Enter a button label.', ephemeral: true });
    try { payload.buttonUrl = normalizeHttpsUrl(interaction.fields.getTextInputValue('button_url').trim(), 'Button URL'); }
    catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
    payload.buttonLabel = label;
    payload.buttonType = 'link';
    updateDraft(ctx.db, draft, payload);
    return draft.flow === 'edit'
      ? replyWithPreview(interaction, { ...draft, payload }, ctx.db)
      : openChannelChoice(interaction, { ...draft, payload }, ctx.db);
  }

  if (step === 'template_name') {
    const name = interaction.fields.getTextInputValue('name').trim();
    if (!name) return interaction.reply({ content: 'Enter a template name.', ephemeral: true });
    const now = new Date().toISOString();
    ctx.db.prepare(`INSERT INTO announcement_templates (name, payload_json, creator_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET payload_json = excluded.payload_json,
      creator_id = excluded.creator_id, updated_at = excluded.updated_at`)
      .run(name, JSON.stringify(draft.payload), interaction.user.id, now, now);
    return interaction.reply({ content: `Template **${name}** saved.`, ephemeral: true });
  }
  return interaction.reply({ content: 'This announcement form is not recognized.', ephemeral: true });
}

async function handleAnnouncementSelect(interaction, ctx) {
  if (!await requireManagement(interaction, ctx.db)) return;
  if (interaction.customId === 'gv:announce:edit_select') {
    const announcement = ctx.db.prepare('SELECT * FROM bot_announcements WHERE id = ?').get(Number(interaction.values[0]));
    if (!announcement) return interaction.reply({ content: 'That announcement is no longer available.', ephemeral: true });
    const draftId = createDraft(ctx.db, interaction.user.id, 'edit', JSON.parse(announcement.payload_json), announcement.id);
    const draft = getDraft(ctx.db, draftId, interaction.user.id);
    updateDraft(ctx.db, draft, draft.payload, announcement.channel_id);
    if (draft.payload.kind === 'custom') return interaction.showModal(createCustomMessageModal(draftId, draft.payload));
    return interaction.showModal(createContentModal(draftId, draft.payload));
  }
  if (interaction.customId === 'gv:announce:template_select') {
    const template = ctx.db.prepare('SELECT * FROM announcement_templates WHERE id = ?').get(Number(interaction.values[0]));
    if (!template) return interaction.reply({ content: 'That template is no longer available.', ephemeral: true });
    const payload = resolveAnnouncementTemplate(JSON.parse(template.payload_json), ctx.db);
    const draftId = createDraft(ctx.db, interaction.user.id, 'create', payload);
    const draft = getDraft(ctx.db, draftId, interaction.user.id);
    return openChannelChoice(interaction, draft, ctx.db);
  }
  if (interaction.customId.startsWith('gv:announce:button_type:')) {
    const draftId = interaction.customId.split(':').at(-1);
    const draft = getDraft(ctx.db, draftId, interaction.user.id);
    if (!draft) return interaction.reply({ content: 'This announcement draft expired.', ephemeral: true });
    const type = interaction.values[0];
    if (!['none', 'link', 'staff_center'].includes(type)) return interaction.reply({ content: 'Unsupported announcement button action.', ephemeral: true });
    const payload = { ...draft.payload, buttonType: type, buttonLabel: type === 'staff_center' ? 'Open Staff Center' : '', buttonUrl: '' };
    updateDraft(ctx.db, draft, payload);
    if (type === 'link') return interaction.showModal(createLinkButtonModal(draftId, payload));
    return draft.flow === 'edit'
      ? replyWithPreview(interaction, { ...draft, payload }, ctx.db)
      : openChannelChoice(interaction, { ...draft, payload }, ctx.db);
  }
  if (interaction.customId.startsWith('gv:announce:custom_channel:')) {
    const draftId = interaction.customId.split(':').at(-1);
    const draft = getDraft(ctx.db, draftId, interaction.user.id);
    if (!draft || draft.payload.kind !== 'custom') return interaction.reply({ content: 'This custom message draft expired.', ephemeral: true });
    const channelId = interaction.values[0];
    if (!channelOptions(ctx.db).some((entry) => entry.value === channelId)) {
      return interaction.reply({ content: 'Choose a configured announcement destination.', ephemeral: true });
    }
    updateDraft(ctx.db, draft, draft.payload, channelId);
    return interaction.showModal(createCustomMessageModal(draftId, draft.payload));
  }
  if (interaction.customId.startsWith('gv:announce:channel:')) {
    const draftId = interaction.customId.split(':').at(-1);
    const draft = getDraft(ctx.db, draftId, interaction.user.id);
    if (!draft) return interaction.reply({ content: 'This announcement draft expired.', ephemeral: true });
    const allowed = channelOptions(ctx.db).some((entry) => entry.value === interaction.values[0]);
    if (!allowed) return interaction.reply({ content: 'Choose a configured announcement channel.', ephemeral: true });
    const updated = updateDraft(ctx.db, draft, draft.payload, interaction.values[0]);
    return replyWithPreview(interaction, updated, ctx.db);
  }
  return interaction.reply({ content: 'This announcement selection is not recognized.', ephemeral: true });
}

async function handleAnnouncementButton(interaction, ctx) {
  const parts = interaction.customId.split(':');
  if (parts[2] === 'staff_center') {
    const member = await getInteractionMember(interaction);
    if (!member || !isStaff(member, interaction.guild, ctx.db)) {
      return interaction.reply({ content: 'The Staff Center is available to configured staff only.', ephemeral: true });
    }
    return interaction.reply({ embeds: [createStaffStatsEmbed(ctx.db, interaction.user.id, interaction.user.username)],
      components: createStaffCenterComponents(), ephemeral: true });
  }
  if (!await requireManagement(interaction, ctx.db)) return;
  const [, , action, draftId] = parts;
  const draft = getDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This announcement draft expired or was already processed.', ephemeral: true });
  if (action === 'revise') return draft.payload.kind === 'custom'
    ? interaction.showModal(createCustomMessageModal(draftId, draft.payload))
    : interaction.showModal(createContentModal(draftId, draft.payload));
  if (action === 'save_template') return interaction.showModal(createTemplateNameModal(draftId));
  if (action === 'cancel') {
    ctx.db.prepare("UPDATE announcement_drafts SET status = 'cancelled' WHERE draft_id = ? AND owner_id = ? AND status = 'pending'")
      .run(draftId, interaction.user.id);
    return interaction.update({ content: 'Custom message draft cancelled.', embeds: [], components: [] });
  }
  if (action !== 'publish') return interaction.reply({ content: 'This announcement action is not recognized.', ephemeral: true });
  if (!channelOptions(ctx.db).some((entry) => entry.value === draft.channel_id)) {
    return interaction.reply({ content: 'The target is no longer a configured announcement channel.', ephemeral: true });
  }
  await interaction.deferUpdate();
  const claimed = ctx.db.prepare("UPDATE announcement_drafts SET status = 'publishing' WHERE draft_id = ? AND owner_id = ? AND status = 'pending'")
    .run(draftId, interaction.user.id);
  if (!claimed.changes) return interaction.editReply({ content: 'This announcement is already being published.', embeds: [], components: [] });
  let publicationStarted = false;
  let message;
  try {
    const channel = await interaction.client.channels.fetch(draft.channel_id);
    if (!channel?.isTextBased() || !channel.send || (channel.guildId && channel.guildId !== interaction.guild.id)) {
      throw new Error('The configured announcement channel is unavailable in this server.');
    }
    const custom = draft.payload.kind === 'custom';
    if (custom) validateCustomPermissions(channel, interaction, draft.payload);
    const embeds = custom ? buildCustomEmbeds(draft.payload.embeds) : [createAnnouncementEmbed(draft.payload)];
    const components = actionRows(draft, false);
    const safePayload = { content: custom ? draft.payload.content : '', embeds, components, allowedMentions: { parse: [] } };
    const title = custom ? draft.payload.embeds.find((embed) => embed.title)?.title ?? 'Custom Message' : draft.payload.title;
    if (draft.flow === 'edit') {
      const existing = ctx.db.prepare('SELECT * FROM bot_announcements WHERE id = ?').get(draft.published_id);
      if (!existing || existing.channel_id !== draft.channel_id) throw new Error('The saved announcement target changed; start a new edit.');
      message = await channel.messages.fetch(existing.message_id);
      if (message.author?.id !== interaction.client.user.id) throw new Error('The saved message is not authored by this bot.');
      publicationStarted = true;
      await message.edit(safePayload);
      ctx.db.prepare('UPDATE bot_announcements SET title = ?, payload_json = ?, updated_at = ? WHERE id = ?')
        .run(title, JSON.stringify(draft.payload), new Date().toISOString(), existing.id);
    } else {
      publicationStarted = true;
      message = await channel.send(safePayload);
      const now = new Date().toISOString();
      ctx.db.prepare(`INSERT INTO bot_announcements (creator_id, channel_id, message_id, title, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(interaction.user.id, channel.id, message.id, title, JSON.stringify(draft.payload), now, now);
    }
    const reactionFailures = [];
    if (custom) {
      for (const emoji of draft.payload.reactions) {
        try { await message.react(emoji); }
        catch (error) {
          reactionFailures.push(emoji);
          console.error(`Could not add requested announcement reaction ${emoji}:`, error.message);
        }
      }
      if (reactionFailures.length) {
        const storedPayload = { ...draft.payload, reactionFailures };
        ctx.db.prepare('UPDATE bot_announcements SET payload_json = ? WHERE channel_id = ? AND message_id = ?')
          .run(JSON.stringify(storedPayload), channel.id, message.id);
      }
    }
    ctx.db.prepare("UPDATE announcement_drafts SET status = 'published' WHERE draft_id = ?").run(draftId);
    logAudit(ctx.db, {
      action: draft.flow === 'edit' ? 'announcement_edited' : 'announcement_published',
      targetId: interaction.guild.id, actorId: interaction.user.id,
      reason: `${draft.flow === 'edit' ? 'Updated' : 'Published'} announcement: ${title}`,
      details: { channelId: channel.id, messageId: message.id, publishedId: draft.published_id },
    });
    const result = reactionFailures.length
      ? `Message ${draft.flow === 'edit' ? 'updated' : 'published'} in <#${channel.id}>, but these reactions could not be added: ${reactionFailures.join(' ')}. The message was not resent.`
      : `Announcement ${draft.flow === 'edit' ? 'updated' : 'published'} in <#${channel.id}>.`;
    return interaction.editReply({ content: result, embeds: [], components: [] });
  } catch (error) {
    if (!publicationStarted) {
      ctx.db.prepare("UPDATE announcement_drafts SET status = 'pending' WHERE draft_id = ? AND status = 'publishing'").run(draftId);
      return interaction.editReply({ content: `Announcement was not published: ${error.message}`, embeds: [], components: [] });
    }
    console.error('Announcement publication may have partially succeeded:', error.message);
    return interaction.editReply({ content: `Discord may have accepted this publication, but a later operation failed. Do not retry this draft; check the destination for the message first. Error: ${error.message}`, embeds: [], components: [] });
  }
}

module.exports = {
  createAnnouncementEmbed,
  resolveAnnouncementTemplate,
  handleAnnouncementButton,
  handleAnnouncementCommand,
  handleAnnouncementModal,
  handleAnnouncementSelect,
  parseFields,
  startCustomAnnouncement,
  validateCustomMessage,
};