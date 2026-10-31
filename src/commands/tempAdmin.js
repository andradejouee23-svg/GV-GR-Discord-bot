const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement } = require('./staff');
const {
  fetchGuildMember,
  getConfigValue,
  makeEmbed,
  setConfigValue,
  validId,
} = require('../utils/discord');

const applicationDraftLifetimeMs = 15 * 60 * 1000;
const activeApplicationStatuses = ['pending', 'approving', 'approved', 'expiring'];

function getApplicationSettings(db) {
  const configuredQuestions = getConfigValue(db, 'TEMP_ADMIN_APPLICATION_QUESTIONS');
  return {
    title: getConfigValue(db, 'TEMP_ADMIN_APPLICATION_TITLE') ?? config.TEMP_ADMIN_APPLICATION_TITLE,
    description: getConfigValue(db, 'TEMP_ADMIN_APPLICATION_DESCRIPTION') ?? config.TEMP_ADMIN_APPLICATION_DESCRIPTION,
    questions: Array.isArray(configuredQuestions) ? configuredQuestions : config.TEMP_ADMIN_APPLICATION_QUESTIONS,
    durationHours: Number(getConfigValue(db, 'TEMP_ADMIN_DURATION_HOURS') ?? config.TEMP_ADMIN_DURATION_HOURS),
    roleId: getConfigValue(db, 'TEMP_ADMIN_ROLE_ID'),
    reviewChannelId: getConfigValue(db, 'TEMP_ADMIN_REVIEW_CHANNEL_ID'),
  };
}

function isApplicationConfigured(settings) {
  return validId(settings.roleId)
    && validId(settings.reviewChannelId)
    && Number.isInteger(settings.durationHours)
    && settings.durationHours >= 1
    && settings.durationHours <= 8760
    && Array.isArray(settings.questions)
    && settings.questions.length >= 1
    && settings.questions.length <= 5;
}

function createApplicationModal(draftId, settings) {
  const modal = new ModalBuilder()
    .setCustomId(`gv:tempadmin:apply:${draftId}`)
    .setTitle(settings.title.slice(0, 45));
  settings.questions.forEach((question, index) => {
    const input = new TextInputBuilder()
      .setCustomId(`answer_${index}`)
      .setLabel(question)
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1000)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(input));
  });
  return modal;
}

function applicationPanelEmbed(settings) {
  const embed = makeEmbed(config.EMBED_COLORS.management, settings.title, settings.description)
    .addFields(
      { name: 'Application questions', value: settings.questions.map((question, index) => `**${index + 1}.** ${question}`).join('\n') },
      { name: 'Temporary role duration', value: `${settings.durationHours} hour${settings.durationHours === 1 ? '' : 's'}`, inline: true },
    )
    .setFooter({ text: 'GV GR • Temporary Administration' });
  return embed;
}

function applicationPanelComponents() {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId('gv:tempadmin:apply')
    .setLabel('Apply for Temporary Admin')
    .setEmoji('📝')
    .setStyle(ButtonStyle.Primary))];
}

function applicationCode(id) {
  return `TA-${String(id).padStart(6, '0')}`;
}

function addApplicationHistory(db, applicationId, actorId, action, details, createdAt) {
  db.prepare(`
    INSERT INTO temporary_admin_application_history (application_id, actor_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(applicationId, actorId, action, JSON.stringify(details ?? {}), createdAt);
}

function createApplicationDraft(db, applicantId, settings, now = Date.now()) {
  const id = randomUUID().replaceAll('-', '');
  const createdAt = new Date(now).toISOString();
  db.prepare('DELETE FROM temporary_admin_application_drafts WHERE expires_at <= ?').run(createdAt);
  db.prepare(`
    INSERT INTO temporary_admin_application_drafts (id, applicant_id, settings_json, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, applicantId, JSON.stringify(settings), createdAt, new Date(now + applicationDraftLifetimeMs).toISOString());
  return id;
}

function getApplicationDraft(db, draftId, applicantId, now = new Date()) {
  if (!/^[a-f0-9]{32}$/.test(draftId ?? '')) return null;
  const row = db.prepare('SELECT * FROM temporary_admin_application_drafts WHERE id = ? AND applicant_id = ?')
    .get(draftId, applicantId);
  if (!row) return null;
  if (row.expires_at <= now.toISOString()) {
    db.prepare('DELETE FROM temporary_admin_application_drafts WHERE id = ?').run(draftId);
    return null;
  }
  return { ...row, settings: JSON.parse(row.settings_json) };
}

async function openApplicationPanel(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const settings = getApplicationSettings(ctx.db);
  if (!isApplicationConfigured(settings)) {
    return interaction.reply({ content: 'Configure the temporary admin role, review channel, duration, and at least one question before publishing the panel.', ephemeral: true });
  }
  const channel = interaction.options.getChannel('channel', true);
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: 'I need View Channel, Send Messages, and Embed Links permissions in the application channel.', ephemeral: true });
  }

  const payload = { embeds: [applicationPanelEmbed(settings)], components: applicationPanelComponents() };
  let message;
  const savedChannelId = getConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_CHANNEL_ID');
  const savedMessageId = getConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_MESSAGE_ID');
  if (savedChannelId === channel.id && validId(savedMessageId)) {
    try {
      const previous = await channel.messages.fetch(savedMessageId);
      message = await previous.edit(payload);
    } catch {
      message = null;
    }
  }
  const refreshed = Boolean(message);
  if (!message) message = await channel.send(payload);
  setConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_CHANNEL_ID', channel.id);
  setConfigValue(ctx.db, 'TEMP_ADMIN_APPLICATION_MESSAGE_ID', message.id);
  return interaction.reply({ content: `Temporary Admin application panel ${refreshed ? 'refreshed' : 'posted'} in <#${channel.id}>.`, ephemeral: true });
}

async function configureApplications(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const options = interaction.options;
  const changes = [];
  const title = options.getString('title');
  const description = options.getString('description');
  const role = options.getRole('role');
  const reviewChannel = options.getChannel('review-channel');
  const durationHours = options.getInteger('duration-hours');
  const questionValues = [1, 2, 3, 4, 5].map((number) => options.getString(`question-${number}`));

  if (title !== null) {
    if (!title.trim()) return interaction.reply({ content: 'Application title cannot be empty.', ephemeral: true });
    changes.push(['TEMP_ADMIN_APPLICATION_TITLE', title.trim()]);
  }
  if (description !== null) {
    if (!description.trim()) return interaction.reply({ content: 'Application description cannot be empty.', ephemeral: true });
    changes.push(['TEMP_ADMIN_APPLICATION_DESCRIPTION', description.trim()]);
  }
  if (role) changes.push(['TEMP_ADMIN_ROLE_ID', role.id]);
  if (reviewChannel) changes.push(['TEMP_ADMIN_REVIEW_CHANNEL_ID', reviewChannel.id]);
  if (durationHours !== null) changes.push(['TEMP_ADMIN_DURATION_HOURS', durationHours]);
  if (questionValues.some((question) => question !== null)) {
    const questions = questionValues.filter((question) => question !== null).map((question) => question.trim());
    if (questions.some((question) => !question || question.length > 45)) {
      return interaction.reply({ content: 'Application questions must contain 1–45 characters.', ephemeral: true });
    }
    changes.push(['TEMP_ADMIN_APPLICATION_QUESTIONS', questions]);
  }
  if (!changes.length) return interaction.reply({ content: 'Choose at least one application setting to update.', ephemeral: true });

  ctx.db.transaction(() => {
    for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
  })();
  return interaction.reply({ content: `Updated temporary admin settings: ${changes.map(([key]) => `**${key}**`).join(', ')}.`, ephemeral: true });
}

async function startApplication(interaction, ctx) {
  if (interaction.user.bot) return interaction.reply({ content: 'Bot accounts cannot submit applications.', ephemeral: true });
  const settings = getApplicationSettings(ctx.db);
  if (!isApplicationConfigured(settings)) {
    return interaction.reply({ content: 'Temporary Admin applications are not configured yet. Please contact management.', ephemeral: true });
  }
  const open = ctx.db.prepare(`
    SELECT id, status FROM temporary_admin_applications
    WHERE applicant_id = ? AND status IN ('pending', 'approving', 'approved', 'expiring') LIMIT 1
  `).get(interaction.user.id);
  if (open) return interaction.reply({ content: open.status === 'approved'
    ? `You already have an active Temporary Admin application (${applicationCode(open.id)}).`
    : `You already have a Temporary Admin application under review (${applicationCode(open.id)}).`, ephemeral: true });

  const draftId = createApplicationDraft(ctx.db, interaction.user.id, settings);
  return interaction.showModal(createApplicationModal(draftId, settings));
}

async function getReviewChannel(interaction, reviewChannelId) {
  let channel;
  try {
    channel = await interaction.client.channels.fetch(reviewChannelId);
  } catch (error) {
    console.error('Could not fetch Temporary Admin review channel:', error.message);
  }
  if (!channel || channel.guildId !== interaction.guild.id || !channel.isTextBased() || !channel.send) {
    return { error: 'The Temporary Admin review channel is unavailable. Please contact management.' };
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return { error: 'The bot needs View Channel, Send Messages, and Embed Links permissions in the review channel.' };
  }
  return { channel };
}

function applicationReviewEmbed(application) {
  const embed = makeEmbed(config.EMBED_COLORS.warning,
    `${application.application_title.slice(0, 235)} • ${applicationCode(application.id)}`,
    `**Applicant:** <@${application.applicant_id}>\n**Username:** ${application.applicant_name}\n**Submitted:** <t:${Math.floor(new Date(application.created_at).getTime() / 1000)}:F>\n**Requested role:** <@&${application.requested_role_id}>\n**Duration:** ${application.duration_hours} hours`)
    .setFooter({ text: 'GV GR • Temporary Admin Application • Management review only' });
  const questions = JSON.parse(application.questions_json);
  const answers = JSON.parse(application.answers_json);
  embed.addFields(questions.map((question, index) => ({
    name: question,
    value: answers[index] || 'No answer provided.',
  })));
  return embed;
}

function applicationReviewComponents(applicationId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:tempadmin:approve:${applicationId}`).setLabel('Approve').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gv:tempadmin:deny:${applicationId}`).setLabel('Deny').setEmoji('⛔').setStyle(ButtonStyle.Danger),
  )];
}

function decisionEmbed(application, approved) {
  const isApproved = approved;
  const fields = [
    `**Application:** ${applicationCode(application.id)}`,
    `**Role:** <@&${application.requested_role_id}>`,
    `**Submitted:** <t:${Math.floor(new Date(application.created_at).getTime() / 1000)}:F>`,
    `**Reviewed by:** <@${application.reviewer_id}>`,
    `**Status:** ${isApproved ? 'Approved' : 'Denied'}`,
    isApproved ? `**Expires:** <t:${Math.floor(new Date(application.expires_at).getTime() / 1000)}:F>` : null,
    !isApproved && application.decision_reason ? `**Reason:** ${application.decision_reason}` : null,
  ].filter(Boolean).join('\n');
  return makeEmbed(isApproved ? config.EMBED_COLORS.active : config.EMBED_COLORS.error,
    isApproved ? '✅ Temporary Admin Application Approved' : '⛔ Temporary Admin Application Denied', fields)
    .setFooter({ text: `GV GR • ${applicationCode(application.id)}` })
    .setTimestamp(new Date(application.reviewed_at));
}

async function notifyApplicant(client, application, embed) {
  try {
    const user = await client.users.fetch(application.applicant_id);
    await user.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (error) {
    console.error(`Could not DM Temporary Admin applicant ${application.applicant_id}:`, error.message);
    return false;
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
    console.error(`Could not update Temporary Admin application ${applicationCode(application.id)}:`, error.message);
    return false;
  }
}

async function submitApplication(interaction, ctx, draftId) {
  const draft = getApplicationDraft(ctx.db, draftId, interaction.user.id);
  if (!draft) return interaction.reply({ content: 'This application form expired. Reopen the panel to start again.', ephemeral: true });
  const settings = draft.settings;
  if (!isApplicationConfigured(settings)) return interaction.reply({ content: 'This application form is no longer configured. Contact management.', ephemeral: true });
  const answers = settings.questions.map((question, index) => interaction.fields.getTextInputValue(`answer_${index}`).trim());
  if (answers.some((answer) => !answer)) return interaction.reply({ content: 'Please answer every application question.', ephemeral: true });
  const review = await getReviewChannel(interaction, settings.reviewChannelId);
  if (review.error) return interaction.reply({ content: review.error, ephemeral: true });

  let applicationId;
  const createdAt = new Date().toISOString();
  try {
    applicationId = ctx.db.transaction(() => {
      const open = ctx.db.prepare(`
        SELECT id FROM temporary_admin_applications
        WHERE applicant_id = ? AND status IN ('pending', 'approving', 'approved', 'expiring') LIMIT 1
      `).get(interaction.user.id);
      if (open) throw new Error('You already have a pending or active Temporary Admin application.');
      const result = ctx.db.prepare(`
        INSERT INTO temporary_admin_applications (
          applicant_id, applicant_name, application_title, application_description,
          questions_json, answers_json, requested_role_id, duration_hours, status,
          created_at, review_channel_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(interaction.user.id, interaction.user.username, settings.title, settings.description,
        JSON.stringify(settings.questions), JSON.stringify(answers), settings.roleId, settings.durationHours,
        createdAt, review.channel.id);
      const id = Number(result.lastInsertRowid);
      addApplicationHistory(ctx.db, id, interaction.user.id, 'submitted', { answers }, createdAt);
      ctx.db.prepare('DELETE FROM temporary_admin_application_drafts WHERE id = ?').run(draftId);
      return id;
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return interaction.reply({ content: 'You already have a pending or active Temporary Admin application.', ephemeral: true });
    }
    return interaction.reply({ content: error.message, ephemeral: true });
  }

  const application = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  let message;
  try {
    message = await review.channel.send({
      embeds: [applicationReviewEmbed(application)],
      components: applicationReviewComponents(applicationId),
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error(`Could not post Temporary Admin application ${applicationCode(applicationId)}:`, error.message);
  }
  if (message) {
    ctx.db.prepare('UPDATE temporary_admin_applications SET review_message_id = ? WHERE id = ?')
      .run(message.id, applicationId);
  }
  return interaction.reply({ content: message
    ? `Application ${applicationCode(applicationId)} was sent to management for review.`
    : `Application ${applicationCode(applicationId)} was saved, but staff could not be notified. You can check its status with /tempadmin history.`, ephemeral: true });
}

function denialModal(applicationId) {
  const input = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel('Optional reason for denial')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000)
    .setRequired(false);
  return new ModalBuilder()
    .setCustomId(`gv:tempadmin:deny_submit:${applicationId}`)
    .setTitle('Deny Temporary Admin Application')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function claimApplicationForApproval(db, application, reviewerId, reviewedAt) {
  return db.prepare(`
    UPDATE temporary_admin_applications SET status = 'approving', reviewed_at = ?, reviewer_id = ?
    WHERE id = ? AND status = 'pending'
  `).run(reviewedAt, reviewerId, application.id).changes > 0;
}

async function handleApproval(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'pending'").get(applicationId);
  if (!application) return interaction.reply({ content: 'This application was already reviewed or could not be found.', ephemeral: true });
  const reviewedAt = new Date().toISOString();
  if (!await claimApplicationForApproval(ctx.db, application, interaction.user.id, reviewedAt)) {
    return interaction.reply({ content: 'This application is already being reviewed.', ephemeral: true });
  }

  let member;
  let role;
  let assigned = false;
  try {
    member = await interaction.guild.members.fetch(application.applicant_id);
    role = await interaction.guild.roles.fetch(application.requested_role_id);
    const botMember = interaction.guild.members.me;
    if (!role || role.managed || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)
      || !botMember.roles.highest || role.position >= botMember.roles.highest.position) {
      throw new Error('The configured role is unavailable or above the bot’s role. Check Manage Roles and role hierarchy.');
    }
    if (member.roles.cache.has(role.id)) throw new Error('The applicant already has the role being requested.');
    await member.roles.add(role, `Temporary Admin application ${applicationCode(applicationId)} approved by ${interaction.user.username}`);
    assigned = true;
    const expiresAt = new Date(Date.parse(reviewedAt) + application.duration_hours * 3600_000).toISOString();
    ctx.db.transaction(() => {
      const result = ctx.db.prepare(`
        UPDATE temporary_admin_applications SET status = 'approved', expires_at = ?
        WHERE id = ? AND status = 'approving'
      `).run(expiresAt, applicationId);
      if (!result.changes) throw new Error('Application approval could not be finalized.');
      addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'approved', {
        roleId: role.id, durationHours: application.duration_hours, expiresAt,
      }, reviewedAt);
    })();
  } catch (error) {
    if (assigned && member && role) {
      await member.roles.remove(role, `Rolling back incomplete approval ${applicationCode(applicationId)}`).catch((removeError) => {
        console.error('Could not roll back a Temporary Admin role after an approval error:', removeError.message);
      });
    }
    ctx.db.prepare(`
      UPDATE temporary_admin_applications SET status = 'pending', reviewed_at = NULL, reviewer_id = NULL
      WHERE id = ? AND status = 'approving'
    `).run(applicationId);
    return interaction.reply({ content: `Approval was not completed: ${error.message}`, ephemeral: true });
  }

  const approved = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  const embed = decisionEmbed(approved, true);
  await interaction.update({ embeds: [embed], components: [] });
  if (!await notifyApplicant(interaction.client, approved, embed)) {
    await interaction.followUp({ content: 'Role assigned and application approved, but the applicant’s DMs are unavailable. They can view the decision privately with `/tempadmin history`.', ephemeral: true }).catch(() => {});
  }
}

async function submitDenial(interaction, ctx, applicationId) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const application = ctx.db.prepare("SELECT * FROM temporary_admin_applications WHERE id = ? AND status = 'pending'").get(applicationId);
  if (!application) return interaction.reply({ content: 'This application was already reviewed or could not be found.', ephemeral: true });
  const reason = interaction.fields.getTextInputValue('reason').trim() || 'No reason provided.';
  const reviewedAt = new Date().toISOString();
  const changed = ctx.db.transaction(() => {
    const result = ctx.db.prepare(`
      UPDATE temporary_admin_applications SET status = 'denied', reviewed_at = ?, reviewer_id = ?, decision_reason = ?
      WHERE id = ? AND status = 'pending'
    `).run(reviewedAt, interaction.user.id, reason, applicationId);
    if (!result.changes) return false;
    addApplicationHistory(ctx.db, applicationId, interaction.user.id, 'denied', { reason }, reviewedAt);
    return true;
  })();
  if (!changed) return interaction.reply({ content: 'This application was already reviewed.', ephemeral: true });

  const denied = ctx.db.prepare('SELECT * FROM temporary_admin_applications WHERE id = ?').get(applicationId);
  const embed = decisionEmbed(denied, false);
  await updateReviewMessage(interaction.client, denied, embed);
  if (!await notifyApplicant(interaction.client, denied, embed)) {
    return interaction.reply({ content: 'Application denied. The applicant’s DMs are unavailable; they can view the decision privately with `/tempadmin history`.', ephemeral: true });
  }
  return interaction.reply({ content: `Application ${applicationCode(applicationId)} denied and the applicant was notified privately.`, ephemeral: true });
}

function applicationHistoryEmbed(applicantId, rows) {
  const description = rows.length
    ? rows.map((row) => {
      const expiration = row.expires_at ? `\nExpires: <t:${Math.floor(new Date(row.expires_at).getTime() / 1000)}:F>` : '';
      const reason = row.decision_reason ? `\nReason: ${row.decision_reason}` : '';
      return `**${applicationCode(row.id)} • ${row.status.toUpperCase()}**\nSubmitted <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>${expiration}${reason}`;
    }).join('\n\n')
    : 'No Temporary Admin applications were found.';
  return makeEmbed(config.EMBED_COLORS.info, `📄 Temporary Admin History • ${applicantId}`, description.slice(0, 4000));
}

async function showApplicationHistory(interaction, ctx) {
  const target = interaction.options.getUser('member');
  if (target && target.id !== interaction.user.id && !await ensureManagement(interaction, ctx.db)) return;
  const applicantId = target?.id ?? interaction.user.id;
  const rows = ctx.db.prepare(`
    SELECT id, status, created_at, expires_at, decision_reason
    FROM temporary_admin_applications WHERE applicant_id = ? ORDER BY id DESC LIMIT 10
  `).all(applicantId);
  return interaction.reply({ embeds: [applicationHistoryEmbed(target?.username ?? interaction.user.username, rows)], ephemeral: true });
}

async function handleTempAdminCommand(interaction, ctx) {
  if (interaction.commandName !== 'tempadmin') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'history') return showApplicationHistory(interaction, ctx);
  if (action === 'panel') return openApplicationPanel(interaction, ctx);
  if (action === 'configure') return configureApplications(interaction, ctx);
  return interaction.reply({ content: 'That Temporary Admin command is not available.', ephemeral: true });
}

async function handleTempAdminButton(interaction, ctx) {
  if (interaction.customId === 'gv:tempadmin:apply') return startApplication(interaction, ctx);
  const match = interaction.customId.match(/^gv:tempadmin:(approve|deny):(\d+)$/);
  if (!match) return interaction.reply({ content: 'This Temporary Admin control is not recognized.', ephemeral: true });
  const applicationId = Number(match[2]);
  if (!Number.isSafeInteger(applicationId) || applicationId < 1) {
    return interaction.reply({ content: 'This application control is invalid.', ephemeral: true });
  }
  if (match[1] === 'approve') return handleApproval(interaction, ctx, applicationId);
  if (!await ensureManagement(interaction, ctx.db)) return;
  const pending = ctx.db.prepare("SELECT id FROM temporary_admin_applications WHERE id = ? AND status = 'pending'").get(applicationId);
  if (!pending) return interaction.reply({ content: 'This application was already reviewed or could not be found.', ephemeral: true });
  return interaction.showModal(denialModal(applicationId));
}

async function handleTempAdminModal(interaction, ctx) {
  const applicationMatch = interaction.customId.match(/^gv:tempadmin:apply:([a-f0-9]{32})$/);
  if (applicationMatch) return submitApplication(interaction, ctx, applicationMatch[1]);
  const denialMatch = interaction.customId.match(/^gv:tempadmin:deny_submit:(\d+)$/);
  if (denialMatch) return submitDenial(interaction, ctx, Number(denialMatch[1]));
  return null;
}

function finalizeExpiredApplication(db, application, actorId, nowIso, details = {}) {
  db.transaction(() => {
    const result = db.prepare("UPDATE temporary_admin_applications SET status = 'expired' WHERE id = ? AND status = 'expiring'")
      .run(application.id);
    if (result.changes) addApplicationHistory(db, application.id, actorId, 'expired', details, nowIso);
  })();
}

async function processTemporaryAdminExpirations(client, db, now = new Date()) {
  let guild = client.guilds?.cache?.get(config.SERVER_ID);
  if (!guild) {
    try {
      guild = await client.guilds.fetch(config.SERVER_ID);
    } catch (error) {
      console.error('Could not load server for Temporary Admin expiration processing:', error.message);
      return 0;
    }
  }
  const nowIso = now.toISOString();

  for (const application of db.prepare("SELECT * FROM temporary_admin_applications WHERE status = 'approving'").all()) {
    try {
      const member = await guild.members.fetch(application.applicant_id);
      const hasRole = member.roles.cache.has(application.requested_role_id);
      if (!hasRole) {
        db.prepare(`
          UPDATE temporary_admin_applications SET status = 'pending', reviewed_at = NULL, reviewer_id = NULL
          WHERE id = ? AND status = 'approving'
        `).run(application.id);
        continue;
      }
      const expiresAt = new Date(Date.parse(application.reviewed_at) + application.duration_hours * 3600_000).toISOString();
      db.transaction(() => {
        const result = db.prepare(`
          UPDATE temporary_admin_applications SET status = 'approved', expires_at = ?
          WHERE id = ? AND status = 'approving'
        `).run(expiresAt, application.id);
        if (result.changes) addApplicationHistory(db, application.id, application.reviewer_id, 'approval_recovered', { expiresAt }, nowIso);
      })();
    } catch (error) {
      console.error(`Could not recover Temporary Admin application ${applicationCode(application.id)}:`, error.message);
    }
  }

  const expired = db.prepare(`
    SELECT * FROM temporary_admin_applications
    WHERE status = 'expiring' OR (status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?)
    ORDER BY expires_at
  `).all(nowIso);
  let completed = 0;
  for (const application of expired) {
    if (application.status === 'approved') {
      const claimed = db.prepare(`
        UPDATE temporary_admin_applications SET status = 'expiring'
        WHERE id = ? AND status = 'approved' AND expires_at <= ?
      `).run(application.id, nowIso);
      if (!claimed.changes) continue;
    }
    let member;
    try {
      member = await guild.members.fetch(application.applicant_id);
    } catch (error) {
      if (error.code === 10007) {
        finalizeExpiredApplication(db, application, 'system', nowIso, { reason: 'Applicant is no longer in the server.' });
        completed += 1;
      } else {
        db.prepare("UPDATE temporary_admin_applications SET status = 'approved' WHERE id = ? AND status = 'expiring'").run(application.id);
        console.error(`Could not fetch Temporary Admin applicant ${application.applicant_id}:`, error.message);
      }
      continue;
    }
    try {
      if (member.roles.cache.has(application.requested_role_id)) {
        await member.roles.remove(application.requested_role_id, `Temporary Admin application ${applicationCode(application.id)} expired`);
      }
      finalizeExpiredApplication(db, application, 'system', nowIso, { roleId: application.requested_role_id });
      completed += 1;
    } catch (error) {
      db.prepare("UPDATE temporary_admin_applications SET status = 'approved' WHERE id = ? AND status = 'expiring'").run(application.id);
      console.error(`Could not remove expired Temporary Admin role from ${application.applicant_id}:`, error.message);
    }
  }
  return completed;
}

module.exports = {
  applicationPanelComponents,
  applicationPanelEmbed,
  createApplicationDraft,
  createApplicationModal,
  getApplicationSettings,
  handleTempAdminButton,
  handleTempAdminCommand,
  handleTempAdminModal,
  processTemporaryAdminExpirations,
};