const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement } = require('./staff');
const { getConfigValue, makeEmbed, setConfigValue, validId } = require('../utils/discord');
const { applyPanelCustomization, ensurePanelHeader } = require('./panelEditor');

const draftLifetimeMs = 30 * 60_000;
const durations = new Map([
  ['1 day', 24], ['1d', 24], ['3 days', 72], ['3d', 72], ['7 days', 168], ['7d', 168],
  ['14 days', 336], ['14d', 336], ['30 days', 720], ['30d', 720], ['permanent', null],
]);

function makeId(prefix) {
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
}

function parseDuration(value) {
  return durations.has(String(value ?? '').trim().toLowerCase()) ? durations.get(String(value).trim().toLowerCase()) : undefined;
}

function durationLabel(hours) {
  if (hours == null) return 'Permanent';
  return `${hours / 24} day${hours === 24 ? '' : 's'}`;
}

function createDraft(db, actorId, type, recordId = null, data = {}, now = new Date()) {
  const id = randomUUID().replaceAll('-', '');
  const nowIso = now.toISOString();
  db.prepare(`
    INSERT INTO blacklist_form_drafts (draft_id, actor_id, draft_type, record_id, stage, data_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(id, actorId, type, recordId, JSON.stringify(data), new Date(now.getTime() + draftLifetimeMs).toISOString(), nowIso);
  return id;
}

function getDraft(db, id, actorId, type, now = new Date()) {
  const draft = db.prepare('SELECT * FROM blacklist_form_drafts WHERE draft_id = ? AND actor_id = ? AND draft_type = ?').get(id, actorId, type);
  if (!draft) return null;
  if (draft.expires_at <= now.toISOString()) {
    db.prepare('DELETE FROM blacklist_form_drafts WHERE draft_id = ?').run(id);
    return null;
  }
  return { ...draft, data: JSON.parse(draft.data_json) };
}

function updateDraft(db, draftId, actorId, { stage, data }) {
  return db.prepare('UPDATE blacklist_form_drafts SET stage = ?, data_json = ? WHERE draft_id = ? AND actor_id = ?')
    .run(stage, JSON.stringify(data), draftId, actorId).changes > 0;
}

function textInput(id, label, { required = false, style = TextInputStyle.Short, value, maxLength = 1000 } = {}) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label.slice(0, 45)).setStyle(style).setRequired(required).setMaxLength(maxLength);
  if (value) input.setValue(String(value).slice(0, maxLength));
  return new ActionRowBuilder().addComponents(input);
}

function blacklistCreateModal(draftId) {
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:create:${draftId}:1`).setTitle('GV GR • Blacklist Player')
    .addComponents(
      textInput('roblox_name', 'Roblox Username', { required: true, maxLength: 50 }),
      textInput('roblox_id', 'Roblox User ID', { required: true, maxLength: 32 }),
      textInput('discord_name', 'Discord Username', { required: true, maxLength: 100 }),
      textInput('discord_id', 'Discord User ID', { required: true, maxLength: 20 }),
      textInput('reason', 'Reason for Blacklist', { required: true, style: TextInputStyle.Paragraph, maxLength: 1000 }),
    );
}

function blacklistDetailsModal(draftId, data = {}) {
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:create:${draftId}:2`).setTitle('GV GR • Evidence & Duration')
    .addComponents(
      textInput('evidence', 'Evidence or Evidence Link', { value: data.evidence, style: TextInputStyle.Paragraph, maxLength: 1000 }),
      textInput('duration', 'Duration: 1d, 3d, 7d, 14d, 30d, permanent', { required: true, value: data.duration ?? '7d', maxLength: 20 }),
      textInput('staff_notes', 'Additional Staff Notes', { value: data.staff_notes, style: TextInputStyle.Paragraph, maxLength: 1000 }),
    );
}

function appealModalOne(draftId) {
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:appeal:${draftId}`).setTitle('GV GR • Blacklist Appeal')
    .addComponents(
      textInput('roblox_name', 'Roblox Username', { required: true, maxLength: 50 }),
      textInput('reconsideration', 'Reason for appealing', { required: true, style: TextInputStyle.Paragraph, maxLength: 1000 }),
    );
}

function recordEmbed(record) {
  return makeEmbed(record.status === 'active' ? config.EMBED_COLORS.error : config.EMBED_COLORS.info,
    `⛔ GV GR BLACKLIST • ${record.record_id}`,
    `**Status:** ${record.status.toUpperCase()}\n**Roblox:** ${record.roblox_username} • ID ${record.roblox_user_id || 'Not provided'}\n**Discord:** ${record.discord_username} • ID ${record.discord_user_id || 'Not provided'}\n**Reason:** ${record.reason}\n**Duration:** ${durationLabel(record.duration_hours)}\n**Expires:** ${record.expires_at ? `<t:${Math.floor(new Date(record.expires_at).getTime() / 1000)}:F>` : 'Never'}\n**Evidence:** ${record.evidence || 'None provided'}\n**Staff notes:** ${record.staff_notes || 'None'}\n**Created by:** <@${record.created_by}> • <t:${Math.floor(new Date(record.created_at).getTime() / 1000)}:F>`)
    .setFooter({ text: 'GV GR • Permanent moderation record' });
}

function panelEmbed(db) {
  const active = db.prepare("SELECT COUNT(*) AS count FROM blacklist_records WHERE status = 'active'").get().count;
  const pending = db.prepare("SELECT COUNT(*) AS count FROM blacklist_appeals WHERE status IN ('pending', 'info_requested')").get().count;
  return makeEmbed(config.EMBED_COLORS.management, '🛡️ GV GR • BLACKLIST MANAGEMENT',
    'Protect the Greenville RP community with traceable, reviewable moderation records.\n\n'
    + '⛔ **Blacklist Player**\nCreate a timed or permanent record with evidence and staff notes.\n\n'
    + '📝 **Appeal Blacklist**\nSubmit a review request linked to a saved record.\n\n'
    + '🛠️ **Edit Blacklist**\nUpdate a record through preview and confirmation.\n\n'
    + '🔎 **Search Records**\nSearch saved records and appeals by ID, player, or status.')
    .addFields(
      { name: 'ACTIVE RECORDS', value: String(active), inline: true },
      { name: 'APPEALS TO REVIEW', value: String(pending), inline: true },
    )
    .setFooter({ text: 'GV GR • Records remain stored after expiry or removal' });
}

function panelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gv:blacklist:blacklist').setLabel('Blacklist Player').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('gv:blacklist:appeal').setLabel('Appeal Blacklist').setEmoji('📝').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('gv:blacklist:edit').setLabel('Edit Blacklist').setEmoji('🛠️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gv:blacklist:search').setLabel('Search Records').setEmoji('🔎').setStyle(ButtonStyle.Secondary),
  )];
}

function writeRecordHistory(db, recordId, actorId, action, changes = {}, now = new Date().toISOString()) {
  db.prepare('INSERT INTO blacklist_record_history (record_id, actor_id, action, changes_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(recordId, actorId, action, JSON.stringify(changes), now);
}

function writeAppealHistory(db, appealId, actorId, action, details = {}, now = new Date().toISOString()) {
  db.prepare('INSERT INTO blacklist_appeal_history (appeal_id, actor_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(appealId, actorId, action, JSON.stringify(details), now);
}

function expirationFromDuration(durationHours, now = new Date()) {
  return durationHours == null ? null : new Date(now.getTime() + durationHours * 3_600_000).toISOString();
}

function makeRecordIdUnique(db) {
  let id;
  do { id = makeId('BL'); } while (db.prepare('SELECT 1 FROM blacklist_records WHERE record_id = ?').get(id));
  return id;
}

async function postRecord(client, db, record) {
  const channelId = getConfigValue(db, 'BLACKLIST_CHANNEL_ID');
  if (!validId(channelId)) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return false;
    const message = await channel.send({ embeds: [recordEmbed(record)], allowedMentions: { parse: [] } });
    db.prepare('UPDATE blacklist_records SET channel_id = ?, message_id = ? WHERE record_id = ?')
      .run(channel.id, message.id, record.record_id);
    return true;
  } catch (error) {
    console.error(`Could not post blacklist record ${record.record_id}:`, error.message);
    return false;
  }
}

async function updateRecordMessage(client, record) {
  if (!record.channel_id || !record.message_id) return false;
  try {
    const channel = await client.channels.fetch(record.channel_id);
    const message = channel?.isTextBased() ? await channel.messages.fetch(record.message_id) : null;
    if (!message) return false;
    await message.edit({ embeds: [recordEmbed(record)], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    console.error(`Could not refresh blacklist record ${record.record_id}:`, error.message);
    return false;
  }
}

async function publishPanel(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const channel = interaction.options.getChannel('channel') ?? await interaction.client.channels.fetch(getConfigValue(ctx.db, 'BLACKLIST_PANEL_CHANNEL_ID')).catch(() => null);
  if (!channel?.isTextBased() || !channel.send) return interaction.reply({ content: 'Choose a text channel for the blacklist management panel.', ephemeral: true });
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel) || !permissions.has(PermissionFlagsBits.SendMessages) || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: 'The bot needs View Channel, Send Messages, and Embed Links in the panel channel.', ephemeral: true });
  }
  const oldChannelId = getConfigValue(ctx.db, 'BLACKLIST_PANEL_CHANNEL_ID');
  let oldMessageId = getConfigValue(ctx.db, 'BLACKLIST_PANEL_MESSAGE_ID');
  const header = await ensurePanelHeader(interaction.client, ctx.db, 'blacklist', channel);
  if (header.created && oldChannelId === channel.id && oldMessageId) {
    try { const previous = await channel.messages.fetch(oldMessageId); if (previous.author?.id === interaction.client.user?.id) await previous.delete(); } catch {}
    setConfigValue(ctx.db, 'BLACKLIST_PANEL_MESSAGE_ID', null);
    oldMessageId = null;
  }
  let message;
  if (oldChannelId === channel.id && validId(oldMessageId)) {
      try {
        const customized = applyPanelCustomization(ctx.db, 'blacklist', panelEmbed(ctx.db), panelComponents());
        message = await (await channel.messages.fetch(oldMessageId)).edit({ embeds: [customized.embed], components: customized.components });
      } catch {}
  }
  if (!message) {
    const customized = applyPanelCustomization(ctx.db, 'blacklist', panelEmbed(ctx.db), panelComponents());
    message = await channel.send({ embeds: [customized.embed], components: customized.components });
  }
  setConfigValue(ctx.db, 'BLACKLIST_PANEL_CHANNEL_ID', channel.id);
  setConfigValue(ctx.db, 'BLACKLIST_PANEL_MESSAGE_ID', message.id);
  return interaction.reply({ content: `GV GR Blacklist Panel ${oldMessageId ? 'refreshed' : 'posted'} in <#${channel.id}>.`, ephemeral: true });
}

async function configureBlacklist(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const changes = [];
  const panel = interaction.options.getChannel('panel-channel');
  const records = interaction.options.getChannel('record-channel');
  const appeals = interaction.options.getChannel('appeal-channel');
  if (panel) changes.push(['BLACKLIST_PANEL_CHANNEL_ID', panel.id]);
  if (records) changes.push(['BLACKLIST_CHANNEL_ID', records.id]);
  if (appeals) changes.push(['BLACKLIST_APPEAL_REVIEW_CHANNEL_ID', appeals.id]);
  if (!changes.length) return interaction.reply({ content: 'Choose at least one blacklist channel to configure.', ephemeral: true });
  ctx.db.transaction(() => { for (const [key, value] of changes) setConfigValue(ctx.db, key, value); })();
  return interaction.reply({ content: `Saved blacklist channel settings: ${changes.map(([key]) => `**${key}**`).join(', ')}.`, ephemeral: true });
}

async function startBlacklistDraft(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const id = createDraft(ctx.db, interaction.user.id, 'blacklist');
  return interaction.showModal(blacklistCreateModal(id));
}

async function completeBlacklistCreate(interaction, ctx, draftId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'blacklist');
  if (!draft || draft.stage !== 1) return interaction.reply({ content: 'This blacklist form expired. Start again from the panel.', ephemeral: true });
  const data = Object.fromEntries(['roblox_name', 'roblox_id', 'discord_name', 'discord_id', 'reason'].map((key) => [key, interaction.fields.getTextInputValue(key).trim()]));
  if (Object.values(data).some((value) => !value)) return interaction.reply({ content: 'Complete every required blacklist field.', ephemeral: true });
  updateDraft(ctx.db, draftId, interaction.user.id, { stage: 2, data });
  return interaction.reply({
    content: 'Player details saved. Continue to enter evidence, duration, and private staff notes.',
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(`gv:blacklist:continue:create:${draftId}`).setLabel('Continue Blacklist Form').setStyle(ButtonStyle.Primary))],
    ephemeral: true,
  });
}

async function continueBlacklistCreate(interaction, ctx, draftId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'blacklist');
  if (!draft || draft.stage !== 2) return interaction.reply({ content: 'This blacklist form expired. Start again from the panel.', ephemeral: true });
  return interaction.showModal(blacklistDetailsModal(draftId, draft.data));
}

async function saveBlacklistCreate(interaction, ctx, draftId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'blacklist');
  if (!draft || draft.stage !== 2) return interaction.reply({ content: 'This blacklist form expired. Start again from the panel.', ephemeral: true });
  const evidence = interaction.fields.getTextInputValue('evidence').trim();
  const durationHours = parseDuration(interaction.fields.getTextInputValue('duration'));
  const staffNotes = interaction.fields.getTextInputValue('staff_notes').trim();
  if (durationHours === undefined) return interaction.reply({ content: 'Choose 1d, 3d, 7d, 14d, 30d, or permanent.', ephemeral: true });
  const data = draft.data;
  const createdAt = new Date().toISOString();
  const recordId = makeRecordIdUnique(ctx.db);
  const expiresAt = expirationFromDuration(durationHours);
  try {
    ctx.db.transaction(() => {
      const existing = ctx.db.prepare(`
        SELECT record_id FROM blacklist_records WHERE status = 'active'
          AND ((roblox_user_id = ? AND ? != '') OR (discord_user_id = ? AND ? != '')
          OR lower(roblox_username) = lower(?) OR lower(discord_username) = lower(?)) LIMIT 1
      `).get(data.roblox_id, data.roblox_id, data.discord_id, data.discord_id, data.roblox_name, data.discord_name);
      if (existing) throw new Error(`This player already has active blacklist record ${existing.record_id}.`);
      ctx.db.prepare(`
        INSERT INTO blacklist_records (record_id, roblox_username, roblox_user_id, discord_username, discord_user_id,
          reason, evidence, duration_hours, status, staff_notes, created_by, created_at, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).run(recordId, data.roblox_name, data.roblox_id, data.discord_name, data.discord_id, data.reason, evidence,
        durationHours, staffNotes, interaction.user.id, createdAt, expiresAt, createdAt);
      writeRecordHistory(ctx.db, recordId, interaction.user.id, 'created', data, createdAt);
      ctx.db.prepare('DELETE FROM blacklist_form_drafts WHERE draft_id = ?').run(draftId);
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || /already has active blacklist/.test(error.message)) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    console.error('Could not save blacklist record:', error);
    return interaction.reply({ content: 'The blacklist record could not be saved. No record was announced; check the bot logs and try again.', ephemeral: true });
  }
  const record = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(recordId);
  const posted = await postRecord(interaction.client, ctx.db, record);
  return interaction.reply({
    content: posted ? `Player was blacklisted. Record **${recordId}** was saved and posted.` : `Player was blacklisted. Record **${recordId}** was saved. Configure the record channel to publish its announcement.`,
    embeds: [recordEmbed(record)],
    ephemeral: true,
  });
}

async function startAppeal(interaction, ctx) {
  if (interaction.user.bot) return interaction.reply({ content: 'Bot accounts cannot submit blacklist appeals.', ephemeral: true });
  const id = createDraft(ctx.db, interaction.user.id, 'appeal', null, { discord_id: interaction.user.id });
  return interaction.showModal(appealModalOne(id));
}

async function postAppeal(client, db, appeal) {
  const channelId = getConfigValue(db, 'BLACKLIST_APPEAL_REVIEW_CHANNEL_ID');
  if (!validId(channelId)) return false;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.send) return false;
    const message = await channel.send({ embeds: [appealEmbed(appeal)], components: [appealComponents(appeal.appeal_id)], allowedMentions: { parse: [] } });
    db.prepare('UPDATE blacklist_appeals SET review_channel_id = ?, review_message_id = ? WHERE appeal_id = ?')
      .run(channel.id, message.id, appeal.appeal_id);
    return true;
  } catch (error) {
    console.error(`Could not post blacklist appeal ${appeal.appeal_id}:`, error.message);
    return false;
  }
}

async function submitAppeal(interaction, ctx, draftId) {
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'appeal');
  if (!draft || draft.stage !== 1) return interaction.reply({ content: 'This appeal form expired. Start again from the blacklist panel.', ephemeral: true });
  const data = {
    ...draft.data,
    roblox_name: interaction.fields.getTextInputValue('roblox_name').trim(),
    reconsideration: interaction.fields.getTextInputValue('reconsideration').trim(),
  };
  if (!data.roblox_name || !data.reconsideration) return interaction.reply({ content: 'Enter the Roblox username and a reason for appealing.', ephemeral: true });
  const record = ctx.db.prepare(`
    SELECT * FROM blacklist_records
    WHERE status IN ('active', 'expired')
      AND lower(roblox_username) = lower(?)
      AND (discord_user_id = ? OR discord_user_id IS NULL OR discord_user_id = '')
    ORDER BY status = 'active' DESC, created_at DESC LIMIT 1
  `).get(data.roblox_name, interaction.user.id);
  if (!record) return interaction.reply({ content: 'No active or expired blacklist record for that Roblox username is linked to your Discord account.', ephemeral: true });
  const appealId = makeId('AP');
  const submittedAt = new Date().toISOString();
  try {
    ctx.db.transaction(() => {
      const open = ctx.db.prepare("SELECT appeal_id FROM blacklist_appeals WHERE record_id = ? AND applicant_id = ? AND status IN ('pending', 'info_requested')").get(record.record_id, interaction.user.id);
      if (open) throw new Error(`You already have an appeal in progress (${open.appeal_id}).`);
      ctx.db.prepare(`
        INSERT INTO blacklist_appeals (appeal_id, record_id, applicant_id, roblox_username, roblox_user_id,
          discord_username, blacklist_record_id, reconsideration_reason, incident_explanation, return_reason, evidence, status, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(appealId, record.record_id, interaction.user.id, record.roblox_username, record.roblox_user_id ?? '',
        interaction.user.username, record.record_id, data.reconsideration, '', '', '', submittedAt);
      writeAppealHistory(ctx.db, appealId, interaction.user.id, 'submitted', { recordId: record.record_id, reason: data.reconsideration }, submittedAt);
      ctx.db.prepare('DELETE FROM blacklist_form_drafts WHERE draft_id = ?').run(draftId);
    })();
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  const appeal = ctx.db.prepare('SELECT * FROM blacklist_appeals WHERE appeal_id = ?').get(appealId);
  const posted = await postAppeal(interaction.client, ctx.db, appeal);
  return interaction.reply({ content: posted ? `Appeal **${appealId}** was submitted for management review.` : `Appeal **${appealId}** was saved, but the review channel is not configured.`, ephemeral: true });
}

function appealEmbed(appeal) {
  return makeEmbed(appeal.status === 'pending' ? config.EMBED_COLORS.warning : config.EMBED_COLORS.info,
    `📨 BLACKLIST APPEAL • ${appeal.appeal_id}`,
    `**Status:** ${appeal.status.toUpperCase()}\n**Record:** ${appeal.record_id || appeal.blacklist_record_id}\n**Applicant:** <@${appeal.applicant_id}> • ${appeal.discord_username}\n**Roblox:** ${appeal.roblox_username} • ID ${appeal.roblox_user_id || 'Not provided'}\n\n**Reconsideration request**\n${appeal.reconsideration_reason}\n\n**Incident explanation**\n${appeal.incident_explanation}\n\n**Why should they return?**\n${appeal.return_reason}\n\n**Evidence**\n${appeal.evidence || 'None provided'}${appeal.applicant_response ? `\n\n**Applicant response**\n${appeal.applicant_response}` : ''}${appeal.decision_reason ? `\n\n**Decision / Request:** ${appeal.decision_reason}` : ''}`)
    .setFooter({ text: 'GV GR • Management review only' })
    .setTimestamp(new Date(appeal.submitted_at));
}

function appealComponents(appealId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:blacklist:review:approve:${appealId}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gv:blacklist:review:deny:${appealId}`).setLabel('Deny').setEmoji('⛔').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gv:blacklist:review:info:${appealId}`).setLabel('Request More Info').setEmoji('❓').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gv:blacklist:review:edit:${appealId}`).setLabel('Edit Appeal').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gv:blacklist:review:notes:${appealId}`).setLabel('Private Notes').setEmoji('🗒️').setStyle(ButtonStyle.Secondary),
  )];
}

function appealEditModal(appeal) {
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:appeal-edit:${appeal.appeal_id}`).setTitle(`Edit Appeal • ${appeal.appeal_id}`)
    .addComponents(
      textInput('record_id', 'Blacklist Record ID', { value: appeal.blacklist_record_id, maxLength: 32 }),
      textInput('reconsideration', 'Reconsideration request', { required: true, value: appeal.reconsideration_reason, style: TextInputStyle.Paragraph, maxLength: 800 }),
      textInput('incident', 'Incident explanation', { required: true, value: appeal.incident_explanation, style: TextInputStyle.Paragraph, maxLength: 1000 }),
      textInput('return_reason', 'Why should they be allowed back?', { required: true, value: appeal.return_reason, style: TextInputStyle.Paragraph, maxLength: 1000 }),
      textInput('evidence', 'Evidence / additional information', { value: appeal.evidence, style: TextInputStyle.Paragraph, maxLength: 1000 }),
    );
}

async function submitAppealEdit(interaction, ctx, appealId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const appeal = ctx.db.prepare("SELECT * FROM blacklist_appeals WHERE appeal_id = ? AND status IN ('pending', 'info_requested')").get(appealId);
  if (!appeal) return interaction.reply({ content: 'This appeal is already closed or could not be found.', ephemeral: true });
  const recordInput = interaction.fields.getTextInputValue('record_id').trim();
  const record = ctx.db.prepare('SELECT record_id FROM blacklist_records WHERE upper(record_id) = upper(?)').get(recordInput);
  if (!record) return interaction.reply({ content: 'Enter the ID of an existing blacklist record.', ephemeral: true });
  const changes = {
    record_id: record.record_id,
    reconsideration_reason: interaction.fields.getTextInputValue('reconsideration').trim(),
    incident_explanation: interaction.fields.getTextInputValue('incident').trim(),
    return_reason: interaction.fields.getTextInputValue('return_reason').trim(),
    evidence: interaction.fields.getTextInputValue('evidence').trim(),
  };
  if (!changes.reconsideration_reason || !changes.incident_explanation || !changes.return_reason) {
    return interaction.reply({ content: 'Complete all required appeal statements.', ephemeral: true });
  }
  const now = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE blacklist_appeals SET record_id = ?, blacklist_record_id = ?, reconsideration_reason = ?, incident_explanation = ?, return_reason = ?, evidence = ? WHERE appeal_id = ?`)
      .run(changes.record_id, changes.record_id, changes.reconsideration_reason, changes.incident_explanation, changes.return_reason, changes.evidence, appealId);
    writeAppealHistory(ctx.db, appealId, interaction.user.id, 'appeal_edited', changes, now);
  })();
  const updated = ctx.db.prepare('SELECT * FROM blacklist_appeals WHERE appeal_id = ?').get(appealId);
  await updateAppealMessage(interaction.client, updated);
  return interaction.reply({ content: `Appeal ${appealId} was updated and added to its history.`, ephemeral: true });
}

function appealActionModal(appealId, action) {
  const approve = action === 'approve';
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:review:${action}:${appealId}`).setTitle(approve ? 'Approve Blacklist Appeal' : action === 'deny' ? 'Deny Blacklist Appeal' : action === 'info' ? 'Request More Information' : 'Add Private Management Notes')
    .addComponents(
      textInput(approve ? 'resolution' : 'message', approve ? 'remove or duration (1d/3d/7d/14d/30d/permanent)' : action === 'notes' ? 'Private management notes' : 'Message to applicant', { required: true, style: TextInputStyle.Paragraph, maxLength: 1000 }),
      ...(approve ? [textInput('management_note', 'Private management note (optional)', { style: TextInputStyle.Paragraph, maxLength: 1000 })] : []),
    );
}

async function reviewAppeal(interaction, ctx, action, appealId, values) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const appeal = ctx.db.prepare("SELECT * FROM blacklist_appeals WHERE appeal_id = ? AND status IN ('pending', 'info_requested')").get(appealId);
  if (!appeal) return interaction.reply({ content: 'This appeal is already closed or could not be found.', ephemeral: true });
  const now = new Date().toISOString();
  let record = appeal.record_id ? ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(appeal.record_id) : null;
  if (action === 'approve') {
    const resolution = values.resolution.trim().toLowerCase();
    const durationHours = parseDuration(resolution);
    if (resolution !== 'remove' && durationHours === undefined) return interaction.reply({ content: 'Choose remove, 1d, 3d, 7d, 14d, 30d, or permanent.', ephemeral: true });
    if (!record) return interaction.reply({ content: 'The linked blacklist record no longer exists.', ephemeral: true });
    const removed = resolution === 'remove';
    const expiresAt = removed ? null : expirationFromDuration(durationHours);
    try {
      ctx.db.transaction(() => {
        const changed = ctx.db.prepare(`UPDATE blacklist_appeals SET status = 'approved', reviewer_id = ?, reviewed_at = ?, decision_reason = ?, management_notes = ? WHERE appeal_id = ? AND status IN ('pending', 'info_requested')`)
          .run(interaction.user.id, now, removed ? 'Blacklist removed' : `Duration changed to ${durationLabel(durationHours)}`, values.management_note ?? '', appealId);
        if (!changed.changes) throw new Error('This appeal was already processed.');
        ctx.db.prepare('UPDATE blacklist_records SET status = ?, duration_hours = ?, expires_at = ?, updated_at = ? WHERE record_id = ?')
          .run(removed ? 'removed' : 'active', removed ? record.duration_hours : durationHours, expiresAt, now, record.record_id);
        writeRecordHistory(ctx.db, record.record_id, interaction.user.id, removed ? 'appeal_approved_removed' : 'appeal_approved_duration_changed', { previousStatus: record.status, newStatus: removed ? 'removed' : 'active', durationHours: removed ? null : durationHours, expiresAt }, now);
        writeAppealHistory(ctx.db, appealId, interaction.user.id, 'approved', { resolution, managementNote: values.management_note ?? '' }, now);
      })();
    } catch (error) { return interaction.reply({ content: error.message, ephemeral: true }); }
    const updatedRecord = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(record.record_id);
    await updateRecordMessage(interaction.client, updatedRecord);
    return finishAppealReview(interaction, ctx, appealId, 'approved', `Your appeal was approved. ${removed ? 'The blacklist record was removed.' : `The record duration is now ${durationLabel(durationHours)}.`}`);
  }
  if (action === 'deny' || action === 'info') {
    const status = action === 'deny' ? 'denied' : 'info_requested';
    ctx.db.transaction(() => {
      const changed = ctx.db.prepare('UPDATE blacklist_appeals SET status = ?, reviewer_id = ?, reviewed_at = ?, decision_reason = ? WHERE appeal_id = ? AND status IN (\'pending\', \'info_requested\')')
        .run(status, interaction.user.id, now, values.message, appealId);
      if (!changed.changes) throw new Error('This appeal was already processed.');
      writeAppealHistory(ctx.db, appealId, interaction.user.id, action === 'deny' ? 'denied' : 'more_information_requested', { message: values.message }, now);
    })();
    if (action === 'info') {
      await notifyAppealApplicant(interaction.client, appeal, `Management requests more information for appeal ${appealId}: ${values.message}\nRespond with /blacklist respond appeal-id:${appealId} text:<your response>.`);
      const updated = ctx.db.prepare('SELECT * FROM blacklist_appeals WHERE appeal_id = ?').get(appealId);
      await updateAppealMessage(interaction.client, updated);
      return interaction.reply({ content: 'A request for more information was sent to the applicant.', ephemeral: true });
    }
    return finishAppealReview(interaction, ctx, appealId, 'denied', `Your appeal was denied: ${values.message}`);
  }
  if (action === 'notes') {
    const updatedNotes = `${appeal.management_notes ? `${appeal.management_notes}\n` : ''}[${now}] ${interaction.user.id}: ${values.message}`;
    ctx.db.prepare('UPDATE blacklist_appeals SET management_notes = ? WHERE appeal_id = ?').run(updatedNotes, appealId);
    writeAppealHistory(ctx.db, appealId, interaction.user.id, 'private_note_added', { note: values.message }, now);
    return interaction.reply({ content: 'Private management note saved.', ephemeral: true });
  }
  return interaction.reply({ content: 'Unknown appeal action.', ephemeral: true });
}

async function notifyAppealApplicant(client, appeal, message) {
  try { const user = await client.users.fetch(appeal.applicant_id); await user.send({ content: message }); return true; }
  catch (error) { console.error(`Could not DM blacklist appeal applicant ${appeal.applicant_id}:`, error.message); return false; }
}

async function finishAppealReview(interaction, ctx, appealId, status, message) {
  const appeal = ctx.db.prepare('SELECT * FROM blacklist_appeals WHERE appeal_id = ?').get(appealId);
  await updateAppealMessage(interaction.client, appeal);
  const sent = await notifyAppealApplicant(interaction.client, appeal, `GV GR blacklist appeal ${appealId}: ${message}`);
  return interaction.reply({ content: `Appeal ${appealId} ${status}.${sent ? ' The applicant was notified by DM.' : ' The applicant DMs are unavailable.'}`, ephemeral: true });
}

async function updateAppealMessage(client, appeal) {
  if (!appeal.review_channel_id || !appeal.review_message_id) return false;
  try {
    const channel = await client.channels.fetch(appeal.review_channel_id);
    const msg = channel?.isTextBased() ? await channel.messages.fetch(appeal.review_message_id) : null;
    if (!msg) return false;
    const components = ['pending', 'info_requested'].includes(appeal.status) ? appealComponents(appeal.appeal_id) : [];
    await msg.edit({ embeds: [appealEmbed(appeal)], components, allowedMentions: { parse: [] } });
    return true;
  } catch (error) { console.error(`Could not update blacklist appeal ${appeal.appeal_id}:`, error.message); return false; }
}

function findResults(db, query) {
  const needle = query.trim();
  if (!needle) return [];
  const recordStatus = ['active', 'expired', 'removed'].find((status) => status === needle.toLowerCase());
  const appealStatus = ['pending', 'approved', 'denied', 'info_requested'].find((status) => status === needle.toLowerCase());
  const records = recordStatus
    ? db.prepare('SELECT * FROM blacklist_records WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(recordStatus)
    : db.prepare(`SELECT * FROM blacklist_records WHERE record_id LIKE ? OR roblox_username LIKE ? OR roblox_user_id LIKE ? OR discord_username LIKE ? OR discord_user_id LIKE ? OR status LIKE ? ORDER BY created_at DESC LIMIT 100`)
      .all(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`);
  const appeals = appealStatus
    ? db.prepare('SELECT * FROM blacklist_appeals WHERE status = ? ORDER BY submitted_at DESC LIMIT 100').all(appealStatus)
    : db.prepare(`SELECT * FROM blacklist_appeals WHERE appeal_id LIKE ? OR record_id LIKE ? OR applicant_id LIKE ? OR roblox_username LIKE ? OR roblox_user_id LIKE ? OR discord_username LIKE ? OR status LIKE ? ORDER BY submitted_at DESC LIMIT 100`)
      .all(`%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`, `%${needle}%`);
  return [
    ...records.map((row) => ({ kind: 'record', id: row.record_id, title: `${row.record_id} • ${row.roblox_username}`, status: row.status, created: row.created_at })),
    ...appeals.map((row) => ({ kind: 'appeal', id: row.appeal_id, title: `${row.appeal_id} • ${row.roblox_username}`, status: row.status, created: row.submitted_at })),
  ].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 100);
}

function searchPayload(db, draft, page = 0) {
  const results = draft.data.results ?? [];
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(results.length / pageSize));
  const currentPage = Math.max(0, Math.min(page, pageCount - 1));
  const current = results.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const description = current.length ? current.map((item) => `**${item.id}** • ${item.title}\nStatus: ${item.status.toUpperCase()} • <t:${Math.floor(new Date(item.created).getTime() / 1000)}:R>`).join('\n\n') : 'No saved blacklist records or appeals matched that search.';
  const components = [];
  if (current.length) components.push(new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`gv:blacklist:select:${draft.draft_id}`).setPlaceholder('Select a record or appeal')
      .addOptions(current.map((item) => ({ label: `${item.id} • ${item.title}`.slice(0, 100), value: `${item.kind}|${item.id}`, description: `${item.status.toUpperCase()} • ${new Date(item.created).toLocaleDateString()}`.slice(0, 100) }))),
  ));
  if (pageCount > 1) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:blacklist:page:${draft.draft_id}:${currentPage - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
    new ButtonBuilder().setCustomId(`gv:blacklist:page:${draft.draft_id}:${currentPage + 1}`).setLabel(`Page ${currentPage + 1}/${pageCount}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`gv:blacklist:page:${draft.draft_id}:${currentPage + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
  ));
  components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gv:blacklist:search').setLabel('New Search').setStyle(ButtonStyle.Secondary)));
  return { embeds: [makeEmbed(config.EMBED_COLORS.info, `🔎 Blacklist Search • ${draft.data.query}`, description.slice(0, 3900))], components };
}

async function showSearch(interaction, ctx, query) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draftId = createDraft(ctx.db, interaction.user.id, 'edit', null, { query, results: findResults(ctx.db, query) });
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'edit');
  return interaction.reply({ ...searchPayload(ctx.db, draft), ephemeral: true });
}

function searchModal(mode = 'search') {
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:search:${mode}`).setTitle(mode === 'edit' ? 'Find a Blacklist Record to Edit' : 'Search Blacklist Records')
    .addComponents(textInput('query', 'Name, user ID, record/appeal ID, or status', { required: true, maxLength: 100 }));
}

function recordDetailPayload(record) {
  return {
    embeds: [recordEmbed(record)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:blacklist:record:edit:${record.record_id}`).setLabel('Edit Record').setEmoji('🛠️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`gv:blacklist:record:remove:${record.record_id}`).setLabel(record.status === 'removed' ? 'Already Removed' : 'Remove Blacklist').setStyle(ButtonStyle.Danger).setDisabled(record.status === 'removed'),
      new ButtonBuilder().setCustomId(`gv:blacklist:record:history:${record.record_id}`).setLabel('Edit History').setStyle(ButtonStyle.Secondary),
    )],
  };
}

function editModalOne(draft) {
  const record = draft.data.current;
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:edit:${draft.draft_id}:1`).setTitle(`Edit ${record.record_id} • Player Details`)
    .addComponents(
      textInput('roblox_name', 'Roblox Username', { value: record.roblox_username, maxLength: 50 }),
      textInput('roblox_id', 'Roblox User ID', { value: record.roblox_user_id, maxLength: 32 }),
      textInput('discord_name', 'Discord Username', { value: record.discord_username, maxLength: 100 }),
      textInput('discord_id', 'Discord User ID', { value: record.discord_user_id, maxLength: 20 }),
      textInput('reason', 'Blacklist Reason', { value: record.reason, style: TextInputStyle.Paragraph, maxLength: 1000 }),
    );
}

function editModalTwo(draft) {
  const record = draft.data.current;
  return new ModalBuilder().setCustomId(`gv:blacklist:modal:edit:${draft.draft_id}:2`).setTitle(`Edit ${record.record_id} • Record Details`)
    .addComponents(
      textInput('evidence', 'Evidence / Evidence Link', { value: record.evidence, style: TextInputStyle.Paragraph, maxLength: 1000 }),
      textInput('duration', 'Duration: 1d/3d/7d/14d/30d/permanent', { value: record.duration_hours == null ? 'permanent' : `${record.duration_hours / 24}d`, maxLength: 20 }),
      textInput('expiration', 'Expiration ISO date or permanent', { value: record.expires_at ?? 'permanent', maxLength: 40 }),
      textInput('status', 'Status: active, expired, or removed', { value: record.status, maxLength: 12 }),
      textInput('staff_notes', 'Internal Staff Notes', { value: record.staff_notes, style: TextInputStyle.Paragraph, maxLength: 1000 }),
    );
}

function editPreviewPayload(draft) {
  const changes = draft.data.changes;
  const lines = Object.entries(changes).map(([field, value]) => `**${field.replaceAll('_', ' ')}:** ${value || 'None'}`);
  return {
    embeds: [makeEmbed(config.EMBED_COLORS.warning, `⚠️ Confirm Edit • ${draft.record_id}`,
      `Review these proposed changes before saving:\n\n${lines.join('\n')}\n\nThis edit will be recorded in permanent history.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:blacklist:edit-confirm:${draft.draft_id}`).setLabel('Confirm & Save').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gv:blacklist:edit-cancel:${draft.draft_id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    )],
  };
}

async function startRecordEdit(interaction, ctx, recordId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const record = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(recordId);
  if (!record) return interaction.reply({ content: 'Blacklist record not found.', ephemeral: true });
  const draftId = createDraft(ctx.db, interaction.user.id, 'edit', recordId, { current: record });
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'edit');
  return interaction.showModal(editModalOne(draft));
}

async function continueRecordEdit(interaction, ctx, draftId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'edit');
  if (!draft || draft.stage !== 2) return interaction.reply({ content: 'This edit form expired. Search the record again.', ephemeral: true });
  return interaction.showModal(editModalTwo(draft));
}

async function continueEdit(interaction, ctx, draftId, stage) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'edit');
  if (!draft || draft.stage !== stage) return interaction.reply({ content: 'This edit form expired. Search the record again.', ephemeral: true });
  if (stage === 1) {
    const data = { ...draft.data };
    for (const key of ['roblox_name', 'roblox_id', 'discord_name', 'discord_id', 'reason']) data.current[key] = interaction.fields.getTextInputValue(key).trim();
    if (!data.current.roblox_name || !data.current.discord_name || !data.current.reason) return interaction.reply({ content: 'Roblox username, Discord username, and reason are required.', ephemeral: true });
    updateDraft(ctx.db, draftId, interaction.user.id, { stage: 2, data });
    return interaction.reply({
      content: `Player details for ${draft.record_id} saved. Continue to edit duration, expiration, status, evidence, and staff notes.`,
      components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`gv:blacklist:continue:edit:${draftId}`).setLabel('Continue Editing').setStyle(ButtonStyle.Primary))],
      ephemeral: true,
    });
  }
  const data = { ...draft.data };
  const next = {};
  for (const key of ['evidence', 'staff_notes']) next[key] = interaction.fields.getTextInputValue(key).trim();
  const duration = parseDuration(interaction.fields.getTextInputValue('duration'));
  if (duration === undefined) return interaction.reply({ content: 'Use 1d, 3d, 7d, 14d, 30d, or permanent for duration.', ephemeral: true });
  const status = interaction.fields.getTextInputValue('status').trim().toLowerCase();
  if (!['active', 'expired', 'removed'].includes(status)) return interaction.reply({ content: 'Status must be active, expired, or removed.', ephemeral: true });
  const expiration = interaction.fields.getTextInputValue('expiration').trim();
  let expiresAt;
  if (expiration.toLowerCase() === 'permanent') expiresAt = null;
  else {
    const timestamp = Date.parse(expiration);
    if (!Number.isFinite(timestamp)) return interaction.reply({ content: 'Expiration must be a valid ISO date/time or permanent.', ephemeral: true });
    expiresAt = new Date(timestamp).toISOString();
  }
  next.duration_hours = duration;
  next.expires_at = expiresAt;
  next.status = status;
  Object.assign(data.current, next);
  const original = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(draft.record_id);
  const changes = {};
  for (const key of ['roblox_username', 'roblox_user_id', 'discord_username', 'discord_user_id', 'reason', 'evidence', 'duration_hours', 'expires_at', 'status', 'staff_notes']) {
    const formKey = ({ roblox_username: 'roblox_name', roblox_user_id: 'roblox_id', discord_username: 'discord_name', discord_user_id: 'discord_id' })[key] ?? key;
    if (original[key] !== data.current[formKey]) changes[key] = data.current[formKey];
  }
  if (!Object.keys(changes).length) return interaction.reply({ content: 'No changes were made.', ephemeral: true });
  data.changes = changes;
  updateDraft(ctx.db, draftId, interaction.user.id, { stage: 3, data });
  return interaction.reply({ ...editPreviewPayload({ ...draft, stage: 3, data }), ephemeral: true });
}

async function saveEdit(interaction, ctx, draftId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'edit');
  if (!draft || draft.stage !== 3) return interaction.reply({ content: 'This edit preview expired. Search the record again.', ephemeral: true });
  const now = new Date().toISOString();
  const changes = draft.data.changes;
  const columns = Object.keys(changes);
  const sqlColumns = { roblox_username: 'roblox_username', roblox_user_id: 'roblox_user_id', discord_username: 'discord_username', discord_user_id: 'discord_user_id' };
  try {
    ctx.db.transaction(() => {
      const assignments = [...columns.map((key) => `${sqlColumns[key] ?? key} = ?`), 'updated_at = ?'];
      const values = columns.map((key) => changes[key]);
      const result = ctx.db.prepare(`UPDATE blacklist_records SET ${assignments.join(', ')} WHERE record_id = ?`)
        .run(...values, now, draft.record_id);
      if (!result.changes) throw new Error('Blacklist record no longer exists.');
      writeRecordHistory(ctx.db, draft.record_id, interaction.user.id, 'edited', changes, now);
      ctx.db.prepare('DELETE FROM blacklist_form_drafts WHERE draft_id = ?').run(draftId);
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return interaction.reply({ content: 'Those player IDs belong to another active blacklist record. No changes were saved.', ephemeral: true });
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  const record = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(draft.record_id);
  await updateRecordMessage(interaction.client, record);
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.active, 'Blacklist Record Updated', `Record **${record.record_id}** was updated and added to edit history.`)], ephemeral: true });
}

async function removeRecord(interaction, ctx, recordId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const record = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(recordId);
  if (!record) return interaction.reply({ content: 'Blacklist record not found.', ephemeral: true });
  if (record.status === 'removed') return interaction.reply({ content: 'This blacklist record is already removed.', ephemeral: true });
  const now = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE blacklist_records SET status = 'removed', updated_at = ? WHERE record_id = ? AND status != 'removed'").run(now, recordId);
    writeRecordHistory(ctx.db, recordId, interaction.user.id, 'removed', { previousStatus: record.status }, now);
  })();
  const updated = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(recordId);
  await updateRecordMessage(interaction.client, updated);
  return interaction.reply({ content: `Blacklist record ${recordId} was removed from active status. Its history remains saved.`, ephemeral: true });
}

async function showRecordHistory(interaction, ctx, recordId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const rows = ctx.db.prepare('SELECT * FROM blacklist_record_history WHERE record_id = ? ORDER BY created_at DESC LIMIT 15').all(recordId);
  const description = rows.length ? rows.map((row) => `**${row.action}** • <@${row.actor_id}> • <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:F>\n\`${row.changes_json}\``).join('\n\n') : 'No edit history found.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, `Record History • ${recordId}`, description.slice(0, 3900))], ephemeral: true });
}

async function handleRecordSelection(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const [kind, id] = interaction.values[0].split('|');
  if (kind === 'record') {
    const record = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(id);
    if (!record) return interaction.reply({ content: 'Blacklist record not found.', ephemeral: true });
    const payload = recordDetailPayload(record);
    return interaction.update(payload);
  }
  const appeal = ctx.db.prepare('SELECT * FROM blacklist_appeals WHERE appeal_id = ?').get(id);
  if (!appeal) return interaction.reply({ content: 'Appeal not found.', ephemeral: true });
  return interaction.update({ embeds: [appealEmbed(appeal)], components: ['pending', 'info_requested'].includes(appeal.status) ? appealComponents(id) : [] });
}

async function processBlacklistExpirations(client, db, now = new Date()) {
  const nowIso = now.toISOString();
  const due = db.prepare("SELECT * FROM blacklist_records WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at").all(nowIso);
  let changed = 0;
  for (const record of due) {
    const didExpire = db.transaction(() => {
      const result = db.prepare("UPDATE blacklist_records SET status = 'expired', updated_at = ? WHERE record_id = ? AND status = 'active' AND expires_at <= ?")
        .run(nowIso, record.record_id, nowIso);
      if (!result.changes) return false;
      writeRecordHistory(db, record.record_id, 'system', 'expired', { expiresAt: record.expires_at }, nowIso);
      return true;
    })();
    if (!didExpire) continue;
    changed += 1;
    const updated = db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(record.record_id);
    await updateRecordMessage(client, updated);
  }
  return changed;
}

async function respondToAppeal(interaction, ctx) {
  const appealId = interaction.options.getString('appeal-id', true).toUpperCase();
  const response = interaction.options.getString('text', true).trim();
  if (!response) return interaction.reply({ content: 'Enter your additional information before submitting.', ephemeral: true });
  const appeal = ctx.db.prepare("SELECT * FROM blacklist_appeals WHERE appeal_id = ? AND applicant_id = ? AND status = 'info_requested'")
    .get(appealId, interaction.user.id);
  if (!appeal) return interaction.reply({ content: 'No information request is waiting for this appeal.', ephemeral: true });
  const now = new Date().toISOString();
  const changed = ctx.db.transaction(() => {
    const result = ctx.db.prepare("UPDATE blacklist_appeals SET applicant_response = ?, status = 'pending' WHERE appeal_id = ? AND applicant_id = ? AND status = 'info_requested'")
      .run(response, appealId, interaction.user.id);
    if (!result.changes) return false;
    writeAppealHistory(ctx.db, appealId, interaction.user.id, 'applicant_response_submitted', { response }, now);
    return true;
  })();
  if (!changed) return interaction.reply({ content: 'This appeal changed while you were responding. Contact management if it still needs attention.', ephemeral: true });
  const updated = ctx.db.prepare('SELECT * FROM blacklist_appeals WHERE appeal_id = ?').get(appealId);
  await updateAppealMessage(interaction.client, updated);
  return interaction.reply({ content: `Your response was added to appeal ${appealId} and returned to the management review queue.`, ephemeral: true });
}

async function handleBlacklistCommand(interaction, ctx) {
  if (interaction.commandName !== 'blacklist') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'panel') return publishPanel(interaction, ctx);
  if (action === 'configure') return configureBlacklist(interaction, ctx);
  if (action === 'appeal') return startAppeal(interaction, ctx);
  if (action === 'respond') return respondToAppeal(interaction, ctx);
  if (action === 'search') return showSearch(interaction, ctx, interaction.options.getString('query', true));
  if (action === 'view' || action === 'edit' || action === 'remove' || action === 'history') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const id = interaction.options.getString('id', true).toUpperCase();
    if (action === 'edit') return startRecordEdit(interaction, ctx, id);
    if (action === 'remove') return removeRecord(interaction, ctx, id);
    if (action === 'history') return showRecordHistory(interaction, ctx, id);
    const record = ctx.db.prepare('SELECT * FROM blacklist_records WHERE record_id = ?').get(id);
    return interaction.reply(record ? { ...recordDetailPayload(record), ephemeral: true } : { content: 'Blacklist record not found.', ephemeral: true });
  }
  return interaction.reply({ content: 'Unknown blacklist command.', ephemeral: true });
}

async function handleBlacklistButton(interaction, ctx) {
  const customId = interaction.customId;
  if (customId === 'gv:blacklist:blacklist') return startBlacklistDraft(interaction, ctx);
  if (customId === 'gv:blacklist:appeal') return startAppeal(interaction, ctx);
  const createContinue = customId.match(/^gv:blacklist:continue:create:([a-f0-9]{32})$/);
  if (createContinue) return continueBlacklistCreate(interaction, ctx, createContinue[1]);
  const editContinue = customId.match(/^gv:blacklist:continue:edit:([a-f0-9]{32})$/);
  if (editContinue) return continueRecordEdit(interaction, ctx, editContinue[1]);
  if (customId === 'gv:blacklist:edit') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    return interaction.showModal(searchModal('edit'));
  }
  if (customId === 'gv:blacklist:search') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    return interaction.showModal(searchModal());
  }
  const page = customId.match(/^gv:blacklist:page:([a-f0-9]{32}):(\d+)$/);
  if (page) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const draft = getDraft(ctx.db, page[1], interaction.user.id, 'edit');
    if (!draft) return interaction.reply({ content: 'Search expired. Start a new search.', ephemeral: true });
    const payload = searchPayload(ctx.db, draft, Number(page[2]));
    return interaction.update(payload);
  }
  const edit = customId.match(/^gv:blacklist:record:edit:([A-Z0-9-]+)$/);
  if (edit) return startRecordEdit(interaction, ctx, edit[1]);
  const remove = customId.match(/^gv:blacklist:record:remove:([A-Z0-9-]+)$/);
  if (remove) return removeRecord(interaction, ctx, remove[1]);
  const history = customId.match(/^gv:blacklist:record:history:([A-Z0-9-]+)$/);
  if (history) return showRecordHistory(interaction, ctx, history[1]);
  const editConfirm = customId.match(/^gv:blacklist:edit-confirm:([a-f0-9]{32})$/);
  if (editConfirm) return saveEdit(interaction, ctx, editConfirm[1]);
  const editCancel = customId.match(/^gv:blacklist:edit-cancel:([a-f0-9]{32})$/);
  if (editCancel) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    ctx.db.prepare('DELETE FROM blacklist_form_drafts WHERE draft_id = ? AND actor_id = ?').run(editCancel[1], interaction.user.id);
    return interaction.update({ content: 'Blacklist edit cancelled. No changes were saved.', embeds: [], components: [] });
  }
  const review = customId.match(/^gv:blacklist:review:(approve|deny|info|notes):([A-Z0-9-]+)$/);
  const appealEdit = customId.match(/^gv:blacklist:review:edit:([A-Z0-9-]+)$/);
  if (appealEdit) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const appeal = ctx.db.prepare("SELECT * FROM blacklist_appeals WHERE appeal_id = ? AND status IN ('pending', 'info_requested')").get(appealEdit[1]);
    if (!appeal) return interaction.reply({ content: 'This appeal is already closed or could not be found.', ephemeral: true });
    return interaction.showModal(appealEditModal(appeal));
  }
  if (review) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const appeal = ctx.db.prepare('SELECT * FROM blacklist_appeals WHERE appeal_id = ? AND status IN (\'pending\', \'info_requested\')').get(review[2]);
    if (!appeal) return interaction.reply({ content: 'This appeal is already closed or could not be found.', ephemeral: true });
    return interaction.showModal(appealActionModal(review[2], review[1]));
  }
  return interaction.reply({ content: 'This blacklist panel action is not available.', ephemeral: true });
}

async function handleBlacklistSelect(interaction, ctx) {
  if (!interaction.customId.startsWith('gv:blacklist:select:')) return null;
  const draftId = interaction.customId.split(':').at(-1);
  const draft = getDraft(ctx.db, draftId, interaction.user.id, 'edit');
  if (!draft) return interaction.reply({ content: 'Search expired. Start a new search.', ephemeral: true });
  return handleRecordSelection(interaction, ctx);
}

async function handleBlacklistModal(interaction, ctx) {
  const create = interaction.customId.match(/^gv:blacklist:modal:create:([a-f0-9]{32}):(1|2)$/);
  if (create) return create[2] === '1' ? completeBlacklistCreate(interaction, ctx, create[1]) : saveBlacklistCreate(interaction, ctx, create[1]);
  const appeal = interaction.customId.match(/^gv:blacklist:modal:appeal:([a-f0-9]{32})$/);
  if (appeal) return submitAppeal(interaction, ctx, appeal[1]);
  const search = interaction.customId.match(/^gv:blacklist:modal:search:(search|edit)$/);
  if (search) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const query = interaction.fields.getTextInputValue('query').trim();
    if (search[1] === 'edit' && /^BL-[A-Z0-9-]+$/i.test(query)) return startRecordEdit(interaction, ctx, query.toUpperCase());
    return showSearch(interaction, ctx, query);
  }
  const edit = interaction.customId.match(/^gv:blacklist:modal:edit:([a-f0-9]{32}):(1|2)$/);
  if (edit) return continueEdit(interaction, ctx, edit[1], Number(edit[2]));
  const review = interaction.customId.match(/^gv:blacklist:modal:review:(approve|deny|info|notes):([A-Z0-9-]+)$/);
  if (review) {
    const value = interaction.fields.getTextInputValue(review[1] === 'approve' ? 'resolution' : 'message').trim();
    const managementNote = review[1] === 'approve' ? interaction.fields.getTextInputValue('management_note').trim() : '';
    return reviewAppeal(interaction, ctx, review[1], review[2], { resolution: value, message: value, management_note: managementNote });
  }
  const appealEdit = interaction.customId.match(/^gv:blacklist:modal:appeal-edit:([A-Z0-9-]+)$/);
  if (appealEdit) return submitAppealEdit(interaction, ctx, appealEdit[1]);
  return null;
}

module.exports = {
  handleBlacklistButton,
  handleBlacklistCommand,
  handleBlacklistModal,
  handleBlacklistSelect,
  panelComponents,
  panelEmbed,
  processBlacklistExpirations,
  recordEmbed,
};
