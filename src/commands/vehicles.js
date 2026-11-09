const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} = require('discord.js');
const config = require('../../config');
const {
  ensureManagement,
} = require('./staff');
const { applyPanelCustomization, ensurePanelHeader } = require('./panelEditor');
const { getFormQuestion } = require('./forms');
const {
  getConfigValue,
  makeEmbed,
  sendToChannel,
  setConfigValue,
  validId,
} = require('../utils/discord');

const draftLifetimeMs = 15 * 60 * 1000;
const maxVehicleImageBytes = 8 * 1024 * 1024;

function applicationCode(id) {
  return `GV-APP-${String(id).padStart(6, '0')}`;
}

function registrationCode(id) {
  return `GV-REG-${String(id).padStart(6, '0')}`;
}

function normalizePlate(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
}

function normalizeState(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
}

function plateKey(plate, state) {
  return `${normalizeState(state).replace(/[^A-Z0-9]/g, '')}:${normalizePlate(plate)}`;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

function validateVehicleDetails(data, { requireYear = true } = {}) {
  const errors = [];
  if (!/^(?!_)(?!.*__)[A-Za-z0-9_]{3,20}(?<!_)$/.test(data.robloxUsername ?? '')) {
    errors.push('Enter a Roblox username with 3–20 letters, numbers, or single underscores.');
  }
  if (!data.makeModel?.trim() || data.makeModel.trim().length > 100) {
    errors.push('Vehicle make and model must contain 1–100 characters.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{0,15}$/.test(data.plate?.trim() ?? '')) {
    errors.push('License plates may contain 1–16 letters, numbers, spaces, and hyphens.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 .'-]{1,31}$/.test(data.registrationState?.trim() ?? '')) {
    errors.push('Enter a registration state or province between 2 and 32 characters.');
  }
  if (!data.color?.trim() || data.color.trim().length > 40) {
    errors.push('Vehicle color must contain 1–40 characters.');
  }
  if (requireYear && (!Number.isInteger(data.vehicleYear)
    || data.vehicleYear < 1900 || data.vehicleYear > new Date().getUTCFullYear() + 1)) {
    errors.push('Enter a valid vehicle year.');
  }
  if (data.imageUrl && !isHttpsUrl(data.imageUrl)) errors.push('Vehicle picture URLs must use HTTPS.');
  return errors;
}

function addTextInput(modal, id, label, style, maxLength, required, value = '', placeholder = '') {
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setMaxLength(maxLength)
    .setRequired(required);
  if (value) input.setValue(value.slice(0, maxLength));
  if (placeholder) input.setPlaceholder(placeholder.slice(0, 100));
  modal.addComponents(new ActionRowBuilder().addComponents(input));
}

function applicationBasicModal(db) {
  const modal = new ModalBuilder()
    .setCustomId('gv:vehicle:apply:basic')
    .setTitle('Vehicle Registration • 1 of 2');
  for (const [key, id, maxLength] of [['roblox', 'roblox', 20], ['vehicle', 'vehicle', 100], ['plate', 'plate', 16], ['state', 'state', 32], ['color', 'color', 40]]) {
    const question = getFormQuestion(db, 'vehicle_registration', key);
    addTextInput(modal, id, question.label, TextInputStyle.Short, maxLength, true, '', question.placeholder);
  }
  return modal;
}

function applicationDetailsModal(draftId, db) {
  const modal = new ModalBuilder()
    .setCustomId(`gv:vehicle:apply:details:${draftId}`)
    .setTitle('Vehicle Registration • 2 of 2');
  const year = getFormQuestion(db, 'vehicle_registration', 'year');
  addTextInput(modal, 'year', year.label, TextInputStyle.Short, 4, true, '', year.placeholder);
  modal.addLabelComponents(new LabelBuilder()
    .setLabel('Vehicle picture (optional)')
    .setDescription('Upload one image, up to 8 MB.')
    .setFileUploadComponent(new FileUploadBuilder()
      .setCustomId('image')
      .setMinValues(0)
      .setMaxValues(1)
      .setRequired(false)));
  return modal;
}

function vehiclePanelEmbed() {
  return makeEmbed(config.EMBED_COLORS.active, '🚘 CIVILIAN VEHICLE REGISTRATION',
    '**CIVILIAN VEHICLES ONLY**\n🚫 **Police, Fire Rescue, and all other Law Enforcement or Emergency Response vehicles must NOT be registered through this system.**\n\nRegister eligible civilian vehicles for use in Greenville roleplay.')
    .addFields(
      { name: '📋 Prepare', value: 'Roblox username, vehicle year and model, license plate, state/province, and color. A clear vehicle photo is optional.' },
      { name: '📝 Submit', value: 'Select **Register Vehicle** and complete both private form steps. Your information is sent to staff for review.' },
      { name: '✅ Decision and status', value: 'Approved vehicles receive an active registration ID. If denied, staff provide a reason so you can correct the details and reapply. Use **My Registered Vehicles** or `/vehicle mine` to check pending and past decisions.' },
    )
    .setFooter({ text: 'GV GR • Civilian Vehicle Services' });
}

function vehiclePanelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gv:vehicle:register').setLabel('Register Vehicle').setEmoji('📝').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('gv:vehicle:mine').setLabel('My Registered Vehicles').setEmoji('🚘').setStyle(ButtonStyle.Secondary),
  )];
}

function vehicleDescription(vehicle) {
  return [
    `**Vehicle:** ${vehicle.vehicle_year} ${vehicle.color} ${vehicle.make_model}`,
    `**Plate:** ${vehicle.plate} • ${vehicle.registration_state}`,
    `**Roblox:** ${vehicle.roblox_username}`,
  ].join('\n');
}

function vehicleReviewEmbed(vehicle) {
  const embed = makeEmbed(config.EMBED_COLORS.warning, `🚘 Vehicle Application • ${applicationCode(vehicle.id)}`,
    `**Applicant:** <@${vehicle.applicant_id}>\n**Roblox username:** ${vehicle.roblox_username}\n**Vehicle:** ${vehicle.vehicle_year} ${vehicle.color} ${vehicle.make_model}\n**License plate:** ${vehicle.plate}\n**Registration state:** ${vehicle.registration_state}\n**Submitted:** <t:${Math.floor(new Date(vehicle.created_at).getTime() / 1000)}:F>\n**Status:** Pending review`)
    .setFooter({ text: 'GV GR Vehicle Services • Review is limited to management' });
  if (vehicle.image_url) embed.setImage(vehicle.image_url);
  return embed;
}

function reviewComponents(applicationId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:vehicle:approve:${applicationId}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gv:vehicle:deny:${applicationId}`).setLabel('Deny').setEmoji('⛔').setStyle(ButtonStyle.Danger),
  )];
}

function decisionEmbed(vehicle, approved) {
  const title = approved ? '✅ Vehicle Registration Approved' : '⛔ Vehicle Registration Denied';
  const description = [
    `**Application:** ${applicationCode(vehicle.id)}`,
    vehicle.registration_code ? `**Registration ID:** ${vehicle.registration_code}` : null,
    vehicleDescription(vehicle),
    `**Decision date:** <t:${Math.floor(new Date(vehicle.reviewed_at).getTime() / 1000)}:F>`,
    `**Reviewed by:** <@${vehicle.reviewer_id}>`,
    `**Status:** ${approved ? 'Active' : 'Denied'}`,
    approved ? null : `**Reason:** ${vehicle.decision_reason}`,
    approved ? null : 'Correct the information and submit a new application from the registration panel.',
  ].filter(Boolean).join('\n');
  const embed = makeEmbed(approved ? config.EMBED_COLORS.active : config.EMBED_COLORS.error, title, description)
    .setFooter({ text: 'GV GR Vehicle Services' })
    .setTimestamp(new Date(vehicle.reviewed_at));
  if (vehicle.image_url) embed.setImage(vehicle.image_url);
  return embed;
}

async function openVehiclePanel(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const channelId = getConfigValue(ctx.db, 'VEHICLE_REGISTRATION_CHANNEL_ID');
  if (!validId(channelId)) {
    return interaction.reply({ content: 'Configure the vehicle registration panel channel with `/staffconfig channel` first.', ephemeral: true });
  }
  let channel;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch (error) {
    console.error('Could not fetch the vehicle registration panel channel:', error.message);
  }
  if (!channel?.isTextBased() || !channel.send) {
    return interaction.reply({ content: 'I could not access the configured vehicle registration channel.', ephemeral: true });
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: 'I need View Channel, Send Messages, and Embed Links permissions in the registration channel.', ephemeral: true });
  }

  const customized = applyPanelCustomization(ctx.db, 'vehicle', vehiclePanelEmbed(), vehiclePanelComponents());
  const payload = { embeds: [customized.embed], components: customized.components };
  let message;
  let savedMessageId = getConfigValue(ctx.db, 'vehicle_panel_message_id');
  const header = await ensurePanelHeader(interaction.client, ctx.db, 'vehicle', channel);
  if (header.created && validId(savedMessageId)) {
    try { const previous = await channel.messages.fetch(savedMessageId); if (previous.author?.id === interaction.client.user?.id) await previous.delete(); } catch {}
    setConfigValue(ctx.db, 'vehicle_panel_message_id', null);
    savedMessageId = null;
  }
  if (validId(savedMessageId)) {
    try {
      const previous = await channel.messages.fetch(savedMessageId);
      message = await previous.edit(payload);
    } catch {
      message = null;
    }
  }
  if (!message) message = await channel.send(payload);
  setConfigValue(ctx.db, 'vehicle_panel_message_id', message.id);
  return interaction.reply({ content: `Vehicle registration panel ${savedMessageId ? 'refreshed' : 'posted'} in <#${channel.id}>.`, ephemeral: true });
}

function isDuplicatePlate(db, key) {
  return db.prepare("SELECT id, status FROM vehicle_applications WHERE plate_key = ? AND status IN ('pending', 'approved') LIMIT 1").get(key);
}

function processVehicleExpirations(db, now = new Date()) {
  const nowIso = now.toISOString();
  const expire = db.transaction(() => {
    const rows = db.prepare("SELECT id FROM vehicle_applications WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?").all(nowIso);
    for (const row of rows) {
      db.prepare("UPDATE vehicle_applications SET status = 'expired', reviewed_at = ? WHERE id = ? AND status = 'approved'").run(nowIso, row.id);
      db.prepare(`
        INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
        VALUES (?, 'system', 'expired', '{}', ?)
      `).run(row.id, nowIso);
    }
    return rows.length;
  });
  return expire();
}

function createApplicationDraft(db, applicantId, data, now = Date.now()) {
  const id = randomUUID().replaceAll('-', '');
  const createdAt = new Date(now).toISOString();
  db.prepare('DELETE FROM vehicle_application_drafts WHERE expires_at <= ?').run(createdAt);
  db.prepare(`
    INSERT INTO vehicle_application_drafts (id, applicant_id, data_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, applicantId, JSON.stringify(data), createdAt, new Date(now + draftLifetimeMs).toISOString());
  return id;
}

function getApplicationDraft(db, id, applicantId, now = new Date()) {
  if (!/^[a-f0-9]{32}$/.test(id ?? '')) return null;
  const row = db.prepare('SELECT * FROM vehicle_application_drafts WHERE id = ? AND applicant_id = ?').get(id, applicantId);
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) {
    db.prepare('DELETE FROM vehicle_application_drafts WHERE id = ?').run(id);
    return null;
  }
  return { ...row, data: JSON.parse(row.data_json) };
}

async function startApplication(interaction, ctx) {
  return interaction.showModal(applicationBasicModal(ctx.db));
}

async function submitBasicApplication(interaction, ctx) {
  processVehicleExpirations(ctx.db);
  if (ctx.db.prepare("SELECT id FROM vehicle_applications WHERE applicant_id = ? AND status = 'pending'").get(interaction.user.id)) {
    return interaction.reply({ content: 'You already have a vehicle application pending staff review.', ephemeral: true });
  }
  const data = {
    robloxUsername: interaction.fields.getTextInputValue('roblox').trim(),
    makeModel: interaction.fields.getTextInputValue('vehicle').trim(),
    plate: interaction.fields.getTextInputValue('plate').trim(),
    registrationState: normalizeState(interaction.fields.getTextInputValue('state')),
    color: interaction.fields.getTextInputValue('color').trim(),
    vehicleYear: null,
    imageUrl: null,
  };
  const errors = validateVehicleDetails(data, { requireYear: false });
  if (errors.length) return interaction.reply({ content: errors.join('\n'), ephemeral: true });
  if (isDuplicatePlate(ctx.db, plateKey(data.plate, data.registrationState))) {
    return interaction.reply({ content: 'That plate is already pending review or actively registered in that state.', ephemeral: true });
  }
  const draftId = createApplicationDraft(ctx.db, interaction.user.id, data);
  return interaction.reply({
    content: 'Your vehicle details are ready. Add the year and an optional picture to submit the application.',
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setCustomId(`gv:vehicle:continue:${draftId}`)
      .setLabel('Continue Application')
      .setStyle(ButtonStyle.Primary))],
    ephemeral: true,
  });
}

async function continueApplication(interaction, ctx, draftId) {
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This application form expired. Start a new registration from the panel.', ephemeral: true });
  return interaction.showModal(applicationDetailsModal(draftId, ctx.db));
}

async function getReviewChannel(interaction, ctx) {
  const channelId = getConfigValue(ctx.db, 'VEHICLE_REVIEW_CHANNEL_ID');
  if (!validId(channelId)) return { error: 'Vehicle applications are not configured yet. Ask staff to configure the vehicle review channel.' };
  let channel;
  try {
    channel = await interaction.client.channels.fetch(channelId);
  } catch (error) {
    console.error('Could not fetch the vehicle review channel:', error.message);
  }
  if (!channel || channel.guildId !== interaction.guild.id || !channel.isTextBased() || !channel.send) {
    return { error: 'The configured vehicle review channel is unavailable. Please contact staff.' };
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return { error: 'The bot needs View Channel, Send Messages, and Embed Links permissions in the review channel.' };
  }
  return { channel };
}

function savePendingApplication(db, applicantId, data, reviewChannelId, now = new Date()) {
  processVehicleExpirations(db, now);
  const createdAt = now.toISOString();
  const key = plateKey(data.plate, data.registrationState);
  return db.transaction(() => {
    if (db.prepare("SELECT id FROM vehicle_applications WHERE applicant_id = ? AND status = 'pending'").get(applicantId)) {
      throw new Error('You already have a vehicle application pending staff review.');
    }
    if (isDuplicatePlate(db, key)) {
      throw new Error('That plate is already pending review or actively registered in that state.');
    }
    const result = db.prepare(`
      INSERT INTO vehicle_applications (
        applicant_id, roblox_username, make_model, plate, plate_normalized, plate_key,
        registration_state, color, vehicle_year, image_url, status, created_at, review_channel_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      applicantId, data.robloxUsername, data.makeModel, data.plate, normalizePlate(data.plate), key,
      normalizeState(data.registrationState), data.color, data.vehicleYear, data.imageUrl, createdAt, reviewChannelId,
    );
    const applicationId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
      VALUES (?, ?, 'submitted', ?, ?)
    `).run(applicationId, applicantId, JSON.stringify(data), createdAt);
    return applicationId;
  })();
}

async function submitVehicleApplication(interaction, ctx, draftId) {
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This application form expired. Start a new registration from the panel.', ephemeral: true });

  const rawYear = interaction.fields.getTextInputValue('year').trim();
  const data = { ...draft.data, vehicleYear: /^\d{4}$/.test(rawYear) ? Number(rawYear) : NaN };
  const uploads = interaction.fields.getUploadedFiles('image');
  const image = uploads?.first() ?? null;
  if (image && (!image.contentType?.startsWith('image/') || image.size > maxVehicleImageBytes)) {
    return interaction.reply({ content: 'Upload one image file no larger than 8 MB, or leave the picture blank.', ephemeral: true });
  }
  data.imageUrl = image?.url ?? null;
  const errors = validateVehicleDetails(data);
  if (errors.length) return interaction.reply({ content: errors.join('\n'), ephemeral: true });

  const review = await getReviewChannel(interaction, ctx);
  if (review.error) return interaction.reply({ content: review.error, ephemeral: true });

  let applicationId;
  try {
    applicationId = savePendingApplication(ctx.db, interaction.user.id, data, review.channel.id);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return interaction.reply({ content: 'A pending application or active registration already uses this plate or your account.', ephemeral: true });
    }
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  ctx.db.prepare('DELETE FROM vehicle_application_drafts WHERE id = ?').run(draftId);
  const application = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(applicationId);
  let message;
  try {
    message = await review.channel.send({
      embeds: [vehicleReviewEmbed(application)],
      components: reviewComponents(applicationId),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(`Could not post vehicle application ${applicationCode(applicationId)}:`, error.message);
  }
  if (message) {
    ctx.db.prepare('UPDATE vehicle_applications SET review_message_id = ? WHERE id = ?').run(message.id, applicationId);
  }
  return interaction.reply({
    content: message
      ? `Application ${applicationCode(applicationId)} was sent to staff for review.`
      : `Application ${applicationCode(applicationId)} was saved, but staff could not be notified. Please contact management before submitting again.`,
    ephemeral: true,
  });
}

function denyApplicationModal(applicationId, applicantId = null) {
  const modal = new ModalBuilder()
    .setCustomId(`gv:vehicle:deny_submit:${applicationId}${applicantId ? `:${applicantId}` : ''}`)
    .setTitle('Deny Vehicle Application');
  addTextInput(modal, 'reason', 'Reason for denial', TextInputStyle.Paragraph, 500, true, '', 'Explain what needs correction.');
  return modal;
}

async function notifyApplicant(client, db, application, embed, approved) {
  try {
    const user = await client.users.fetch(application.applicant_id);
    await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return 'dm';
  } catch (error) {
    console.error(`Could not DM vehicle applicant ${application.applicant_id}:`, error.message);
  }
  const panelChannel = getConfigValue(db, 'VEHICLE_REGISTRATION_CHANNEL_ID');
  const result = await sendToChannel(client, panelChannel, {
    content: `<@${application.applicant_id}>`,
    embeds: [embed],
    allowedMentions: { users: [application.applicant_id] },
  });
  return result ? 'channel' : 'failed';
}

async function handleApproval(interaction, ctx, applicationId, expectedApplicantId = null) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  processVehicleExpirations(ctx.db);
  const current = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ? AND (? IS NULL OR applicant_id = ?)')
    .get(applicationId, expectedApplicantId, expectedApplicantId);
  if (!current || current.status !== 'pending') {
    return interaction.reply({ content: 'This vehicle application was already reviewed or could not be found.', ephemeral: true });
  }
  const reviewedAt = new Date().toISOString();
  const code = registrationCode(applicationId);
  try {
    ctx.db.transaction(() => {
      const result = ctx.db.prepare(`
        UPDATE vehicle_applications
        SET status = 'approved', reviewed_at = ?, reviewer_id = ?, registration_code = ?
        WHERE id = ? AND status = 'pending' AND (? IS NULL OR applicant_id = ?)
      `).run(reviewedAt, interaction.user.id, code, applicationId, expectedApplicantId, expectedApplicantId);
      if (!result.changes) throw new Error('This vehicle application was already reviewed.');
      ctx.db.prepare(`
        INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'approved', ?, ?)
      `).run(applicationId, interaction.user.id, JSON.stringify({ registrationCode: code }), reviewedAt);
    })();
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      ? 'This plate has another pending or active registration.'
      : error.message;
    return interaction.reply({ content: message, ephemeral: true });
  }
  const approved = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(applicationId);
  const embed = decisionEmbed(approved, true);
  await interaction.update({ embeds: [embed], components: [] });
  const notification = await notifyApplicant(interaction.client, ctx.db, approved, embed, true);
  if (notification !== 'dm') {
    await interaction.followUp({ content: notification === 'channel'
      ? 'Registration approved. The applicant was notified in the registration channel because DMs are unavailable.'
      : 'Registration approved, but the applicant could not be notified. Please contact them directly.', ephemeral: true }).catch(() => {});
  }
}

async function updateReviewMessage(client, application, embed) {
  if (!application.review_channel_id || !application.review_message_id) return false;
  try {
    const channel = await client.channels.fetch(application.review_channel_id);
    const message = channel?.isTextBased() ? await channel.messages.fetch(application.review_message_id) : null;
    if (!message) return false;
    await message.edit({ embeds: [embed], components: [] });
    return true;
  } catch (error) {
    console.error(`Could not update vehicle application ${applicationCode(application.id)}:`, error.message);
    return false;
  }
}


async function publishApprovedVehicleToMedia(interaction, ctx, applicantId, vehicleId) {
  const vehicle = ctx.db.prepare("SELECT * FROM vehicle_applications WHERE id = ? AND applicant_id = ? AND status = 'approved'")
    .get(vehicleId, applicantId);
  if (!vehicle) return interaction.reply({ content: 'Only this member’s approved registration can be published.', ephemeral: true });
  if (!vehicle.image_url) return interaction.reply({ content: 'This registration has no vehicle photo. A photo is required before publishing to Media.', ephemeral: true });
  if (vehicle.media_message_id) return interaction.reply({ content: 'This vehicle has already been published to Media.', ephemeral: true });
  const channelId = getConfigValue(ctx.db, 'VEHICLE_MEDIA_CHANNEL_ID');
  if (!validId(channelId)) return interaction.reply({ content: 'Configure the approved vehicle media channel with `/staffconfig channel` first.', ephemeral: true });
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.send || channel.guildId !== interaction.guild.id) {
    return interaction.reply({ content: 'The configured vehicle media channel is unavailable.', ephemeral: true });
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: 'The bot needs View Channel, Send Messages, and Embed Links in the media channel.', ephemeral: true });
  }
  const claimed = ctx.db.prepare(`
    UPDATE vehicle_applications SET media_published_at = 'publishing'
    WHERE id = ? AND applicant_id = ? AND status = 'approved' AND image_url IS NOT NULL
      AND media_message_id IS NULL AND (media_published_at IS NULL OR media_published_at != 'publishing')
  `).run(vehicleId, applicantId);
  if (!claimed.changes) return interaction.reply({ content: 'This vehicle is already being published or has already been posted.', ephemeral: true });
  try {
    const embed = makeEmbed(config.EMBED_COLORS.active, `🚘 Approved Civilian Vehicle • ${applicationCode(vehicleId)}`,
      `**Owner:** <@${applicantId}>\n**Vehicle:** ${vehicle.vehicle_year} ${vehicle.color} ${vehicle.make_model}\n**Status:** Approved civilian vehicle`)
      .setImage(vehicle.image_url)
      .setFooter({ text: 'GV GR • Approved Civilian Vehicle' });
    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    const publishedAt = new Date().toISOString();
    ctx.db.transaction(() => {
      ctx.db.prepare(`
        UPDATE vehicle_applications SET media_channel_id = ?, media_message_id = ?, media_published_at = ?
        WHERE id = ? AND applicant_id = ? AND status = 'approved' AND media_published_at = 'publishing'
      `).run(channel.id, message.id, publishedAt, vehicleId, applicantId);
      ctx.db.prepare(`
        INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'media_published', ?, ?)
      `).run(vehicleId, interaction.user.id, JSON.stringify({ channelId: channel.id, messageId: message.id }), publishedAt);
    })();
    const updated = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(vehicleId);
    return interaction.update({ content: `Approved vehicle published to <#${channel.id}>.`, ...vehicleManagementDetailsPayload(updated, applicantId, 0) });
  } catch (error) {
    ctx.db.prepare("UPDATE vehicle_applications SET media_published_at = NULL WHERE id = ? AND media_message_id IS NULL AND media_published_at = 'publishing'")
      .run(vehicleId);
    console.error(`Could not publish vehicle ${applicationCode(vehicleId)} to Media:`, error.message);
    return interaction.reply({ content: 'I could not publish this vehicle. Check the media channel and try again.', ephemeral: true });
  }
}
async function handleDenialSubmit(interaction, ctx, applicationId, expectedApplicantId = null) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const current = ctx.db.prepare("SELECT * FROM vehicle_applications WHERE id = ? AND status = 'pending' AND (? IS NULL OR applicant_id = ?)")
    .get(applicationId, expectedApplicantId, expectedApplicantId);
  if (!current) return interaction.reply({ content: 'This vehicle application was already reviewed or could not be found.', ephemeral: true });
  const reason = interaction.fields.getTextInputValue('reason').trim();
  if (!reason) return interaction.reply({ content: 'A reason is required before denying an application.', ephemeral: true });
  const reviewedAt = new Date().toISOString();
  const result = ctx.db.transaction(() => {
    const changed = ctx.db.prepare(`
      UPDATE vehicle_applications SET status = 'denied', reviewed_at = ?, reviewer_id = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending' AND (? IS NULL OR applicant_id = ?)
    `).run(reviewedAt, interaction.user.id, reason, applicationId, expectedApplicantId, expectedApplicantId);
    if (!changed.changes) return false;
    ctx.db.prepare(`
      INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
      VALUES (?, ?, 'denied', ?, ?)
    `).run(applicationId, interaction.user.id, JSON.stringify({ reason }), reviewedAt);
    return true;
  })();
  if (!result) return interaction.reply({ content: 'This vehicle application was already reviewed.', ephemeral: true });
  const denied = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(applicationId);
  const embed = decisionEmbed(denied, false);
  await updateReviewMessage(interaction.client, denied, embed);
  const notification = await notifyApplicant(interaction.client, ctx.db, denied, embed, false);
  return interaction.reply({ content: notification === 'dm'
    ? 'Application denied and the applicant was notified by DM.'
    : notification === 'channel'
      ? 'Application denied. The applicant was notified in the registration channel because DMs are unavailable.'
      : 'Application denied, but the applicant could not be notified. Please contact them directly.', ephemeral: true });
}

function listEmbed(title, rows) {
  const description = rows.length
    ? rows.map((row) => `**${applicationCode(row.id)}${row.registration_code ? ` • ${row.registration_code}` : ''}** • ${row.status.toUpperCase()}\n${vehicleDescription(row)}${row.expires_at ? `\n**Expires:** <t:${Math.floor(new Date(row.expires_at).getTime() / 1000)}:D>` : ''}`).join('\n\n')
    : 'No vehicle registrations found.';
  return makeEmbed(config.EMBED_COLORS.info, title, description.slice(0, 4000));
}

async function showMyVehicles(interaction, ctx, applicantId = interaction.user.id) {
  processVehicleExpirations(ctx.db);
  const rows = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE applicant_id = ? ORDER BY created_at DESC, id DESC LIMIT 20')
    .all(applicantId);
  return interaction.reply({ embeds: [listEmbed('🚘 My Vehicle Registration Status', rows)], ephemeral: true });
}

async function searchByPlate(interaction, ctx) {
  processVehicleExpirations(ctx.db);
  const plate = normalizePlate(interaction.options.getString('plate', true));
  const rows = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE plate_normalized = ? ORDER BY id DESC LIMIT 10').all(plate);
  return interaction.reply({ embeds: [listEmbed(`🔎 Vehicle Plate Search • ${plate || 'No plate'}`, rows)], ephemeral: true });
}

async function listApplicantVehicles(interaction, ctx) {
  processVehicleExpirations(ctx.db);
  const member = interaction.options.getUser('member', true);
  const rows = ctx.db.prepare("SELECT * FROM vehicle_applications WHERE applicant_id = ? AND status = 'approved' ORDER BY reviewed_at DESC LIMIT 10")
    .all(member.id);
  return interaction.reply({ embeds: [listEmbed(`🚘 Registered Vehicles • ${member.username}`, rows)], ephemeral: true });
}

async function registrationHistory(interaction, ctx) {
  const member = interaction.options.getUser('member', true);
  const rows = ctx.db.prepare(`
    SELECT h.action, h.created_at, h.details_json, a.id, a.plate, a.registration_state, a.make_model
    FROM vehicle_registration_history h
    JOIN vehicle_applications a ON a.id = h.application_id
    WHERE a.applicant_id = ? ORDER BY h.id DESC LIMIT 20
  `).all(member.id);
  const description = rows.length
    ? rows.map((row) => `**${applicationCode(row.id)} • ${row.action.toUpperCase()}**\n${row.make_model} • ${row.plate} (${row.registration_state})\n<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:F>`).join('\n\n')
    : 'No registration history found for this player.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, `📚 Vehicle History • ${member.username}`, description.slice(0, 4000))], ephemeral: true });
}

function vehicleMemberPickerPayload() {
  return {
    content: 'Select or search for a Discord member to review their vehicle registrations.',
    embeds: [],
    components: [new ActionRowBuilder().addComponents(new UserSelectMenuBuilder()
      .setCustomId('mgmt:vehicle:member')
      .setPlaceholder('Search for a server member'))],
  };
}

function vehicleManagementListPayload(db, applicantId, page = 0) {
  const rows = db.prepare('SELECT * FROM vehicle_applications WHERE applicant_id = ? ORDER BY created_at DESC, id DESC')
    .all(applicantId);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, pageCount - 1));
  const pageRows = rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const embed = makeEmbed(config.EMBED_COLORS.management, '🚘 Member Vehicle Registrations',
    rows.length ? `Showing ${pageRows.length} of ${rows.length} registration record${rows.length === 1 ? '' : 's'}.` : 'This member has no registered vehicle records.');
  if (pageRows.length) {
    embed.addFields(pageRows.map((vehicle) => ({
      name: `${applicationCode(vehicle.id)} • ${vehicle.status.toUpperCase()}`,
      value: `${vehicle.vehicle_year} ${vehicle.color} ${vehicle.make_model}\nPlate: ${vehicle.plate} • ${vehicle.registration_state}\nRoblox: ${vehicle.roblox_username}`,
    })));
    embed.setFooter({ text: `Page ${currentPage + 1} of ${pageCount}` });
  }
  const components = [];
  if (pageRows.length) {
    components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`mgmt:vehicle:application:${applicantId}:${currentPage}`)
      .setPlaceholder('Choose a vehicle to view or manage')
      .addOptions(pageRows.map((vehicle) => ({
        label: `${applicationCode(vehicle.id)} • ${vehicle.status}`.slice(0, 100),
        description: `${vehicle.vehicle_year} ${vehicle.make_model} • ${vehicle.plate}`.slice(0, 100),
        value: String(vehicle.id),
      })))));
  }
  if (pageCount > 1) {
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`mgmt:vehicle:page:${applicantId}:${currentPage - 1}`)
        .setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
      new ButtonBuilder().setCustomId(`mgmt:vehicle:page:${applicantId}:${currentPage + 1}`)
        .setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(currentPage >= pageCount - 1),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId('mgmt:vehicle:select_member').setLabel('Select Another Member').setStyle(ButtonStyle.Secondary)));
  return { embeds: [embed], components };
}

function vehicleManagementDetailsPayload(vehicle, applicantId, page) {
  const embed = makeEmbed(config.EMBED_COLORS.management, `🚘 ${applicationCode(vehicle.id)} • ${vehicle.status.toUpperCase()}`,
    `${vehicleDescription(vehicle)}\n\n**Status:** ${vehicle.status.toUpperCase()}\n**Submitted:** <t:${Math.floor(new Date(vehicle.created_at).getTime() / 1000)}:F>${vehicle.registration_code ? `\n**Registration ID:** ${vehicle.registration_code}` : ''}${vehicle.decision_reason ? `\n**Decision reason:** ${vehicle.decision_reason}` : ''}${vehicle.expires_at ? `\n**Expires:** <t:${Math.floor(new Date(vehicle.expires_at).getTime() / 1000)}:F>` : ''}`);
  if (vehicle.image_url) embed.setImage(vehicle.image_url);
  const actions = [];
  if (vehicle.status === 'pending') {
    actions.push(new ButtonBuilder().setCustomId(`mgmt:vehicle:approve:${applicantId}:${vehicle.id}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success));
    actions.push(new ButtonBuilder().setCustomId(`mgmt:vehicle:deny:${applicantId}:${vehicle.id}`).setLabel('Deny').setEmoji('⛔').setStyle(ButtonStyle.Danger));
  }
  if (vehicle.status === 'approved' && vehicle.image_url) {
    actions.push(new ButtonBuilder()
      .setCustomId(`mgmt:vehicle:publish_media:${applicantId}:${vehicle.id}`)
      .setLabel(vehicle.media_message_id ? 'Published in Media' : 'Publish to Media')
      .setEmoji('🖼️').setStyle(ButtonStyle.Secondary).setDisabled(Boolean(vehicle.media_message_id || vehicle.media_published_at === 'publishing')));
  }
  if (['pending', 'approved'].includes(vehicle.status)) {
    actions.push(new ButtonBuilder().setCustomId(`mgmt:vehicle:edit:${applicantId}:${vehicle.id}`).setLabel('Edit').setEmoji('✏️').setStyle(ButtonStyle.Primary));
    actions.push(new ButtonBuilder().setCustomId(`mgmt:vehicle:remove:${applicantId}:${vehicle.id}`).setLabel('Remove').setEmoji('🗑️').setStyle(ButtonStyle.Danger));
  }
  const components = [];
  if (actions.length) components.push(new ActionRowBuilder().addComponents(actions));
  components.push(new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`mgmt:vehicle:back:${applicantId}:${page}`).setLabel('Back to Member Vehicles').setStyle(ButtonStyle.Secondary)));
  return { embeds: [embed], components };
}

function vehicleManagementEditModal(applicantId, vehicle) {
  const modal = new ModalBuilder()
    .setCustomId(`mgmt:vehicle:edit_submit:${applicantId}:${vehicle.id}`)
    .setTitle('Edit Vehicle Registration');
  const fields = [
    ['roblox', 'Roblox username', vehicle.roblox_username, 20, 'Enter the exact Roblox username.'],
    ['vehicle', 'Vehicle model', vehicle.make_model, 100, 'Example: 2023 Chevrolet Tahoe.'],
    ['plate', 'License plate', vehicle.plate, 16, 'Enter the vehicle plate.'],
    ['state', 'State / province', vehicle.registration_state, 32, 'Enter its registration region.'],
    ['color', 'Vehicle color', vehicle.color, 40, 'Example: Midnight blue.'],
  ];
  for (const [id, label, value, maxLength, placeholder] of fields) {
    modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setMaxLength(maxLength)
      .setRequired(true).setValue(value.slice(0, maxLength)).setPlaceholder(placeholder)));
  }
  return modal;
}

function vehicleManagementEditDetailsModal(draftId, data) {
  return new ModalBuilder().setCustomId(`mgmt:vehicle:edit_details_submit:${draftId}`).setTitle('Vehicle Details • Final Step')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('year').setLabel('Vehicle year (YYYY)')
        .setStyle(TextInputStyle.Short).setMaxLength(4).setRequired(true).setValue(String(data.vehicleYear)).setPlaceholder('Example: 2023')),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('image').setLabel('Image URL (optional; blank removes)')
        .setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false).setValue(data.imageUrl ?? '').setPlaceholder('https://example.com/vehicle.jpg')),
    );
}

function vehicleRemovalModal(applicantId, vehicleId) {
  return new ModalBuilder().setCustomId(`mgmt:vehicle:remove_submit:${applicantId}:${vehicleId}`).setTitle('Remove Vehicle Registration')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason')
      .setLabel('Reason for removal').setStyle(TextInputStyle.Paragraph).setMaxLength(500)
      .setRequired(true).setPlaceholder('Explain why this registration is being removed.')));
}

async function showMemberVehicles(interaction, ctx, applicantId, page = 0) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const payload = vehicleManagementListPayload(ctx.db, applicantId, page);
  return interaction.update({ content: '', ...payload });
}

async function handleVehicleManagementSelect(interaction, ctx) {
  if (!interaction.customId.startsWith('mgmt:vehicle:')) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  if (interaction.customId === 'mgmt:vehicle:member') {
    return showMemberVehicles(interaction, ctx, interaction.values[0]);
  }
  const match = interaction.customId.match(/^mgmt:vehicle:application:([^:]+):(\d+)$/);
  if (!match) return interaction.reply({ content: 'This vehicle selection is invalid.', ephemeral: true });
  const [, applicantId, rawPage] = match;
  const vehicleId = Number(interaction.values[0]);
  if (!Number.isSafeInteger(vehicleId) || vehicleId < 1) {
    return interaction.reply({ content: 'This vehicle selection is invalid.', ephemeral: true });
  }
  const vehicle = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ? AND applicant_id = ?').get(vehicleId, applicantId);
  if (!vehicle) return interaction.reply({ content: 'That registration does not belong to the selected member.', ephemeral: true });
  return interaction.update({ content: '', ...vehicleManagementDetailsPayload(vehicle, applicantId, Number(rawPage)) });
}

async function handleVehicleManagementButton(interaction, ctx) {
  if (!interaction.customId.startsWith('mgmt:vehicle:')) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  if (interaction.customId === 'mgmt:vehicle:select_member') {
    return interaction.update(vehicleMemberPickerPayload());
  }
  const pageMatch = interaction.customId.match(/^mgmt:vehicle:page:([^:]+):(-?\d+)$/);
  if (pageMatch) return showMemberVehicles(interaction, ctx, pageMatch[1], Number(pageMatch[2]));
  const backMatch = interaction.customId.match(/^mgmt:vehicle:back:([^:]+):(\d+)$/);
  if (backMatch) return showMemberVehicles(interaction, ctx, backMatch[1], Number(backMatch[2]));
  const actionMatch = interaction.customId.match(/^mgmt:vehicle:(edit|approve|deny|remove|publish_media):([^:]+):(\d+)$/);
  if (!actionMatch) return interaction.reply({ content: 'This vehicle management control is not recognized.', ephemeral: true });
  const [, action, applicantId, rawVehicleId] = actionMatch;
  const vehicleId = Number(rawVehicleId);
  const vehicle = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ? AND applicant_id = ?')
    .get(vehicleId, applicantId);
  if (!vehicle) return interaction.reply({ content: 'That registration does not belong to the selected member.', ephemeral: true });
  if (action === 'publish_media') return publishApprovedVehicleToMedia(interaction, ctx, applicantId, vehicleId);
  if (action === 'approve') return handleApproval(interaction, ctx, vehicleId, applicantId);
  if (action === 'deny') {
    if (vehicle.status !== 'pending') return interaction.reply({ content: 'Only pending registrations can be denied.', ephemeral: true });
    return interaction.showModal(denyApplicationModal(vehicleId, applicantId));
  }
  if (action === 'edit') {
    if (!['pending', 'approved'].includes(vehicle.status)) return interaction.reply({ content: 'Only pending or approved registrations can be edited.', ephemeral: true });
    return interaction.showModal(vehicleManagementEditModal(applicantId, vehicle));
  }
  if (!['pending', 'approved'].includes(vehicle.status)) return interaction.reply({ content: 'Only pending or approved registrations can be removed.', ephemeral: true });
  return interaction.showModal(vehicleRemovalModal(applicantId, vehicleId));
}

function saveManagedVehicleEdit(db, { vehicleId, applicantId, actorId, data }) {
  const current = db.prepare('SELECT * FROM vehicle_applications WHERE id = ? AND applicant_id = ?')
    .get(vehicleId, applicantId);
  if (!current || !['pending', 'approved'].includes(current.status)) return { updated: false, reason: 'unavailable' };
  const errors = validateVehicleDetails(data);
  if (errors.length) return { updated: false, reason: 'invalid', errors };
  const key = plateKey(data.plate, data.registrationState);
  const updatedAt = new Date().toISOString();
  try {
    db.transaction(() => {
      const changed = db.prepare(`
        UPDATE vehicle_applications SET roblox_username = ?, make_model = ?, plate = ?, plate_normalized = ?, plate_key = ?,
          registration_state = ?, color = ?, vehicle_year = ?, image_url = ?
        WHERE id = ? AND applicant_id = ? AND status IN ('pending', 'approved')
      `).run(data.robloxUsername, data.makeModel, data.plate, normalizePlate(data.plate), key,
        data.registrationState, data.color, data.vehicleYear, data.imageUrl, vehicleId, applicantId);
      if (!changed.changes) throw new Error('This registration is no longer editable.');
      db.prepare(`
        INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'updated', ?, ?)
      `).run(vehicleId, actorId, JSON.stringify({ before: currentVehicleSnapshot(current), after: data }), updatedAt);
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { updated: false, reason: 'duplicate_plate' };
    throw error;
  }
  return { updated: true, vehicle: db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(vehicleId) };
}

async function handleVehicleManagementModal(interaction, ctx) {
  if (!interaction.customId.startsWith('mgmt:vehicle:')) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const editMatch = interaction.customId.match(/^mgmt:vehicle:edit_submit:([^:]+):(\d+)$/);
  if (editMatch) {
    const [, applicantId, rawVehicleId] = editMatch;
    const vehicleId = Number(rawVehicleId);
    const current = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ? AND applicant_id = ?')
      .get(vehicleId, applicantId);
    if (!current || !['pending', 'approved'].includes(current.status)) {
      return interaction.reply({ content: 'That registration is no longer editable for the selected member.', ephemeral: true });
    }
    const data = {
      ...currentVehicleSnapshot(current),
      robloxUsername: interaction.fields.getTextInputValue('roblox').trim(),
      makeModel: interaction.fields.getTextInputValue('vehicle').trim(),
      plate: interaction.fields.getTextInputValue('plate').trim(),
      registrationState: normalizeState(interaction.fields.getTextInputValue('state')),
      color: interaction.fields.getTextInputValue('color').trim(),
    };
    const errors = validateVehicleDetails(data);
    if (errors.length) return interaction.reply({ content: errors.join('\n'), ephemeral: true });
    const draftId = createApplicationDraft(ctx.db, interaction.user.id, { applicantId, vehicleId, data });
    return interaction.showModal(vehicleManagementEditDetailsModal(draftId, data));
  }
  const editDetailsMatch = interaction.customId.match(/^mgmt:vehicle:edit_details_submit:([a-f0-9]{32})$/);
  if (editDetailsMatch) {
    const draft = getApplicationDraft(ctx.db, editDetailsMatch[1], interaction.user.id);
    if (!draft || !draft.data.applicantId || !Number.isSafeInteger(draft.data.vehicleId)) {
      return interaction.reply({ content: 'This vehicle edit expired. Select the member and vehicle again.', ephemeral: true });
    }
    const data = {
      ...draft.data.data,
      vehicleYear: Number(interaction.fields.getTextInputValue('year').trim()),
      imageUrl: interaction.fields.getTextInputValue('image').trim() || null,
    };
    const result = saveManagedVehicleEdit(ctx.db, {
      vehicleId: draft.data.vehicleId,
      applicantId: draft.data.applicantId,
      actorId: interaction.user.id,
      data,
    });
    if (!result.updated) {
      const message = result.reason === 'duplicate_plate'
        ? 'Another pending or active registration already uses that plate in the selected region.'
        : result.reason === 'invalid' ? result.errors.join('\n') : 'That registration is no longer editable for the selected member.';
      return interaction.reply({ content: message, ephemeral: true });
    }
    ctx.db.prepare('DELETE FROM vehicle_application_drafts WHERE id = ?').run(editDetailsMatch[1]);
    if (result.vehicle.status === 'pending') await updateReviewMessage(interaction.client, result.vehicle, vehicleReviewEmbed(result.vehicle));
    return interaction.reply({ content: `${registrationCode(result.vehicle.id)} updated. The change was added to registration history.`, ephemeral: true });
  }
  const removeMatch = interaction.customId.match(/^mgmt:vehicle:remove_submit:([^:]+):(\d+)$/);
  if (removeMatch) {
    const [, applicantId, rawVehicleId] = removeMatch;
    const vehicleId = Number(rawVehicleId);
    const reason = interaction.fields.getTextInputValue('reason').trim();
    if (!reason) return interaction.reply({ content: 'A reason is required to remove a registration.', ephemeral: true });
    const current = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ? AND applicant_id = ?')
      .get(vehicleId, applicantId);
    if (!current || !['pending', 'approved'].includes(current.status)) {
      return interaction.reply({ content: 'That registration is no longer removable for the selected member.', ephemeral: true });
    }
    const removedAt = new Date().toISOString();
    const nextStatus = current.status === 'approved' ? 'revoked' : 'denied';
    const changed = ctx.db.transaction(() => {
      const result = ctx.db.prepare(`
        UPDATE vehicle_applications SET status = ?, reviewed_at = ?, reviewer_id = ?, decision_reason = ?
        WHERE id = ? AND applicant_id = ? AND status = ?
      `).run(nextStatus, removedAt, interaction.user.id, reason, vehicleId, applicantId, current.status);
      if (!result.changes) return false;
      ctx.db.prepare(`
        INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'removed', ?, ?)
      `).run(vehicleId, interaction.user.id, JSON.stringify({ previousStatus: current.status, reason }), removedAt);
      return true;
    })();
    if (!changed) return interaction.reply({ content: 'That registration has already changed. Refresh the member vehicle list.', ephemeral: true });
    const removed = ctx.db.prepare('SELECT * FROM vehicle_applications WHERE id = ?').get(vehicleId);
    const embed = makeEmbed(config.EMBED_COLORS.warning, '🚫 Vehicle Registration Removed',
      `${applicationCode(vehicleId)}\n${vehicleDescription(removed)}\n\n**Status:** ${nextStatus.toUpperCase()}\n**Reason:** ${reason}`);
    await updateReviewMessage(interaction.client, removed, embed);
    const notification = await notifyApplicant(interaction.client, ctx.db, removed, embed, false);
    return interaction.reply({ content: `Registration removed and retained in history.${notification === 'dm' ? ' The member was notified by DM.' : ''}`, ephemeral: true });
  }
  return null;
}

function currentVehicleSnapshot(vehicle) {
  return {
    robloxUsername: vehicle.roblox_username,
    makeModel: vehicle.make_model,
    plate: vehicle.plate,
    registrationState: vehicle.registration_state,
    color: vehicle.color,
    vehicleYear: vehicle.vehicle_year,
    imageUrl: vehicle.image_url,
  };
}

async function updateVehicle(interaction, ctx) {
  const id = interaction.options.getInteger('id', true);
  const vehicle = ctx.db.prepare("SELECT * FROM vehicle_applications WHERE id = ? AND status = 'approved'").get(id);
  if (!vehicle) return interaction.reply({ content: 'An active approved registration with that application ID was not found.', ephemeral: true });
  const removeImage = interaction.options.getBoolean('remove-image') === true;
  const imageUrl = interaction.options.getString('image-url');
  if (removeImage && imageUrl) return interaction.reply({ content: 'Choose either a new image URL or Remove Image, not both.', ephemeral: true });
  const data = {
    ...currentVehicleSnapshot(vehicle),
    robloxUsername: interaction.options.getString('roblox') ?? vehicle.roblox_username,
    makeModel: interaction.options.getString('vehicle') ?? vehicle.make_model,
    plate: interaction.options.getString('plate') ?? vehicle.plate,
    registrationState: normalizeState(interaction.options.getString('state') ?? vehicle.registration_state),
    color: interaction.options.getString('color') ?? vehicle.color,
    vehicleYear: interaction.options.getInteger('year') ?? vehicle.vehicle_year,
    imageUrl: removeImage ? null : imageUrl ?? vehicle.image_url,
  };
  if (JSON.stringify(data) === JSON.stringify(currentVehicleSnapshot(vehicle))) {
    return interaction.reply({ content: 'Provide at least one changed vehicle field.', ephemeral: true });
  }
  const errors = validateVehicleDetails(data);
  if (errors.length) return interaction.reply({ content: errors.join('\n'), ephemeral: true });
  const key = plateKey(data.plate, data.registrationState);
  const updatedAt = new Date().toISOString();
  try {
    ctx.db.transaction(() => {
      ctx.db.prepare(`
        UPDATE vehicle_applications SET roblox_username = ?, make_model = ?, plate = ?, plate_normalized = ?, plate_key = ?,
          registration_state = ?, color = ?, vehicle_year = ?, image_url = ? WHERE id = ? AND status = 'approved'
      `).run(data.robloxUsername, data.makeModel, data.plate, normalizePlate(data.plate), key,
        data.registrationState, data.color, data.vehicleYear, data.imageUrl, id);
      ctx.db.prepare(`
        INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
        VALUES (?, ?, 'updated', ?, ?)
      `).run(id, interaction.user.id, JSON.stringify({ before: currentVehicleSnapshot(vehicle), after: data }), updatedAt);
    })();
  } catch (error) {
    const message = error.code === 'SQLITE_CONSTRAINT_UNIQUE'
      ? 'Another pending or active registration already uses that plate in the selected state.'
      : error.message;
    return interaction.reply({ content: message, ephemeral: true });
  }
  return interaction.reply({ content: `Registration ${registrationCode(id)} updated.`, ephemeral: true });
}

async function revokeVehicle(interaction, ctx) {
  const id = interaction.options.getInteger('id', true);
  const reason = interaction.options.getString('reason', true).trim();
  if (!reason) return interaction.reply({ content: 'A revocation reason is required.', ephemeral: true });
  const reviewedAt = new Date().toISOString();
  const changed = ctx.db.transaction(() => {
    const result = ctx.db.prepare(`
      UPDATE vehicle_applications SET status = 'revoked', reviewed_at = ?, reviewer_id = ?, decision_reason = ?
      WHERE id = ? AND status = 'approved'
    `).run(reviewedAt, interaction.user.id, reason, id);
    if (!result.changes) return false;
    ctx.db.prepare(`
      INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
      VALUES (?, ?, 'revoked', ?, ?)
    `).run(id, interaction.user.id, JSON.stringify({ reason }), reviewedAt);
    return true;
  })();
  return interaction.reply({ content: changed ? `Registration ${registrationCode(id)} revoked.` : 'An active registration with that application ID was not found.', ephemeral: true });
}

async function setVehicleExpiration(interaction, ctx) {
  const id = interaction.options.getInteger('id', true);
  const rawDate = interaction.options.getString('expires-at');
  let expiresAt = null;
  if (rawDate) {
    if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(rawDate.trim())) {
      return interaction.reply({ content: 'Include a timezone, for example `2027-01-31T23:59:00Z`.', ephemeral: true });
    }
    const parsed = new Date(rawDate.trim());
    if (!Number.isFinite(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      return interaction.reply({ content: 'Expiration must be a valid future date and time.', ephemeral: true });
    }
    expiresAt = parsed.toISOString();
  }
  const current = ctx.db.prepare("SELECT expires_at FROM vehicle_applications WHERE id = ? AND status = 'approved'").get(id);
  if (!current) return interaction.reply({ content: 'An active approved registration with that application ID was not found.', ephemeral: true });
  const changedAt = new Date().toISOString();
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE vehicle_applications SET expires_at = ? WHERE id = ?').run(expiresAt, id);
    ctx.db.prepare(`
      INSERT INTO vehicle_registration_history (application_id, actor_id, action, details_json, created_at)
      VALUES (?, ?, 'expiration_changed', ?, ?)
    `).run(id, interaction.user.id, JSON.stringify({ before: current.expires_at, after: expiresAt }), changedAt);
  })();
  return interaction.reply({ content: expiresAt
    ? `Registration ${registrationCode(id)} expires <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:F>.`
    : `Expiration cleared for registration ${registrationCode(id)}.`, ephemeral: true });
}

async function handleVehicleCommand(interaction, ctx) {
  if (interaction.commandName !== 'vehicle') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'mine') return showMyVehicles(interaction, ctx);
  if (action === 'panel') return openVehiclePanel(interaction, ctx);
  if (!await ensureManagement(interaction, ctx.db)) return;
  if (action === 'search') return searchByPlate(interaction, ctx);
  if (action === 'list') return listApplicantVehicles(interaction, ctx);
  if (action === 'history') return registrationHistory(interaction, ctx);
  if (action === 'update') return updateVehicle(interaction, ctx);
  if (action === 'revoke') return revokeVehicle(interaction, ctx);
  if (action === 'expiration') return setVehicleExpiration(interaction, ctx);
  return interaction.reply({ content: 'That vehicle command is not available.', ephemeral: true });
}

async function handleVehicleButton(interaction, ctx) {
  if (interaction.customId === 'gv:vehicle:register') return startApplication(interaction, ctx);
  if (interaction.customId === 'gv:vehicle:mine') return showMyVehicles(interaction, ctx);
  if (interaction.customId.startsWith('gv:vehicle:continue:')) {
    return continueApplication(interaction, ctx, interaction.customId.split(':').at(-1));
  }
  const match = interaction.customId.match(/^gv:vehicle:(approve|deny):(\d+)$/);
  if (!match) return interaction.reply({ content: 'This vehicle control is not recognized.', ephemeral: true });
  const [, action, rawId] = match;
  const applicationId = Number(rawId);
  if (!Number.isSafeInteger(applicationId) || applicationId < 1) {
    return interaction.reply({ content: 'This vehicle application button is invalid.', ephemeral: true });
  }
  if (action === 'approve') return handleApproval(interaction, ctx, applicationId);
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT id, status FROM vehicle_applications WHERE id = ? AND status = 'pending'").get(applicationId);
  if (!application) return interaction.reply({ content: 'This vehicle application was already reviewed or could not be found.', ephemeral: true });
  return interaction.showModal(denyApplicationModal(applicationId));
}

async function handleVehicleModal(interaction, ctx) {
  if (interaction.customId === 'gv:vehicle:apply:basic') return submitBasicApplication(interaction, ctx);
  if (interaction.customId.startsWith('gv:vehicle:apply:details:')) {
    return submitVehicleApplication(interaction, ctx, interaction.customId.split(':').at(-1));
  }
  const denialMatch = interaction.customId.match(/^gv:vehicle:deny_submit:(\d+)(?::([^:]+))?$/);
  if (denialMatch) return handleDenialSubmit(interaction, ctx, Number(denialMatch[1]), denialMatch[2] ?? null);
  return null;
}

module.exports = {
  applicationBasicModal,
  applicationCode,
  applicationDetailsModal,
  createApplicationDraft,
  decisionEmbed,
  handleVehicleManagementButton,
  handleVehicleManagementModal,
  handleVehicleManagementSelect,
  vehiclePanelEmbed,
  handleVehicleButton,
  handleVehicleCommand,
  handleVehicleModal,
  isHttpsUrl,
  normalizePlate,
  plateKey,
  processVehicleExpirations,
  registrationCode,
  saveManagedVehicleEdit,
  savePendingApplication,
  showMemberVehicles,
  vehicleMemberPickerPayload,
  validateVehicleDetails,
  vehiclePanelComponents,
};