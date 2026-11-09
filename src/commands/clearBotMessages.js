const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const { ensureManagement } = require('./staff');
const { makeEmbed } = require('../utils/discord');

const confirmationLifetimeMs = 2 * 60_000;
const pendingClears = new Map();
const bulkDeleteAgeMs = 14 * 24 * 60 * 60 * 1000;
const protectedTerms = ['BLACKLIST', 'APPEAL', 'APPLICATION', 'ECONOMY', 'SALARY', 'VEHICLE', 'REGISTRATION', 'TRANSACTION', 'CASH DROP', 'SESSION'];

function isProtectedMessage(message) {
  const content = [message.content, ...(message.embeds ?? []).flatMap((embed) => [
    embed.title,
    embed.description,
    embed.footer?.text,
    ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
  ])].filter(Boolean).join('\n').toUpperCase();
  return protectedTerms.some((term) => content.includes(term));
}

function cleanupConfirmationRow(requestId, all = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:clear-bots:confirm:${requestId}`).setLabel(all ? 'Delete All Bot Messages' : 'Confirm Clear').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gv:clear-bots:cancel:${requestId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

function createClearRequest(interaction, channel, { all = false, limit = null } = {}) {
  const requestId = randomUUID().replaceAll('-', '');
  pendingClears.set(requestId, {
    actorId: interaction.user.id,
    guildId: interaction.guild.id,
    channelId: channel.id,
    all,
    limit,
    expiresAt: Date.now() + confirmationLifetimeMs,
  });
  return requestId;
}

async function openCleanupChannelPicker(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  return interaction.reply({
    content: 'Choose one channel. The cleanup will remove every message authored by this bot in that channel; player and other-bot messages will remain.',
    components: [new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder()
      .setCustomId('mgmt:clear-bots:channel')
      .setPlaceholder('Select a channel to clean')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))],
    ephemeral: true,
  });
}

async function handleClearBotMessagesSelect(interaction, ctx) {
  if (interaction.customId !== 'mgmt:clear-bots:channel') return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const channelId = interaction.values[0];
  const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
  if (!channel || channel.guildId !== interaction.guild.id || !channel.isTextBased() || !channel.messages?.fetch) {
    return interaction.reply({ content: 'Choose a text channel in this server.', ephemeral: true });
  }
  const requestId = createClearRequest(interaction, channel, { all: true });
  return interaction.update({
    content: '',
    embeds: [makeEmbed(0xe04b4b, 'Confirm Full Bot Message Cleanup',
      `Scan the entire history of <#${channel.id}> and delete every message authored by this bot, including pinned messages, panels, and record announcements. Player messages and messages from other bots are never deleted. This cannot be undone.`)],
    components: [cleanupConfirmationRow(requestId, true)],
  });
}

async function handleClearBotMessagesCommand(interaction, ctx) {
  if (interaction.commandName !== 'clear-bot-messages') return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const channel = interaction.options.getChannel('channel', true);
  const limit = interaction.options.getInteger('amount', true);
  if (channel.guildId !== interaction.guild.id || !channel.isTextBased() || !channel.messages?.fetch) {
    return interaction.reply({ content: 'Choose a text channel in this server.', ephemeral: true });
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return interaction.reply({ content: 'Choose between 1 and 100 recent messages to inspect.', ephemeral: true });
  }
  const requestId = createClearRequest(interaction, channel, { limit });
  return interaction.reply({
    embeds: [makeEmbed(0xe04b4b, 'Confirm Bot Message Cleanup',
      `Inspect the latest **${limit}** messages in <#${channel.id}> and remove only this bot's non-record messages. Player messages and protected record announcements will be kept. Messages older than 14 days are deleted individually.`)],
    components: [cleanupConfirmationRow(requestId)],
    ephemeral: true,
  });
}

async function handleClearBotMessagesButton(interaction, ctx) {
  const match = interaction.customId.match(/^gv:clear-bots:(confirm|cancel):([a-f0-9]{32})$/);
  if (!match) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const [, action, requestId] = match;
  const request = pendingClears.get(requestId);
  if (!request || request.expiresAt <= Date.now()) {
    pendingClears.delete(requestId);
    return interaction.update({ content: 'This cleanup confirmation expired. Run `/clear-bot-messages` again.', embeds: [], components: [] });
  }
  if (request.actorId !== interaction.user.id || request.guildId !== interaction.guild.id) {
    return interaction.reply({ content: 'Only the manager who requested this cleanup can confirm it.', ephemeral: true });
  }
  pendingClears.delete(requestId);
  if (action === 'cancel') {
    return interaction.update({ content: 'Bot message cleanup cancelled. No messages were deleted.', embeds: [], components: [] });
  }
  const channel = await interaction.client.channels.fetch(request.channelId).catch(() => null);
  if (!channel || channel.guildId !== interaction.guild.id || !channel.isTextBased()) {
    return interaction.update({ content: 'The selected channel is unavailable. No messages were deleted.', embeds: [], components: [] });
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.ReadMessageHistory)
    || !permissions.has(PermissionFlagsBits.ManageMessages)) {
    return interaction.update({ content: 'The bot needs View Channel, Read Message History, and Manage Messages in that channel. No messages were deleted.', embeds: [], components: [] });
  }
  if (request.all) await interaction.deferUpdate();
  let fetched;
  try {
    fetched = request.all ? null : await channel.messages.fetch({ limit: request.limit });
  } catch (error) {
    console.error('Could not inspect bot messages for cleanup:', error.message);
    return interaction.update({ content: 'Messages could not be inspected. No messages were deleted.', embeds: [], components: [] });
  }
  let deleted = 0;
  let remaining = request.all;
  let before;
  while (remaining) {
    let page;
    try { page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }); }
    catch (error) {
      console.error('Could not continue full bot message cleanup:', error.message);
      break;
    }
    if (!page.size) break;
    const messages = [...page.values()];
    before = messages.at(-1)?.id;
    const candidates = page.filter((message) => message.author?.id === interaction.client.user?.id
      && (request.all || (!message.pinned && !isProtectedMessage(message))));
    const recent = candidates.filter((message) => Date.now() - message.createdTimestamp < bulkDeleteAgeMs);
    const old = candidates.filter((message) => Date.now() - message.createdTimestamp >= bulkDeleteAgeMs);
    const bulkRecent = recent.filter((message) => !message.pinned);
    const individual = new Map([...old, ...recent.filter((message) => message.pinned)]);
    if (bulkRecent.size) {
      try { deleted += (await channel.bulkDelete(bulkRecent, true)).size; }
      catch (error) { console.error('Could not bulk-delete recent bot messages:', error.message); }
    }
    for (const message of individual.values()) {
      try { await message.delete(); deleted += 1; }
      catch (error) { console.error(`Could not delete old bot message ${message.id}:`, error.message); }
    }
    remaining = request.all && page.size === 100;
  }
  if (!request.all) {
    const candidates = fetched.filter((message) => message.author?.id === interaction.client.user?.id
      && !message.pinned && !isProtectedMessage(message));
    const recent = candidates.filter((message) => Date.now() - message.createdTimestamp < bulkDeleteAgeMs);
    const old = candidates.filter((message) => Date.now() - message.createdTimestamp >= bulkDeleteAgeMs);
    if (recent.size) {
      try { deleted += (await channel.bulkDelete(recent, true)).size; }
      catch (error) { console.error('Could not bulk-delete recent bot messages:', error.message); }
    }
    for (const message of old.values()) {
      try { await message.delete(); deleted += 1; }
      catch (error) { console.error(`Could not delete old bot message ${message.id}:`, error.message); }
    }
  }
  const result = {
    content: `Removed **${deleted}** bot message${deleted === 1 ? '' : 's'} from <#${channel.id}>. ${request.all ? 'Player and other-bot messages were not touched.' : 'Player messages, pinned messages, and protected records were kept.'}`,
    embeds: [],
    components: [],
  };
  return request.all ? interaction.followUp({ ...result, ephemeral: true }) : interaction.update(result);
}

module.exports = { handleClearBotMessagesButton, handleClearBotMessagesCommand, handleClearBotMessagesSelect, isProtectedMessage, openCleanupChannelPicker };