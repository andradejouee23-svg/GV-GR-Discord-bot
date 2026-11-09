const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement } = require('./staff');
const { getConfigValue, makeEmbed, setConfigValue, validId } = require('../utils/discord');

const draftLifetimeMs = 30 * 60_000;
const panelDefinitions = {
  staff: { label: 'Staff Duty Panel', title: '🕐 GV GR STAFF DUTY', description: 'Clock in, clock out, or check who is currently on duty.', color: '#8B63C7' },
  economy: { label: 'Economy Panel', title: '💰 GV GR | ECONOMY', description: 'Manage your virtual roleplay money from one place.', color: '#1F7AE0' },
  economy_daily: { label: 'Daily Economy Panel', title: '💰 GV GR | DAILY ECONOMY', description: 'Wallet, games, and shop.', color: '#1F7AE0' },
  shop: { label: 'Economy Shop', title: '🛍️ GV GR Shop', description: 'Browse available GV GR products.', color: '#9B5DE5' },
  townjobs: { label: 'Town Jobs Panel', title: 'GV GR | TOWN JOBS', description: 'Choose a Town Job below.', color: '#8B63C7' },
  vehicle: { label: 'Vehicle Registration Panel', title: '🚘 GV GR VEHICLE REGISTRATION', description: 'Register your roleplay vehicle before driving it in Greenville. Applications are reviewed by GV GR staff.', color: '#36A765' },
  welcome: { label: 'Welcome Messages', title: 'WELCOME TO GV GR!', description: 'Welcome to Greenville RP. We are glad you are here.', color: '#36A765' },
  blacklist: { label: 'Blacklist Management', title: '🛡️ GV GR • BLACKLIST MANAGEMENT', description: 'Manage saved blacklist records and appeals.', color: '#8B63C7' },
  forms: { label: 'Forms', title: 'GV GR Forms', description: 'Select a form to submit.', color: '#4388D1' },
};

function parseHex(value) {
  if (!/^#?[0-9a-f]{6}$/i.test(value ?? '')) return null;
  return Number.parseInt(value.replace(/^#/, ''), 16);
}

function isHttpsUrl(value) {
  if (!value) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}

function getPanelEditorConfig(db, panelKey) {
  const defaults = panelDefinitions[panelKey];
  if (!defaults) throw new Error('Unknown panel type.');
  const row = db.prepare('SELECT * FROM panel_editor_configs WHERE panel_key = ?').get(panelKey);
  return {
    panelKey,
    title: row?.title ?? defaults.title,
    description: row?.description ?? defaults.description,
    footerText: row?.footer_text ?? '',
    authorText: row?.author_text ?? '',
    colorHex: row?.color_hex ?? defaults.color,
    headerImageUrl: row?.header_image_url ?? '',
    headerImagePosition: row?.header_image_position === 'bottom' ? 'bottom' : 'top',
    fields: row ? JSON.parse(row.fields_json ?? '[]') : [],
    buttonLabels: row ? JSON.parse(row.button_labels_json) : [],
    headerChannelId: row?.header_channel_id ?? null,
    headerMessageId: row?.header_message_id ?? null,
  };
}

function applyPanelCustomization(db, panelKey, embed, components = []) {
  const row = db.prepare('SELECT * FROM panel_editor_configs WHERE panel_key = ?').get(panelKey);
  if (!row) return { embed, components };
  const color = parseHex(row.color_hex);
  if (row.title) embed.setTitle(row.title);
  if (row.description != null) embed.setDescription(row.description || ' ');
  if (color !== null) embed.setColor(color);
  embed.setFooter(row.footer_text ? { text: row.footer_text } : null);
  if (row.author_text) embed.setAuthor({ name: row.author_text });
  if (row.header_image_url && row.header_image_position === 'bottom') embed.setImage(row.header_image_url);
  const fieldOverrides = JSON.parse(row.fields_json ?? '[]');
  if (fieldOverrides.length) {
    const fields = (embed.data.fields ?? []).map((field) => ({ name: field.name, value: field.value, inline: Boolean(field.inline) }));
    fieldOverrides.forEach((field, position) => {
      const index = Number.isSafeInteger(field.index) ? field.index : position;
      const current = fields[index] ?? { name: `Section ${index + 1}`, value: ' ' };
      fields[index] = { ...current, name: field.name || current.name, value: field.value || current.value, inline: field.inline ?? current.inline };
    });
    embed.setFields(fields.slice(0, 25));
  }
  const labels = JSON.parse(row.button_labels_json || '[]');
  let buttonIndex = 0;
  for (const rowBuilder of components) {
    for (const component of rowBuilder.components ?? []) {
      const override = labels[buttonIndex++];
      if (!override) continue;
      if (override.label) component.setLabel(override.label);
      if (override.emoji) component.setEmoji(override.emoji);
    }
  }
  return { embed, components };
}

function createDraft(db, actorId, panelKey, now = new Date()) {
  const id = randomUUID().replaceAll('-', '');
  const data = getPanelEditorConfig(db, panelKey);
  const createdAt = now.toISOString();
  db.prepare('INSERT INTO panel_editor_drafts (draft_id, actor_id, panel_key, data_json, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, actorId, panelKey, JSON.stringify(data), new Date(now.getTime() + draftLifetimeMs).toISOString(), createdAt);
  return id;
}

function getDraft(db, draftId, actorId, now = new Date()) {
  const row = db.prepare('SELECT * FROM panel_editor_drafts WHERE draft_id = ? AND actor_id = ?').get(draftId, actorId);
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) {
    db.prepare('DELETE FROM panel_editor_drafts WHERE draft_id = ?').run(draftId);
    return null;
  }
  return { ...row, data: JSON.parse(row.data_json) };
}

function saveDraft(db, draftId, actorId, data) {
  return db.prepare('UPDATE panel_editor_drafts SET data_json = ? WHERE draft_id = ? AND actor_id = ?')
    .run(JSON.stringify(data), draftId, actorId).changes > 0;
}

function panelMenu() {
  return [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('gv:panel_editor:select')
    .setPlaceholder('Choose a panel to customize')
    .addOptions(Object.entries(panelDefinitions).map(([value, panel]) => ({ label: panel.label, value, description: panel.title.slice(0, 100) }))))];
}

function editorButtons(draft) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:panel_editor:text:${draft.draft_id}`).setLabel('Edit Text & Buttons').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`gv:panel_editor:color:${draft.draft_id}`).setLabel('Edit HEX Color').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gv:panel_editor:image:${draft.draft_id}`).setLabel(draft.data.headerImageUrl ? 'Replace / Remove Image' : 'Add Header Image').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gv:panel_editor:position:${draft.draft_id}`).setLabel(`Image: ${draft.data.headerImagePosition === 'bottom' ? 'Bottom' : 'Top'}`).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`gv:panel_editor:sections:${draft.draft_id}`).setLabel('Edit Sections').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:panel_editor:save:${draft.draft_id}`).setLabel('Save & Update Panel').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gv:panel_editor:cancel:${draft.draft_id}`).setLabel('Cancel').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function editorPreview(draft) {
  const data = draft.data;
  const color = parseHex(data.colorHex);
  const embed = makeEmbed(color ?? config.EMBED_COLORS.info, `Preview • ${data.title}`, data.description || ' ');
  if (data.authorText) embed.setAuthor({ name: data.authorText });
  if (data.footerText) embed.setFooter({ text: data.footerText });
  if (data.fields?.length) embed.addFields(...data.fields.slice(0, 10).map((field) => ({ name: field.name, value: field.value, inline: Boolean(field.inline) })));
  if (data.buttonLabels?.length) embed.addFields({ name: 'Button labels', value: data.buttonLabels.map((button, index) => `${index + 1}. ${button.label || '(unchanged)'}`).join('\n').slice(0, 1000) });
  const embeds = data.headerImageUrl && isHttpsUrl(data.headerImageUrl)
    ? data.headerImagePosition === 'bottom'
      ? [embed.setImage(data.headerImageUrl)]
      : [new EmbedBuilder().setColor(color ?? config.EMBED_COLORS.info).setImage(data.headerImageUrl), embed]
    : [embed];
  return { embeds, components: editorButtons(draft) };
}

function textModal(draft) {
  const data = draft.data;
  return new ModalBuilder().setCustomId(`gv:panel_editor:modal:text:${draft.draft_id}`).setTitle(`Edit ${panelDefinitions[draft.panel_key].label}`)
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Panel title').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(256).setValue(data.title).setPlaceholder('Write the title players should see.')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Panel description').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(4000).setValue(data.description).setPlaceholder('Add player-facing instructions and details.')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('footer').setLabel('Footer text (blank removes it)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(2048).setValue(data.footerText)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('author').setLabel('Author text (blank removes it)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(256).setValue(data.authorText)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('buttons').setLabel('Button label|emoji per line, in order').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setValue(data.buttonLabels.map((item) => `${item.label ?? ''}|${item.emoji ?? ''}`).join('\n')).setPlaceholder('Example: Register|📝. Leave blank for defaults.')),
    );
}

function colorModal(draft) {
  return new ModalBuilder().setCustomId(`gv:panel_editor:modal:color:${draft.draft_id}`).setTitle('Preview Panel HEX Color')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('color').setLabel('Six-digit HEX color (#RRGGBB)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(7).setValue(draft.data.colorHex).setPlaceholder('Example: #21A67A.')));
}

function imageModal(draft) {
  return new ModalBuilder().setCustomId(`gv:panel_editor:modal:image:${draft.draft_id}`).setTitle('Panel Header Image')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('HTTPS image URL (blank removes image)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(512).setValue(draft.data.headerImageUrl).setPlaceholder('https://example.com/header.png')));
}

function sectionsModal(draft) {
  const value = (draft.data.fields ?? []).map((field, index) => `${field.index ?? index + 1}|${field.name}|${field.value}${field.inline ? '|inline' : ''}`).join('\n');
  return new ModalBuilder().setCustomId(`gv:panel_editor:modal:sections:${draft.draft_id}`).setTitle('Edit Panel Sections')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fields').setLabel('Field number|heading|description|inline').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000).setValue(value).setPlaceholder('Example: 1|Job name|Player-facing job details|inline')));
}

function panelTarget(db, key) {
  const targets = {
    staff: ['STAFF_ACTIVITY_CHANNEL_ID', 'panel_message'],
    economy: ['ECONOMY_PANEL_MESSAGE_CHANNEL_ID', 'ECONOMY_PANEL_MESSAGE_ID'],
    economy_daily: ['ECONOMY_DAILY_PANEL_MESSAGE_CHANNEL_ID', 'ECONOMY_DAILY_PANEL_MESSAGE_ID'],
    townjobs: ['TOWN_JOBS_PANEL_CHANNEL_ID', 'TOWN_JOBS_PANEL_MESSAGE_ID'],
    vehicle: ['VEHICLE_REGISTRATION_CHANNEL_ID', 'vehicle_panel_message_id'],
    blacklist: ['BLACKLIST_PANEL_CHANNEL_ID', 'BLACKLIST_PANEL_MESSAGE_ID'],
  };
  if (!targets[key]) return null;
  const [channelKey, messageKey] = targets[key];
  return { channelId: getConfigValue(db, channelKey), messageId: getConfigValue(db, messageKey), channelKey, messageKey };
}

async function ensurePanelHeader(client, db, panelKey, channel) {
  const saved = db.prepare('SELECT header_image_url, header_image_position, header_channel_id, header_message_id FROM panel_editor_configs WHERE panel_key = ?').get(panelKey);
  if (!saved) return { created: false, messageId: null };
  if (!saved.header_image_url || saved.header_image_position === 'bottom') {
    if (saved.header_channel_id && saved.header_message_id) {
      try {
        const oldChannel = await client.channels.fetch(saved.header_channel_id);
        const oldHeader = oldChannel?.isTextBased() ? await oldChannel.messages.fetch(saved.header_message_id) : null;
        if (oldHeader?.author?.id === client.user?.id) await oldHeader.delete();
      } catch {}
      db.prepare('UPDATE panel_editor_configs SET header_channel_id = NULL, header_message_id = NULL WHERE panel_key = ?').run(panelKey);
    }
    return { created: false, messageId: null };
  }
  if (saved.header_channel_id === channel.id && saved.header_message_id) {
    try {
      const current = await channel.messages.fetch(saved.header_message_id);
      const currentUrl = current.embeds?.[0]?.image?.url;
      if (current?.author?.id === client.user?.id && currentUrl === saved.header_image_url) return { created: false, messageId: current.id };
    } catch {}
  }
  const data = getPanelEditorConfig(db, panelKey);
  const imageMessage = await channel.send({
    embeds: [new EmbedBuilder().setColor(parseHex(data.colorHex) ?? config.EMBED_COLORS.info).setImage(saved.header_image_url)],
    allowedMentions: { parse: [] },
  });
  if (saved.header_channel_id && saved.header_message_id) {
    try {
      const previousChannel = await client.channels.fetch(saved.header_channel_id);
      const previous = previousChannel?.isTextBased() ? await previousChannel.messages.fetch(saved.header_message_id) : null;
      if (previous?.author?.id === client.user?.id) await previous.delete();
    } catch {}
  }
  db.prepare('UPDATE panel_editor_configs SET header_channel_id = ?, header_message_id = ? WHERE panel_key = ?')
    .run(channel.id, imageMessage.id, panelKey);
  return { created: true, messageId: imageMessage.id };
}

async function renderPanelPayload(db, key, client) {
  let embed;
  let components;
  if (key === 'staff') {
    const guild = client.guilds.cache.get(config.SERVER_ID) ?? await client.guilds.fetch(config.SERVER_ID);
    const clock = require('./clock');
    embed = await clock.buildPanelEmbed(db, guild);
    components = clock.createPanelComponents();
  } else if (key === 'economy') {
    const economy = require('./economy');
    const settings = economy.getEconomySettings(db);
    embed = economy.economyPanelEmbed(settings);
    components = economy.economyPanelComponents();
  } else if (key === 'economy_daily') {
    const economy = require('./economy');
    const settings = economy.getEconomySettings(db);
    embed = economy.economyDailyPanelEmbed(settings);
    components = economy.economyDailyPanelComponents();
  } else if (key === 'townjobs') {
    const townjobs = require('./townJobs');
    const settings = townjobs.getTownJobsSettings(db);
    embed = townjobs.makeJobEmbed(settings);
    components = townjobs.makeJobComponents(settings.options);
  } else if (key === 'vehicle') {
    const vehicles = require('./vehicles');
    embed = vehicles.vehiclePanelEmbed();
    components = vehicles.vehiclePanelComponents();
  } else if (key === 'blacklist') {
    const blacklist = require('./blacklist');
    embed = blacklist.panelEmbed(db);
    components = blacklist.panelComponents();
  } else if (key === 'forms') {
    embed = makeEmbed(config.EMBED_COLORS.info, '📝 GV GR • FORMS', 'Player reports, vehicle registration, and blacklist appeals. Customize this forms information panel through the editor.');
    components = [];
  } else {
    return null;
  }
  const customized = applyPanelCustomization(db, key, embed, components);
  return { embeds: [customized.embed], components: customized.components };
}

async function refreshExistingPanel(client, db, panelKey, data) {
  const target = panelTarget(db, panelKey);
  if (!target || !validId(target.channelId)) return { refreshed: false, reason: 'no-existing-panel' };
  let channel;
  try { channel = await client.channels.fetch(target.channelId); } catch { return { refreshed: false, reason: 'channel' }; }
  if (!channel?.isTextBased() || !channel.send) return { refreshed: false, reason: 'channel' };
  let guild = client.guilds.cache.get(config.SERVER_ID);
  if (!guild) {
    try { guild = await client.guilds.fetch(config.SERVER_ID); } catch { return { refreshed: false, reason: 'guild' }; }
  }
  const permissions = channel.permissionsFor(guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return { refreshed: false, reason: 'permissions' };
  }
  const payload = await renderPanelPayload(db, panelKey, client);
  if (!payload) return { refreshed: false, reason: 'renderer' };
  let oldMessage;
  if (validId(target.messageId)) {
    try { oldMessage = await channel.messages.fetch(target.messageId); } catch {}
  }
  let headerMessage = null;
  if (data.headerImageUrl && data.headerImagePosition !== 'bottom') {
    const imageEmbed = new EmbedBuilder().setColor(parseHex(data.colorHex) ?? config.EMBED_COLORS.info).setImage(data.headerImageUrl);
    headerMessage = await channel.send({ embeds: [imageEmbed], allowedMentions: { parse: [] } });
    const newMessage = await channel.send({ ...payload, allowedMentions: { parse: [] } });
    if (oldMessage?.author?.id === client.user?.id) await oldMessage.delete().catch(() => {});
    const savedConfig = db.prepare('SELECT * FROM panel_editor_configs WHERE panel_key = ?').get(panelKey);
    if (savedConfig?.header_channel_id && savedConfig.header_message_id) {
      try {
        const previousHeader = await channel.messages.fetch(savedConfig.header_message_id);
        if (previousHeader.author?.id === client.user?.id) await previousHeader.delete();
      } catch {}
    }
    db.prepare('UPDATE panel_editor_configs SET header_channel_id = ?, header_message_id = ? WHERE panel_key = ?')
      .run(channel.id, headerMessage.id, panelKey);
    setConfigValue(db, target.messageKey, newMessage.id);
  } else if (oldMessage?.author?.id === client.user?.id) {
    await oldMessage.edit(payload);
  } else {
    const newMessage = await channel.send(payload);
    setConfigValue(db, target.messageKey, newMessage.id);
  }
  if (!data.headerImageUrl || data.headerImagePosition === 'bottom') {
    const savedConfig = db.prepare('SELECT header_channel_id, header_message_id FROM panel_editor_configs WHERE panel_key = ?').get(panelKey);
    if (savedConfig?.header_channel_id && savedConfig.header_message_id) {
      try {
        const oldHeaderChannel = await client.channels.fetch(savedConfig.header_channel_id);
        const oldHeader = oldHeaderChannel?.isTextBased() ? await oldHeaderChannel.messages.fetch(savedConfig.header_message_id) : null;
        if (oldHeader?.author?.id === client.user?.id) await oldHeader.delete();
      } catch {}
      db.prepare('UPDATE panel_editor_configs SET header_channel_id = NULL, header_message_id = NULL WHERE panel_key = ?').run(panelKey);
    }
  }
  return { refreshed: true };
}

async function saveConfiguration(interaction, ctx, draft) {
  const data = draft.data;
  const now = new Date().toISOString();
  ctx.db.prepare(`
    INSERT INTO panel_editor_configs (panel_key, title, description, footer_text, author_text, color_hex,
      header_image_url, header_image_position, fields_json, button_labels_json, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(panel_key) DO UPDATE SET title = excluded.title, description = excluded.description,
      footer_text = excluded.footer_text, author_text = excluded.author_text, color_hex = excluded.color_hex,
      header_image_url = excluded.header_image_url, header_image_position = excluded.header_image_position,
      fields_json = excluded.fields_json, button_labels_json = excluded.button_labels_json,
      updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(draft.panel_key, data.title, data.description, data.footerText, data.authorText, data.colorHex,
    data.headerImageUrl, data.headerImagePosition === 'bottom' ? 'bottom' : 'top', JSON.stringify(data.fields ?? []), JSON.stringify(data.buttonLabels), interaction.user.id, now);
  ctx.db.prepare('DELETE FROM panel_editor_drafts WHERE draft_id = ?').run(draft.draft_id);
  let refreshed = { refreshed: false, reason: 'no-existing-panel' };
  try { refreshed = await refreshExistingPanel(interaction.client, ctx.db, draft.panel_key, data); }
  catch (error) { console.error(`Could not refresh edited ${draft.panel_key} panel:`, error.message); }
  const note = refreshed.refreshed ? ' Existing panel message was refreshed.' : refreshed.reason === 'no-existing-panel' ? ' The customization will apply the next time this panel is generated.' : ' Settings were saved; refresh the panel after checking its channel and bot permissions.';
  return interaction.update({ content: `${panelDefinitions[draft.panel_key].label} customization saved.${note}`, embeds: [], components: [] });
}

async function openPanelEditor(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.management, '🎨 GV GR • PANEL EDITOR', 'Choose a panel to customize. Text, button labels, HEX color, and top or bottom image placement are saved separately for each panel.')], components: panelMenu(), ephemeral: true });
}

async function handlePanelEditorCommand(interaction, ctx) {
  if (interaction.commandName !== 'panel-editor') return null;
  return openPanelEditor(interaction, ctx);
}

async function handlePanelEditorButton(interaction, ctx) {
  const match = interaction.customId.match(/^gv:panel_editor:(text|color|image|position|sections|save|cancel):([a-f0-9]{32})$/);
  if (!match) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, match[2], interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This panel edit expired. Run `/panel-editor` again.', ephemeral: true });
  if (match[1] === 'text') return interaction.showModal(textModal(draft));
  if (match[1] === 'color') return interaction.showModal(colorModal(draft));
  if (match[1] === 'image') return interaction.showModal(imageModal(draft));
  if (match[1] === 'position') {
    draft.data.headerImagePosition = draft.data.headerImagePosition === 'bottom' ? 'top' : 'bottom';
    saveDraft(ctx.db, draft.draft_id, interaction.user.id, draft.data);
    return interaction.update(editorPreview(draft));
  }
  if (match[1] === 'sections') return interaction.showModal(sectionsModal(draft));
  if (match[1] === 'cancel') {
    ctx.db.prepare('DELETE FROM panel_editor_drafts WHERE draft_id = ?').run(draft.draft_id);
    return interaction.update({ content: 'Panel customization cancelled. No saved configuration was changed.', embeds: [], components: [] });
  }
  return saveConfiguration(interaction, ctx, draft);
}

async function handlePanelEditorSelect(interaction, ctx) {
  if (interaction.customId !== 'gv:panel_editor:select') return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const panelKey = interaction.values[0];
  if (!panelDefinitions[panelKey]) return interaction.reply({ content: 'That panel type is not supported.', ephemeral: true });
  const draftId = createDraft(ctx.db, interaction.user.id, panelKey);
  const draft = getDraft(ctx.db, draftId, interaction.user.id);
  return interaction.update(editorPreview(draft));
}

async function handlePanelEditorModal(interaction, ctx) {
  const match = interaction.customId.match(/^gv:panel_editor:modal:(text|color|image|sections):([a-f0-9]{32})$/);
  if (!match) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, match[2], interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This panel edit expired. Run `/panel-editor` again.', ephemeral: true });
  const data = draft.data;
  if (match[1] === 'text') {
    const title = interaction.fields.getTextInputValue('title').trim();
    const description = interaction.fields.getTextInputValue('description').trim();
    const buttonText = interaction.fields.getTextInputValue('buttons').trim();
    if (!title || title.length > 256 || description.length > 4096) return interaction.reply({ content: 'Panel title or description is invalid.', ephemeral: true });
    const buttonLabels = buttonText ? buttonText.split('\n').map((line) => {
      const [label = '', emoji = ''] = line.split('|');
      return { label: label.trim().slice(0, 80), emoji: emoji.trim().slice(0, 100) };
    }) : [];
    if (buttonLabels.some((item) => !item.label)) return interaction.reply({ content: 'Each button override line must include a label before the optional |emoji.', ephemeral: true });
    Object.assign(data, {
      title,
      description,
      footerText: interaction.fields.getTextInputValue('footer').trim(),
      authorText: interaction.fields.getTextInputValue('author').trim(),
      buttonLabels,
    });
  } else if (match[1] === 'color') {
    const color = interaction.fields.getTextInputValue('color').trim();
    if (parseHex(color) === null) return interaction.reply({ content: 'Enter a valid six-digit HEX color, such as #5865F2.', ephemeral: true });
    data.colorHex = color.startsWith('#') ? color.toUpperCase() : `#${color.toUpperCase()}`;
  } else if (match[1] === 'image') {
    const image = interaction.fields.getTextInputValue('image').trim();
    if (!isHttpsUrl(image)) return interaction.reply({ content: 'Header image must be a valid HTTPS URL.', ephemeral: true });
    data.headerImageUrl = image;
  } else {
    const raw = interaction.fields.getTextInputValue('fields').trim();
    const fields = raw ? raw.split('\n').map((line) => {
      const [index = '', name = '', value = '', inline = ''] = line.split('|');
      return { index: Number(index.trim()) - 1, name: name.trim(), value: value.trim(), inline: inline.trim().toLowerCase() === 'inline' };
    }) : [];
    if (fields.some((field) => !Number.isSafeInteger(field.index) || field.index < 0 || field.index >= 25 || !field.name || !field.value || field.name.length > 256 || field.value.length > 1024) || fields.length > 25) {
      return interaction.reply({ content: 'Sections need a field number from 1–25, a 1–256 character heading, and a 1–1,024 character description.', ephemeral: true });
    }
    data.fields = fields;
  }
  saveDraft(ctx.db, draft.draft_id, interaction.user.id, data);
  return interaction.reply({ ...editorPreview({ ...draft, data }), ephemeral: true });
}

module.exports = {
  applyPanelCustomization,
  getPanelEditorConfig,
  ensurePanelHeader,
  openPanelEditor,
  handlePanelEditorButton,
  handlePanelEditorCommand,
  handlePanelEditorModal,
  handlePanelEditorSelect,
  panelDefinitions,
};
