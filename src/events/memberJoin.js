const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../../config');
const { getConfigValue, makeEmbed, validId } = require('../utils/discord');

function buildWelcomeEmbed(member) {
  return makeEmbed(config.EMBED_COLORS.active, 'WELCOME TO GV GR!',
    `Welcome to **${member.guild.name}**, <@${member.id}>! We are glad you are here.\n\nUse the buttons below to learn how to join Greenville and review the server rules.`)
    .setThumbnail(member.user.displayAvatarURL({ extension: 'png', size: 256 }))
    .setFooter({ text: `${member.guild.name} • Member ${member.guild.memberCount}` });
}

function buildWelcomeComponents(guildId, howToJoinChannelId, rulesChannelId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('How to Join')
      .setEmoji('📘')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${howToJoinChannelId}`),
    new ButtonBuilder()
      .setLabel('Server Rules')
      .setEmoji('📜')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${guildId}/${rulesChannelId}`),
  )];
}

async function welcomeNewMember(member, db, client) {
  if (member.guild.id !== config.SERVER_ID) return null;
  const channelId = getConfigValue(db, 'WELCOME_CHANNEL_ID');
  const howToJoinChannelId = getConfigValue(db, 'HOW_TO_JOIN_CHANNEL_ID');
  const rulesChannelId = getConfigValue(db, 'SERVER_RULES_CHANNEL_ID');
  if (![channelId, howToJoinChannelId, rulesChannelId].every(validId)) {
    console.warn('Welcome message skipped: configure welcome, how-to-join, and server-rules channels with /staffconfig channel.');
    return null;
  }

  let welcomeChannel;
  let howToJoinChannel;
  let rulesChannel;
  try {
    [welcomeChannel, howToJoinChannel, rulesChannel] = await Promise.all([
      client.channels.fetch(channelId),
      member.guild.channels.fetch(howToJoinChannelId),
      member.guild.channels.fetch(rulesChannelId),
    ]);
  } catch (error) {
    console.error('Could not fetch a configured welcome channel:', error.message);
    return null;
  }
  if (welcomeChannel?.guildId !== member.guild.id || !welcomeChannel.isTextBased() || !welcomeChannel.send
    || !howToJoinChannel?.isTextBased() || !rulesChannel?.isTextBased()) {
    console.error('Welcome message skipped: configured welcome, how-to-join, and rules channels must be text channels in this server.');
    return null;
  }
  const botMember = member.guild.members.me;
  const permissions = welcomeChannel.permissionsFor(botMember);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    console.error('Welcome message skipped: the bot needs View Channel, Send Messages, and Embed Links in the welcome channel.');
    return null;
  }

  return welcomeChannel.send({
    embeds: [buildWelcomeEmbed(member)],
    components: buildWelcomeComponents(member.guild.id, howToJoinChannelId, rulesChannelId),
    allowedMentions: { users: [member.id] },
  });
}

module.exports = {
  buildWelcomeComponents,
  buildWelcomeEmbed,
  welcomeNewMember,
};