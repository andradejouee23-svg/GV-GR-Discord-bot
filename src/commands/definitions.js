const {
  ChannelType,
  SlashCommandBuilder,
} = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('staff-panel')
    .setDescription('Post or refresh the GV GR staff duty panel.'),
  new SlashCommandBuilder()
    .setName('staff-center')
    .setDescription('Open your private GV GR Staff Center.'),
  new SlashCommandBuilder()
    .setName('management-dashboard')
    .setDescription('Open the private staff management dashboard.'),
  new SlashCommandBuilder()
    .setName('owner-dashboard')
    .setDescription('Open the private owner control dashboard.'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View staff hours ranked on the leaderboard.')
    .addStringOption((option) => option.setName('period').setDescription('Hours to compare').setRequired(true)
      .addChoices(
        { name: 'This week', value: 'weekly' },
        { name: 'This month', value: 'monthly' },
        { name: 'All time', value: 'alltime' },
      )),
  new SlashCommandBuilder()
    .setName('session')
    .setDescription('Manage Greenville RP staff sessions.')
    .addSubcommand((subcommand) => subcommand.setName('start').setDescription('Start an RP session.')
      .addUserOption((option) => option.setName('host').setDescription('Staff member hosting the session').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('end').setDescription('End the active RP session.'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('View the active RP session.')),
  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Create and manage staff events.')
    .addSubcommand((subcommand) => subcommand.setName('create').setDescription('Schedule an event.')
      .addStringOption((option) => option.setName('name').setDescription('Event name').setRequired(true).setMaxLength(100))
      .addStringOption((option) => option.setName('datetime').setDescription('Date/time with a timezone, e.g. 2026-10-04T18:00:00Z').setRequired(true).setMaxLength(50))
      .addStringOption((option) => option.setName('description').setDescription('Event details').setMaxLength(1000)))
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List upcoming events.'))
    .addSubcommand((subcommand) => subcommand.setName('cancel').setDescription('Cancel an event.')
      .addIntegerOption((option) => option.setName('id').setDescription('Event number').setRequired(true).setMinValue(1))),
  new SlashCommandBuilder()
    .setName('staffwarn')
    .setDescription('Record a staff warning.')
    .addUserOption((option) => option.setName('member').setDescription('Staff member').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the warning').setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder()
    .setName('staffnotes')
    .setDescription('Add or view private staff notes.')
    .addSubcommand((subcommand) => subcommand.setName('add').setDescription('Add a staff note.')
      .addUserOption((option) => option.setName('member').setDescription('Staff member').setRequired(true))
      .addStringOption((option) => option.setName('note').setDescription('Private note').setRequired(true).setMaxLength(1000)))
    .addSubcommand((subcommand) => subcommand.setName('view').setDescription('View staff notes.')
      .addUserOption((option) => option.setName('member').setDescription('Staff member').setRequired(true))),
  new SlashCommandBuilder()
    .setName('staffhistory')
    .setDescription('View warnings, notes, and shift history for a staff member.')
    .addUserOption((option) => option.setName('member').setDescription('Staff member').setRequired(true)),
  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Submit a private player report to staff.'),
  new SlashCommandBuilder()
    .setName('staffannounce')
    .setDescription('Send an announcement to the staff channel.')
    .addStringOption((option) => option.setName('title').setDescription('Announcement title').setRequired(true).setMaxLength(200))
    .addStringOption((option) => option.setName('message').setDescription('Announcement').setRequired(true).setMaxLength(3000)),
  new SlashCommandBuilder()
    .setName('announcement-builder')
    .setDescription('Create, edit, and reuse management announcements.')
    .addSubcommand((subcommand) => subcommand.setName('create').setDescription('Build and preview an announcement.'))
    .addSubcommand((subcommand) => subcommand.setName('edit').setDescription('Edit a bot-published announcement.'))
    .addSubcommand((subcommand) => subcommand.setName('templates').setDescription('Create an announcement from a saved template.')),
  new SlashCommandBuilder()
    .setName('ticket-panel')
    .setDescription('Post or refresh the private ticket creation panel.')
    .addChannelOption((option) => option.setName('channel').setDescription('Public channel for the ticket panel').setRequired(true).addChannelTypes(ChannelType.GuildText)),
  new SlashCommandBuilder()
    .setName('mod')
    .setDescription('Record or perform a player moderation action.')
    .addSubcommand((subcommand) => subcommand.setName('warn').setDescription('Record a player warning.')
      .addUserOption((option) => option.setName('member').setDescription('Player').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(1000)))
    .addSubcommand((subcommand) => subcommand.setName('kick').setDescription('Kick a player.')
      .addUserOption((option) => option.setName('member').setDescription('Player').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(1000)))
    .addSubcommand((subcommand) => subcommand.setName('ban').setDescription('Ban a player.')
      .addUserOption((option) => option.setName('member').setDescription('Player').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(1000)))
    .addSubcommand((subcommand) => subcommand.setName('timeout').setDescription('Timeout a player.')
      .addUserOption((option) => option.setName('member').setDescription('Player').setRequired(true))
      .addIntegerOption((option) => option.setName('minutes').setDescription('Timeout length in minutes').setRequired(true).setMinValue(1).setMaxValue(40320))
      .addStringOption((option) => option.setName('reason').setDescription('Reason').setRequired(true).setMaxLength(1000))),
  new SlashCommandBuilder()
    .setName('staffconfig')
    .setDescription('Configure bot channels and staff roles.')
    .addSubcommand((subcommand) => subcommand.setName('channel').setDescription('Set a bot channel.')
      .addStringOption((option) => option.setName('setting').setDescription('Channel setting').setRequired(true)
        .addChoices(
          { name: 'Staff activity and panel', value: 'STAFF_ACTIVITY_CHANNEL_ID' },
          { name: 'Staff announcements', value: 'STAFF_ANNOUNCEMENT_CHANNEL_ID' },
          { name: 'Staff log', value: 'STAFF_LOG_CHANNEL_ID' },
          { name: 'Private reports', value: 'REPORT_CHANNEL_ID' },
          { name: 'RP sessions', value: 'SESSION_CHANNEL_ID' },
          { name: 'Events', value: 'EVENT_CHANNEL_ID' },
        ))
      .addChannelOption((option) => option.setName('channel').setDescription('Text channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((subcommand) => subcommand.setName('role').setDescription('Add or remove a configured role.')
      .addStringOption((option) => option.setName('group').setDescription('Role group').setRequired(true)
        .addChoices(
          { name: 'Staff', value: 'staff' },
          { name: 'Management', value: 'management' },
          { name: 'Owners', value: 'owners' },
        ))
      .addStringOption((option) => option.setName('action').setDescription('Add or remove this role').setRequired(true)
        .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }))
      .addRoleOption((option) => option.setName('role').setDescription('Role to update').setRequired(true))),
].map((command) => command.toJSON());

module.exports = { commands };