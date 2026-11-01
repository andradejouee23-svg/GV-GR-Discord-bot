const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement } = require('./staff');
const {
  getConfigValue,
  makeEmbed,
  setConfigValue,
  validId,
} = require('../utils/discord');
const { applyPanelCustomization, ensurePanelHeader } = require('./panelEditor');

const buttonStyles = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};
const availableActions = new Set(['give', 'toggle', 'remove']);
const maxJobOptions = 25;

function getTownJobOptions(db) {
  const options = getConfigValue(db, 'TOWN_JOBS_ROLE_OPTIONS');
  return Array.isArray(options) ? options : [];
}

function getTownJobsSettings(db) {
  return {
    title: getConfigValue(db, 'TOWN_JOBS_PANEL_TITLE') ?? 'GV GR | TOWN JOBS',
    description: getConfigValue(db, 'TOWN_JOBS_PANEL_DESCRIPTION')
      ?? 'Choose a Town Job below. Select the same job again to remove it when role toggling is enabled.',
    channelId: getConfigValue(db, 'TOWN_JOBS_PANEL_CHANNEL_ID'),
    messageId: getConfigValue(db, 'TOWN_JOBS_PANEL_MESSAGE_ID'),
    options: getTownJobOptions(db),
  };
}

function validJobOption(job) {
  const validShape = job && typeof job.id === 'string'
    && /^[a-f0-9]{8}$/.test(job.id)
    && typeof job.roleId === 'string'
    && /^\d{17,20}$/.test(job.roleId)
    && typeof job.label === 'string'
    && job.label.trim().length >= 1
    && job.label.length <= 80
    && typeof job.description === 'string'
    && job.description.length <= 200
    && typeof job.emoji === 'string'
    && job.emoji.length <= 100
    && availableActions.has(job.action)
    && Object.hasOwn(buttonStyles, job.style);
  if (!validShape || !job.emoji) return Boolean(validShape);
  try {
    new ButtonBuilder().setEmoji(job.emoji).toJSON();
    return true;
  } catch {
    return false;
  }
}

function jobField(job) {
  const action = job.action === 'toggle'
    ? 'Click again to remove'
    : job.action === 'remove' ? 'Removes this role' : 'Adds this role';
  return {
    name: `${job.emoji ? `${job.emoji} ` : ''}${job.label}`,
    value: `${job.description || 'Select the button below to choose this role.'}\n<@&${job.roleId}> • ${action}`,
    inline: true,
  };
}

function makeJobEmbed(settings) {
  const embed = makeEmbed(config.EMBED_COLORS.management, settings.title, settings.description)
    .setFooter({ text: 'GV GR • Town Jobs' });
  if (!settings.options.length) {
    embed.addFields({ name: 'Available roles', value: 'Town Job options are being configured.' });
  } else {
    embed.addFields(settings.options.slice(0, maxJobOptions).map(jobField));
  }
  return embed;
}

function makeJobComponents(options) {
  const rows = [];
  for (let start = 0; start < options.length; start += 5) {
    const row = new ActionRowBuilder();
    for (const job of options.slice(start, start + 5)) {
      const button = new ButtonBuilder()
        .setCustomId(`gv:townjobs:role:${job.id}`)
        .setLabel(job.label)
        .setStyle(buttonStyles[job.style]);
      if (job.emoji) button.setEmoji(job.emoji);
      row.addComponents(button);
    }
    rows.push(row);
  }
  return rows;
}

function validateJobInput({ label, roleId, description = '', emoji = '', action = 'give', style = 'primary' }) {
  if (!label?.trim() || label.trim().length > 80) return 'Button labels must contain 1–80 characters.';
  if (!validId(roleId)) return 'Choose a valid Discord role.';
  if (description.length > 200) return 'Job descriptions must contain 200 characters or fewer.';
  if (emoji.length > 100) return 'Emoji must contain 100 characters or fewer.';
  if (emoji) {
    try {
      new ButtonBuilder().setEmoji(emoji).toJSON();
    } catch {
      return 'Choose a valid Unicode or custom Discord emoji.';
    }
  }
  if (!availableActions.has(action)) return 'Choose a supported role action.';
  if (!Object.hasOwn(buttonStyles, style)) return 'Choose a supported button color.';
  return null;
}

function validatePanelSettings(settings) {
  if (!settings.title?.trim() || settings.title.length > 256) return 'Panel titles must contain 1–256 characters.';
  if (settings.description.length > 4096) return 'Panel descriptions must contain 4,096 characters or fewer.';
  if (settings.options.length > maxJobOptions) return 'Town Jobs supports up to 25 role buttons.';
  const fieldCharacters = settings.options.reduce((total, job) => {
    const field = jobField(job);
    return total + field.name.length + field.value.length;
  }, 0);
  if (settings.title.length + settings.description.length + fieldCharacters > 6000) {
    return 'The panel text is too long for one Discord embed. Shorten the panel description or job descriptions.';
  }
  return null;
}

async function validateAssignableRole(interaction, roleId) {
  let role;
  try {
    role = await interaction.guild.roles.fetch(roleId);
  } catch {
    return { error: 'That role could not be found in this server.' };
  }
  const botMember = interaction.guild.members.me;
  if (!role || role.managed || !botMember?.permissions.has(PermissionFlagsBits.ManageRoles)
    || !botMember.roles.highest || role.position >= botMember.roles.highest.position) {
    return { error: 'The bot needs Manage Roles, and its highest role must be above the selected Town Job role.' };
  }
  return { role };
}

async function configureTownJobs(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const changes = [];
  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description');
  const channel = interaction.options.getChannel('channel');
  if (title !== null) {
    if (!title.trim()) return interaction.reply({ content: 'Panel title cannot be empty.', ephemeral: true });
    changes.push(['TOWN_JOBS_PANEL_TITLE', title.trim()]);
  }
  if (description !== null) {
    if (!description.trim()) return interaction.reply({ content: 'Panel description cannot be empty.', ephemeral: true });
    changes.push(['TOWN_JOBS_PANEL_DESCRIPTION', description.trim()]);
  }
  if (channel) changes.push(['TOWN_JOBS_PANEL_CHANNEL_ID', channel.id]);
  if (!changes.length) return interaction.reply({ content: 'Provide a panel title, description, or destination channel to update.', ephemeral: true });
  ctx.db.transaction(() => {
    for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
  })();
  return interaction.reply({ content: `Updated Town Jobs panel settings: ${changes.map(([key]) => `**${key}**`).join(', ')}. Run /townjobs panel to publish the changes.`, ephemeral: true });
}

async function addJob(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const options = interaction.options;
  const role = options.getRole('role', true);
  const data = {
    label: options.getString('label', true).trim(),
    roleId: role.id,
    description: options.getString('description')?.trim() ?? '',
    emoji: options.getString('emoji')?.trim() ?? '',
    action: options.getString('action') ?? 'give',
    style: options.getString('style') ?? 'primary',
  };
  const invalid = validateJobInput(data);
  if (invalid) return interaction.reply({ content: invalid, ephemeral: true });
  const assignable = await validateAssignableRole(interaction, role.id);
  if (assignable.error) return interaction.reply({ content: assignable.error, ephemeral: true });
  const current = getTownJobOptions(ctx.db);
  if (current.length >= maxJobOptions) return interaction.reply({ content: 'Town Jobs supports up to 25 role buttons.', ephemeral: true });
  if (current.some((job) => job.roleId === role.id)) return interaction.reply({ content: 'That Discord role is already assigned to a Town Job button. Edit the existing button instead.', ephemeral: true });
  const job = { id: randomUUID().replaceAll('-', '').slice(0, 8), ...data };
  setConfigValue(ctx.db, 'TOWN_JOBS_ROLE_OPTIONS', [...current, job]);
  return interaction.reply({ content: `Added **${job.label}** as Town Job ${job.id}. Run /townjobs panel to publish it.`, ephemeral: true });
}

async function editJob(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const options = interaction.options;
  const jobId = options.getString('id', true);
  const current = getTownJobOptions(ctx.db);
  const index = current.findIndex((job) => job.id === jobId);
  if (index < 0) return interaction.reply({ content: 'That Town Job button ID was not found. Use `/townjobs list`.', ephemeral: true });
  const updated = { ...current[index] };
  const label = options.getString('label');
  const role = options.getRole('role');
  const description = options.getString('description');
  const emoji = options.getString('emoji');
  const action = options.getString('action');
  const style = options.getString('style');
  if (label !== null) updated.label = label.trim();
  if (role) updated.roleId = role.id;
  if (description !== null) updated.description = description.trim();
  if (emoji !== null) updated.emoji = emoji.trim();
  if (action !== null) updated.action = action;
  if (style !== null) updated.style = style;
  const invalid = validateJobInput(updated);
  if (invalid) return interaction.reply({ content: invalid, ephemeral: true });
  if (current.some((job, jobIndex) => jobIndex !== index && job.roleId === updated.roleId)) {
    return interaction.reply({ content: 'That Discord role is already assigned to another Town Job button.', ephemeral: true });
  }
  if (updated.roleId !== current[index].roleId) {
    const assignable = await validateAssignableRole(interaction, updated.roleId);
    if (assignable.error) return interaction.reply({ content: assignable.error, ephemeral: true });
  }
  current[index] = updated;
  setConfigValue(ctx.db, 'TOWN_JOBS_ROLE_OPTIONS', current);
  return interaction.reply({ content: `Updated Town Job ${jobId}. Run /townjobs panel to publish it.`, ephemeral: true });
}

async function removeJob(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const jobId = interaction.options.getString('id', true);
  const current = getTownJobOptions(ctx.db);
  const updated = current.filter((job) => job.id !== jobId);
  if (updated.length === current.length) return interaction.reply({ content: 'That Town Job button ID was not found. Use `/townjobs list`.', ephemeral: true });
  setConfigValue(ctx.db, 'TOWN_JOBS_ROLE_OPTIONS', updated);
  return interaction.reply({ content: `Removed Town Job ${jobId}. Run /townjobs panel to publish the change.`, ephemeral: true });
}

async function listJobs(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const jobs = getTownJobOptions(ctx.db);
  const description = jobs.length
    ? jobs.map((job) => `ID ${job.id} • ${job.emoji ? `${job.emoji} ` : ''}**${job.label}** • <@&${job.roleId}> • ${job.action}${job.description ? `\n${job.description}` : ''}`).join('\n\n')
    : 'No Town Job roles have been configured yet. Use `/townjobs add` to create the first button.';
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, 'Town Jobs Configuration', description.slice(0, 4000))], ephemeral: true });
}

async function publishTownJobsPanel(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const settings = getTownJobsSettings(ctx.db);
  const settingsError = validatePanelSettings(settings);
  if (settingsError) return interaction.reply({ content: settingsError, ephemeral: true });
  const channel = interaction.options.getChannel('channel')
    ?? (validId(settings.channelId) ? await interaction.client.channels.fetch(settings.channelId).catch(() => null) : null);
  if (!channel?.isTextBased() || !channel.send) {
    return interaction.reply({ content: 'Choose a text channel or configure one with `/townjobs configure channel:<channel>`.', ephemeral: true });
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: 'The bot needs View Channel, Send Messages, and Embed Links permissions in the panel channel.', ephemeral: true });
  }
  const roleIds = new Set();
  for (const job of settings.options) {
    if (!validJobOption(job)) return interaction.reply({ content: `Town Job ${job?.id ?? ''} has invalid settings. Edit or remove it before publishing.`, ephemeral: true });
    if (roleIds.has(job.roleId)) return interaction.reply({ content: 'Multiple buttons assign the same Discord role. Remove the duplicate before publishing.', ephemeral: true });
    roleIds.add(job.roleId);
  }
  const customized = applyPanelCustomization(ctx.db, 'townjobs', makeJobEmbed(settings), makeJobComponents(settings.options));
  const payload = {
    embeds: [customized.embed],
    components: customized.components,
    allowedMentions: { parse: [] },
  };
  let message;
  let savedMessageId = settings.messageId;
  const header = await ensurePanelHeader(interaction.client, ctx.db, 'townjobs', channel);
  if (header.created && savedMessageId) {
    try { const previous = await channel.messages.fetch(savedMessageId); if (previous.author?.id === interaction.client.user?.id) await previous.delete(); } catch {}
    setConfigValue(ctx.db, 'TOWN_JOBS_PANEL_MESSAGE_ID', null);
    savedMessageId = null;
  }
  const refreshed = settings.channelId === channel.id && validId(savedMessageId);
  if (refreshed) {
    try {
      const previous = await channel.messages.fetch(savedMessageId);
      message = await previous.edit(payload);
    } catch {
      message = null;
    }
  }
  const didRefresh = Boolean(message);
  if (!message) {
    try {
      message = await channel.send(payload);
    } catch (error) {
      console.error('Could not publish the Town Jobs panel:', error.message);
      return interaction.reply({ content: 'I could not publish the Town Jobs panel. Check the channel permissions and try again.', ephemeral: true });
    }
  }
  let oldPanelRemoved = true;
  if (!didRefresh && validId(settings.channelId) && settings.channelId !== channel.id && validId(settings.messageId)) {
    oldPanelRemoved = false;
    try {
      const oldChannel = await interaction.client.channels.fetch(settings.channelId);
      const oldMessage = oldChannel?.isTextBased() ? await oldChannel.messages.fetch(settings.messageId) : null;
      if (oldMessage?.author?.id === interaction.client.user?.id) {
        await oldMessage.delete();
        oldPanelRemoved = true;
      }
    } catch (error) {
      console.error('Could not remove the previous Town Jobs panel:', error.message);
    }
  }
  setConfigValue(ctx.db, 'TOWN_JOBS_PANEL_CHANNEL_ID', channel.id);
  setConfigValue(ctx.db, 'TOWN_JOBS_PANEL_MESSAGE_ID', message.id);
  const movedWarning = !oldPanelRemoved ? ' The previous panel could not be retired automatically.' : '';
  return interaction.reply({ content: `Town Jobs panel ${didRefresh ? 'updated' : 'published'} in <#${channel.id}>.${movedWarning}`, ephemeral: true });
}

async function handleTownJobsCommand(interaction, ctx) {
  if (interaction.commandName !== 'townjobs') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'configure') return configureTownJobs(interaction, ctx);
  if (action === 'add') return addJob(interaction, ctx);
  if (action === 'edit') return editJob(interaction, ctx);
  if (action === 'remove') return removeJob(interaction, ctx);
  if (action === 'list') return listJobs(interaction, ctx);
  if (action === 'panel') return publishTownJobsPanel(interaction, ctx);
  return interaction.reply({ content: 'That Town Jobs command is not available.', ephemeral: true });
}

async function handleTownJobButton(interaction, ctx) {
  const match = interaction.customId.match(/^gv:townjobs:role:([a-f0-9]{8})$/);
  if (!match) return interaction.reply({ content: 'This Town Job button is not valid.', ephemeral: true });
  const job = getTownJobOptions(ctx.db).find((option) => option.id === match[1]);
  if (!validJobOption(job)) return interaction.reply({ content: 'This Town Job option is no longer available. Ask management to refresh the panel.', ephemeral: true });
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) return interaction.reply({ content: 'I could not find your server member record.', ephemeral: true });
  const assignable = await validateAssignableRole(interaction, job.roleId);
  if (assignable.error) return interaction.reply({ content: assignable.error, ephemeral: true });
  const currentlyHasRole = member.roles.cache.has(job.roleId);
  const shouldRemove = job.action === 'remove' || (job.action === 'toggle' && currentlyHasRole);
  if (job.action === 'give' && currentlyHasRole) {
    return interaction.reply({ content: `You already have the **${job.label}** role.`, ephemeral: true });
  }
  if (job.action === 'remove' && !currentlyHasRole) {
    return interaction.reply({ content: `You do not have the **${job.label}** role to remove.`, ephemeral: true });
  }
  try {
    if (shouldRemove) await member.roles.remove(job.roleId, `Town Jobs panel action: ${job.label}`);
    else await member.roles.add(job.roleId, `Town Jobs panel action: ${job.label}`);
  } catch (error) {
    console.error(`Could not apply Town Job role ${job.roleId}:`, error.message);
    return interaction.reply({ content: `I could not ${shouldRemove ? 'remove' : 'assign'} the **${job.label}** role. Contact management if the issue continues.`, ephemeral: true });
  }
  return interaction.reply({ content: shouldRemove
    ? `Removed the **${job.label}** role.`
    : `Assigned the **${job.label}** role.`, ephemeral: true });
}

module.exports = {
  getTownJobOptions,
  handleTownJobButton,
  handleTownJobsCommand,
  makeJobComponents,
  makeJobEmbed,
  validatePanelSettings,
};