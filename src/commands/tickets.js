const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { logAudit } = require('../services/staffRewards');
const {
  getConfigValue,
  getInteractionMember,
  getRoleIds,
  hasRoleGroup,
  makeEmbed,
  memberRoleIds,
  setConfigValue,
  validId,
} = require('../utils/discord');
const { isManagement } = require('./staffCenter');

const ticketTypes = {
  general: {
    label: 'General Support',
    categoryKey: 'TICKET_SUPPORT_CATEGORY_ID',
    fields: [
      ['subject', 'What do you need help with?', TextInputStyle.Short, 100, true],
      ['details', 'Describe the issue', TextInputStyle.Paragraph, 1500, true],
      ['reference', 'Player/user or related reference (optional)', TextInputStyle.Short, 100, false],
    ],
  },
  staff_application: {
    label: 'Staff Applications',
    categoryKey: 'TICKET_APPLICATION_CATEGORY_ID',
    fields: [
      ['name', 'Preferred name', TextInputStyle.Short, 100, true],
      ['availability', 'Availability and timezone', TextInputStyle.Short, 200, true],
      ['experience', 'Relevant experience', TextInputStyle.Paragraph, 1000, true],
      ['motivation', 'Why do you want to join staff?', TextInputStyle.Paragraph, 1000, true],
      ['scenario', 'How would you handle a conflict?', TextInputStyle.Paragraph, 1000, true],
    ],
  },
  admin_recruiting: {
    label: 'Admin Testing and Recruiting',
    categoryKey: 'TICKET_RECRUITING_CATEGORY_ID',
    fields: [
      ['username', 'Greenville/Roblox username', TextInputStyle.Short, 100, true],
      ['position', 'Position of interest', TextInputStyle.Short, 100, true],
      ['availability', 'Availability and timezone', TextInputStyle.Short, 200, true],
      ['experience', 'Relevant experience', TextInputStyle.Paragraph, 1000, true],
      ['scenario', 'How would you handle an abuse report?', TextInputStyle.Paragraph, 1000, true],
    ],
  },
};

const reviewerRoleIds = (db) => [...new Set([...getRoleIds(db, 'management'), ...getRoleIds(db, 'owners')])].filter(validId);

function recruitingRoleId(db) {
  const savedRoles = getConfigValue(db, 'role_admin_recruiting');
  if (Array.isArray(savedRoles)) return savedRoles.length === 1 && validId(savedRoles[0]) ? savedRoles[0] : null;
  const fallback = getConfigValue(db, 'ADMIN_RECRUITING_ROLE_ID');
  return validId(fallback) ? fallback : null;
}

function ticketPanelComponents() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gv:ticket:create:general').setLabel('General Support').setEmoji('🛟').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('gv:ticket:create:staff_application').setLabel('Staff Application').setEmoji('📝').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('gv:ticket:create:admin_recruiting').setLabel('Admin Testing / Recruiting').setEmoji('🧪').setStyle(ButtonStyle.Secondary),
  )];
}

function ticketModal(type) {
  const definition = ticketTypes[type];
  const modal = new ModalBuilder().setCustomId(`gv:ticket:submit:${type}`).setTitle(definition.label);
  return modal.addComponents(...definition.fields.map(([id, label, style, maxLength, required]) =>
    new ActionRowBuilder().addComponents(new TextInputBuilder()
      .setCustomId(id).setLabel(label).setStyle(style).setMaxLength(maxLength).setRequired(required))));
}

function ticketControls(ticketId, type, status = 'open') {
  const closed = status === 'closed';
  const buttons = [new ButtonBuilder().setCustomId(`gv:ticket:close:${ticketId}`)
    .setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Secondary).setDisabled(closed)];
  if (type === 'admin_recruiting') {
    buttons.push(
      new ButtonBuilder().setCustomId(`gv:ticket:decision:${ticketId}:accept`).setLabel('Accept').setStyle(ButtonStyle.Success).setDisabled(status !== 'open'),
      new ButtonBuilder().setCustomId(`gv:ticket:decision:${ticketId}:reject`).setLabel('Reject').setStyle(ButtonStyle.Danger).setDisabled(status !== 'open'),
      new ButtonBuilder().setCustomId(`gv:ticket:review_note:${ticketId}`).setLabel('View Internal Notes').setStyle(ButtonStyle.Secondary),
    );
  }
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function ticketFormEmbed(ticket, answers, status = 'open') {
  const fields = Object.entries(answers).map(([name, value]) => ({ name: name.replaceAll('_', ' '), value: String(value).slice(0, 1024) || 'Not provided' }));
  const embed = new EmbedBuilder().setColor(config.EMBED_COLORS.management)
    .setTitle(`${ticketTypes[ticket.ticket_type].label} • Ticket #${ticket.id}`)
    .setDescription(`Requester: <@${ticket.requester_id}>\nStatus: **${status.toUpperCase()}**`)
    .addFields(fields)
    .setFooter({ text: 'Private ticket • Use the controls below to review or close' })
    .setTimestamp(new Date(ticket.created_at));
  if (ticket.ticket_type === 'admin_recruiting') {
    embed.addFields({ name: 'Testing', value: 'Recruiting staff will provide instructions and record review notes in this private channel.' });
  }
  return embed;
}

function explicitCategoryPrivacy(category, guild, allowedRoleIds, botMember) {
  const overwrites = category.permissionOverwrites?.cache;
  if (!overwrites) return false;
  const everyone = overwrites.get(guild.id);
  if (!everyone?.deny?.has(PermissionFlagsBits.ViewChannel)) return false;
  const allowed = new Set([guild.id, ...allowedRoleIds, ...[...(botMember?.roles?.cache?.keys() ?? [])]]);
  for (const overwrite of overwrites.values()) {
    if (overwrite.type === 0 && overwrite.allow?.has(PermissionFlagsBits.ViewChannel) && !allowed.has(overwrite.id)) return false;
  }
  return true;
}

async function requireManagement(interaction, db) {
  const member = await getInteractionMember(interaction);
  if (member && isManagement(member, interaction.guild, db)) return true;
  await interaction.reply({ content: 'Management access is required to post the ticket panel.', ephemeral: true });
  return false;
}

async function handleTicketPanelCommand(interaction, ctx) {
  if (interaction.commandName !== 'ticket-panel') return null;
  if (!await requireManagement(interaction, ctx.db)) return;
  const channel = interaction.options.getChannel('channel', true);
  if (!channel.isTextBased() || !channel.send) return interaction.reply({ content: 'Choose a text channel for the ticket panel.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const oldMessageId = getConfigValue(ctx.db, 'ticket_panel_message');
  const oldChannelId = getConfigValue(ctx.db, 'ticket_panel_channel');
  if (oldMessageId && oldChannelId && oldChannelId !== channel.id) {
    try {
      const oldChannel = await interaction.client.channels.fetch(oldChannelId);
      const oldMessage = oldChannel?.isTextBased() ? await oldChannel.messages.fetch(oldMessageId) : null;
      await oldMessage?.edit({ content: `The ticket panel moved to <#${channel.id}>.`, components: [] });
    } catch (error) {
      console.error('Could not retire the old ticket panel:', error.message);
    }
  }
  let message;
  if (oldMessageId && (!oldChannelId || oldChannelId === channel.id)) {
    try { message = await (await channel.messages.fetch(oldMessageId)).edit({
      embeds: [makeEmbed(config.EMBED_COLORS.management, 'GV GR SUPPORT & APPLICATIONS',
        'Choose the private ticket type that best fits your request.')],
      components: ticketPanelComponents(),
    }); } catch { message = null; }
  }
  if (!message) message = await channel.send({
    embeds: [makeEmbed(config.EMBED_COLORS.management, 'GV GR SUPPORT & APPLICATIONS',
      'Choose the private ticket type that best fits your request.')],
    components: ticketPanelComponents(),
  });
  setConfigValue(ctx.db, 'ticket_panel_message', message.id);
  setConfigValue(ctx.db, 'ticket_panel_channel', channel.id);
  return interaction.editReply({ content: `Ticket panel posted in <#${channel.id}>.` });
}

async function validateCategory(interaction, db, type) {
  const definition = ticketTypes[type];
  const categoryId = getConfigValue(db, definition.categoryKey);
  if (!validId(categoryId)) throw new Error(`${definition.label} category is not configured in Owner Settings.`);
  const category = await interaction.guild.channels.fetch(categoryId).catch(() => null);
  if (!category || category.type !== ChannelType.GuildCategory) throw new Error(`${definition.label} category is unavailable.`);
  const roleIds = type === 'admin_recruiting' ? [recruitingRoleId(db)].filter(Boolean) : reviewerRoleIds(db);
  if (type === 'admin_recruiting' && roleIds.length !== 1) throw new Error('The Owner must configure exactly one Admin testing/recruiting role.');
  if (!explicitCategoryPrivacy(category, interaction.guild, roleIds, interaction.guild.members.me)) {
    throw new Error(`${definition.label} category is not private or grants access to an unconfigured role. Deny @everyone View Channel and only allow the intended reviewer roles.`);
  }
  return { category, roleIds };
}

function ticketPermissionOverwrites(guild, client, requesterId, reviewerIds) {
  const view = PermissionFlagsBits.ViewChannel;
  const history = PermissionFlagsBits.ReadMessageHistory;
  const send = PermissionFlagsBits.SendMessages;
  const attach = PermissionFlagsBits.AttachFiles;
  const embed = PermissionFlagsBits.EmbedLinks;
  const overwrites = [
    { id: guild.id, deny: [view] },
    { id: requesterId, allow: [view, send, history, attach, embed] },
    { id: client.user.id, allow: [view, send, history, attach, embed, PermissionFlagsBits.ManageChannels] },
    ...reviewerIds.map((id) => ({ id, allow: [view, send, history, attach, embed] })),
  ];
  return overwrites;
}

async function createTicket(interaction, ctx, type) {
  if (!ticketTypes[type]) return interaction.reply({ content: 'That ticket type is not supported.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const answers = Object.fromEntries(ticketTypes[type].fields.map(([id]) =>
    [id, interaction.fields.getTextInputValue(id).trim()]));
  const subject = answers.subject || answers.position || `${ticketTypes[type].label} application`;
  let category;
  let roleIds;
  try {
    ({ category, roleIds } = await validateCategory(interaction, ctx.db, type));
  } catch (error) {
    return interaction.editReply({ content: error.message });
  }

  let ticketId;
  const now = new Date().toISOString();
  try {
    const result = ctx.db.prepare(`INSERT INTO tickets
      (ticket_type, requester_id, requester_name, subject, answers_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'creating', ?, ?)`)
      .run(type, interaction.user.id, interaction.user.username, subject, JSON.stringify(answers), now, now);
    ticketId = Number(result.lastInsertRowid);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return interaction.editReply({ content: `You already have an open ${ticketTypes[type].label} ticket. Check your existing private ticket channel.` });
    }
    throw error;
  }

  let channel;
  try {
    const safeName = `${type.replaceAll('_', '-')}-${String(ticketId).padStart(4, '0')}-${interaction.user.username}`
      .toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 90);
    channel = await interaction.guild.channels.create({
      name: safeName,
      type: ChannelType.GuildText,
      parent: category.id,
      topic: `GV GR private ${ticketTypes[type].label} ticket #${ticketId} for ${interaction.user.id}`,
      permissionOverwrites: ticketPermissionOverwrites(interaction.guild, interaction.client, interaction.user.id, roleIds),
    });
    const ticket = { id: ticketId, ticket_type: type, requester_id: interaction.user.id, created_at: now };
    const message = await channel.send({
      embeds: [ticketFormEmbed(ticket, answers)],
      components: ticketControls(ticketId, type),
      allowedMentions: { parse: [] },
    });
    ctx.db.prepare(`UPDATE tickets SET channel_id = ?, panel_message_id = ?, status = 'open', updated_at = ? WHERE id = ? AND status = 'creating'`)
      .run(channel.id, message.id, new Date().toISOString(), ticketId);
    logAudit(ctx.db, {
      action: 'ticket_created', targetId: interaction.user.id, actorId: interaction.user.id,
      reason: `Created ${ticketTypes[type].label} ticket`, details: { ticketId, channelId: channel.id, ticketType: type },
    });
    return interaction.editReply({ content: `Your private ${ticketTypes[type].label} ticket is ready: <#${channel.id}>.` });
  } catch (error) {
    if (channel) await channel.delete('Ticket setup failed').catch(() => {});
    ctx.db.prepare("UPDATE tickets SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'creating'")
      .run(new Date().toISOString(), ticketId);
    console.error(`Could not create ticket #${ticketId}:`, error.message);
    return interaction.editReply({ content: 'The private ticket could not be created. Check the configured category and bot channel permissions.' });
  }
}

function ticketReviewerAuthorized(member, ticket, db) {
  const roles = new Set(memberRoleIds(member));
  if (ticket.ticket_type === 'admin_recruiting') {
    const roleId = recruitingRoleId(db);
    return Boolean(roleId && roles.has(roleId));
  }
  return reviewerRoleIds(db).some((roleId) => roles.has(roleId));
}

async function handleTicketButton(interaction, ctx) {
  const parts = interaction.customId.split(':');
  if (parts[2] === 'create') {
    const type = parts[3];
    if (!ticketTypes[type]) return interaction.reply({ content: 'That ticket type is not available.', ephemeral: true });
    return interaction.showModal(ticketModal(type));
  }

  const ticketId = Number(parts[3]);
  if (!Number.isSafeInteger(ticketId) || ticketId < 1) return interaction.reply({ content: 'That ticket action is invalid.', ephemeral: true });
  const ticket = ctx.db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return interaction.reply({ content: 'This ticket record could not be found.', ephemeral: true });
  const member = await getInteractionMember(interaction);
  const isRequester = interaction.user.id === ticket.requester_id;
  const isReviewer = member && ticketReviewerAuthorized(member, ticket, ctx.db);
  const [, , action, , decision] = parts;

  if (action === 'decision') {
    if (!isReviewer || ticket.ticket_type !== 'admin_recruiting') return interaction.reply({ content: 'Only the configured recruiting role can decide this application.', ephemeral: true });
    if (ticket.status !== 'open') return interaction.reply({ content: `This ticket is already ${ticket.status}.`, ephemeral: true });
    if (!['accept', 'reject'].includes(decision)) return interaction.reply({ content: 'Choose accept or reject.', ephemeral: true });
    return interaction.showModal(new ModalBuilder().setCustomId(`gv:ticket:decision_submit:${ticketId}:${decision}`)
      .setTitle(decision === 'accept' ? 'Accept Application' : 'Reject Application')
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder()
        .setCustomId('review_note').setLabel('Private review note').setStyle(TextInputStyle.Paragraph).setMaxLength(1000).setRequired(true))));
  }
  if (action === 'review_note') {
    if (!isReviewer || ticket.ticket_type !== 'admin_recruiting') return interaction.reply({ content: 'Only the configured recruiting role can view internal notes.', ephemeral: true });
    return interaction.reply({ content: ticket.review_note || 'No internal review note has been recorded.', ephemeral: true });
  }

  if (action === 'close') {
    if (!isRequester && !isReviewer) return interaction.reply({ content: 'Only the requester or authorized ticket staff can close this ticket.', ephemeral: true });
    if (['closed', 'closing'].includes(ticket.status)) return interaction.reply({ content: 'This ticket is already closed.', ephemeral: true });
    return interaction.reply({ content: `Close ticket #${ticket.id}? This locks the requester’s channel access and preserves the ticket record.`, components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:ticket:close_confirm:${ticket.id}`).setLabel('Confirm Close').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`gv:ticket:close_cancel:${ticket.id}`).setLabel('Keep Open').setStyle(ButtonStyle.Secondary),
    )], ephemeral: true });
  }

  if (action === 'close_cancel') return interaction.update({ content: 'Ticket remains open.', components: [] });
  if (action === 'close_confirm') {
    if (!isRequester && !isReviewer) return interaction.reply({ content: 'Only the requester or authorized ticket staff can close this ticket.', ephemeral: true });
    if (['closed', 'closing'].includes(ticket.status)) return interaction.reply({ content: 'This ticket is already closed.', ephemeral: true });
    const claimed = ctx.db.prepare(`UPDATE tickets SET status = 'closing', updated_at = ? WHERE id = ? AND status IN ('open', 'accepted', 'rejected')`)
      .run(new Date().toISOString(), ticket.id);
    if (!claimed.changes) return interaction.reply({ content: 'Ticket state changed; no close action was applied.', ephemeral: true });
    await interaction.deferUpdate();
    const channel = await interaction.client.channels.fetch(ticket.channel_id).catch(() => null);
    let transcriptStatus = 'not configured';
    if (channel?.isTextBased()) {
      await channel.permissionOverwrites.edit(ticket.requester_id, { SendMessages: false }).catch(() => {});
      await channel.send({ content: `Ticket #${ticket.id} was closed by <@${interaction.user.id}>.`, allowedMentions: { users: [interaction.user.id] } }).catch(() => {});
      if (ticket.panel_message_id) {
        const panel = await channel.messages.fetch(ticket.panel_message_id).catch(() => null);
        await panel?.edit({ embeds: [ticketFormEmbed(ticket, JSON.parse(ticket.answers_json), 'closed')],
          components: ticketControls(ticket.id, ticket.ticket_type, 'closed') }).catch(() => {});
      }
      transcriptStatus = await sendPrivateTranscript(interaction, ctx, ticket, channel);
    }
    ctx.db.transaction(() => {
      const closedAt = new Date().toISOString();
      ctx.db.prepare("UPDATE tickets SET status = 'closed', closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ? AND status = 'closing'")
        .run(closedAt, interaction.user.id, closedAt, ticket.id);
      logAudit(ctx.db, {
        action: 'ticket_closed', targetId: ticket.requester_id, actorId: interaction.user.id,
        reason: 'Ticket closed', details: { ticketId: ticket.id, ticketType: ticket.ticket_type, transcriptStatus }, createdAt: closedAt,
      });
    })();
    return interaction.editReply({ content: `Ticket #${ticket.id} closed. Transcript: ${transcriptStatus}.`, components: [] });
  }
  return interaction.reply({ content: 'That ticket action is not recognized.', ephemeral: true });
}

async function sendPrivateTranscript(interaction, ctx, ticket, ticketChannel) {
  const transcriptId = getConfigValue(ctx.db, 'TICKET_TRANSCRIPT_CHANNEL_ID');
  if (!validId(transcriptId)) return 'not configured';
  const channel = await interaction.client.channels.fetch(transcriptId).catch(() => null);
  if (!channel?.isTextBased() || !channel.send) return 'destination unavailable';
  const overwrites = channel.permissionOverwrites?.cache;
  const everyoneOverwrite = overwrites?.get(interaction.guild.id);
  if (!overwrites || !everyoneOverwrite?.deny?.has(PermissionFlagsBits.ViewChannel)) {
    return 'skipped because destination privacy could not be verified';
  }
  const allowedRoleIds = new Set([...reviewerRoleIds(ctx.db), recruitingRoleId(ctx.db)].filter(Boolean));
  for (const overwrite of overwrites.values()) {
    if (overwrite.type === 0 && overwrite.allow?.has(PermissionFlagsBits.ViewChannel)
      && overwrite.id !== interaction.guild.id && !allowedRoleIds.has(overwrite.id)
      && !memberRoleIds(interaction.guild.members.me).includes(overwrite.id)) {
      return 'skipped because the destination grants access to an unconfigured role';
    }
  }
  const messages = await ticketChannel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!messages) return 'message history unavailable';
  const lines = [...messages.values()].reverse().map((message) =>
    `[${message.createdAt?.toISOString?.() ?? 'unknown time'}] ${message.author?.tag ?? message.author?.username ?? 'Unknown'}: ${message.content ?? ''}`);
  const transcript = new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), { name: `ticket-${ticket.id}-transcript.txt` });
  await channel.send({ content: `Private transcript for ticket #${ticket.id} (${ticketTypes[ticket.ticket_type].label}).`, files: [transcript], allowedMentions: { parse: [] } });
  return 'sent to the configured private channel';
}

async function handleTicketModal(interaction, ctx) {
  if (interaction.customId.startsWith('gv:ticket:submit:')) {
    const type = interaction.customId.split(':').at(-1);
    return createTicket(interaction, ctx, type);
  }
  if (!interaction.customId.startsWith('gv:ticket:decision_submit:')) return null;
  const [, , , ticketIdText, decision] = interaction.customId.split(':');
  const ticket = ctx.db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(ticketIdText));
  if (!ticket || ticket.ticket_type !== 'admin_recruiting') return interaction.reply({ content: 'This recruiting ticket was not found.', ephemeral: true });
  const member = await getInteractionMember(interaction);
  if (!member || !ticketReviewerAuthorized(member, ticket, ctx.db)) return interaction.reply({ content: 'Only the configured recruiting role can decide this application.', ephemeral: true });
  if (ticket.status !== 'open' || !['accept', 'reject'].includes(decision)) return interaction.reply({ content: 'This application has already been reviewed.', ephemeral: true });
  const reviewNote = interaction.fields.getTextInputValue('review_note').trim();
  if (!reviewNote) return interaction.reply({ content: 'A private review note is required.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const status = decision === 'accept' ? 'accepted' : 'rejected';
  const changed = ctx.db.prepare('UPDATE tickets SET status = ?, review_note = ?, updated_at = ? WHERE id = ? AND status = \'open\'')
    .run(status, reviewNote, new Date().toISOString(), ticket.id);
  if (!changed.changes) return interaction.editReply({ content: 'This application was reviewed by someone else.' });
  const channel = await interaction.client.channels.fetch(ticket.channel_id).catch(() => null);
  await channel?.send?.({ content: `Application ${status} by <@${interaction.user.id}>. Internal review notes are available to the configured recruiting role only.`, allowedMentions: { users: [interaction.user.id] } });
  if (channel && ticket.panel_message_id) {
    const panel = await channel.messages.fetch(ticket.panel_message_id).catch(() => null);
    await panel?.edit({ embeds: [ticketFormEmbed(ticket, JSON.parse(ticket.answers_json), status)],
      components: ticketControls(ticket.id, ticket.ticket_type, status) }).catch(() => {});
  }
  logAudit(ctx.db, {
    action: `ticket_${status}`, targetId: ticket.requester_id, actorId: interaction.user.id,
    reason: reviewNote, details: { ticketId: ticket.id, ticketType: ticket.ticket_type },
  });
  return interaction.editReply({ content: `Ticket #${ticket.id} marked ${status}. The review note is private to the configured recruiting role.` });
}

module.exports = {
  handleTicketButton,
  handleTicketModal,
  handleTicketPanelCommand,
  ticketPanelComponents,
  ticketPermissionOverwrites,
};