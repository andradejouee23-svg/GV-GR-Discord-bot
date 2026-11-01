const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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

function cleanupConfirmationRow(requestId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:clear-bots:confirm:${requestId}`).setLabel('Confirm Clear').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`gv:clear-bots:cancel:${requestId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
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
  const requestId = randomUUID().replaceAll('-', '');
  pendingClears.set(requestId, {
    actorId: interaction.user.id,
    guildId: interaction.guild.id,
    channelId: channel.id,
    limit,
    expiresAt: Date.now() + confirmationLifetimeMs,
  });
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
  let fetched;
  try {
    fetched = await channel.messages.fetch({ limit: request.limit });
  } catch (error) {
    console.error('Could not inspect bot messages for cleanup:', error.message);
    return interaction.update({ content: 'Messages could not be inspected. No messages were deleted.', embeds: [], components: [] });
  }
  const candidates = fetched.filter((message) => message.author?.id === interaction.client.user?.id
    && !message.pinned && !isProtectedMessage(message));
  const recent = candidates.filter((message) => Date.now() - message.createdTimestamp < bulkDeleteAgeMs);
  const old = candidates.filter((message) => Date.now() - message.createdTimestamp >= bulkDeleteAgeMs);
  let deleted = 0;
  if (recent.size) {
    try { deleted += (await channel.bulkDelete(recent, true)).size; }
    catch (error) { console.error('Could not bulk-delete recent bot messages:', error.message); }
  }
  for (const message of old.values()) {
    try { await message.delete(); deleted += 1; }
    catch (error) { console.error(`Could not delete old bot message ${message.id}:`, error.message); }
  }
  return interaction.update({
    content: `Removed **${deleted}** bot message${deleted === 1 ? '' : 's'} from <#${channel.id}>. Player messages, pinned messages, and protected records were kept.`,
    embeds: [],
    components: [],
  });
}

module.exports = { handleClearBotMessagesButton, handleClearBotMessagesCommand, isProtectedMessage };