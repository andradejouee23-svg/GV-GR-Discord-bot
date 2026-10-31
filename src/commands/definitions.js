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
          { name: 'Vehicle registration panel', value: 'VEHICLE_REGISTRATION_CHANNEL_ID' },
          { name: 'Vehicle application review', value: 'VEHICLE_REVIEW_CHANNEL_ID' },
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
  new SlashCommandBuilder()
    .setName('vehicle')
    .setDescription('Register and manage GV GR roleplay vehicles.')
    .addSubcommand((subcommand) => subcommand.setName('panel').setDescription('Post or refresh the vehicle registration panel.'))
    .addSubcommand((subcommand) => subcommand.setName('mine').setDescription('View your active registered vehicles.'))
    .addSubcommand((subcommand) => subcommand.setName('search').setDescription('Search vehicle registrations by plate (management).')
      .addStringOption((option) => option.setName('plate').setDescription('License plate to search for').setRequired(true).setMaxLength(16)))
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('View a player’s active registered vehicles (management).')
      .addUserOption((option) => option.setName('member').setDescription('Player').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('history').setDescription('View a player’s registration history (management).')
      .addUserOption((option) => option.setName('member').setDescription('Player').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('update').setDescription('Update an approved vehicle registration (management).')
      .addIntegerOption((option) => option.setName('id').setDescription('Application ID').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('roblox').setDescription('Roblox username').setMaxLength(20))
      .addStringOption((option) => option.setName('vehicle').setDescription('Vehicle make and model').setMaxLength(100))
      .addStringOption((option) => option.setName('plate').setDescription('License plate').setMaxLength(16))
      .addStringOption((option) => option.setName('state').setDescription('Registration state').setMaxLength(32))
      .addStringOption((option) => option.setName('color').setDescription('Vehicle color').setMaxLength(40))
      .addIntegerOption((option) => option.setName('year').setDescription('Vehicle year').setMinValue(1900).setMaxValue(2100))
      .addStringOption((option) => option.setName('image-url').setDescription('HTTPS vehicle picture URL').setMaxLength(500))
      .addBooleanOption((option) => option.setName('remove-image').setDescription('Remove the current vehicle picture')))
    .addSubcommand((subcommand) => subcommand.setName('revoke').setDescription('Revoke an approved registration (management).')
      .addIntegerOption((option) => option.setName('id').setDescription('Application ID').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('Reason for revocation').setRequired(true).setMaxLength(500)))
    .addSubcommand((subcommand) => subcommand.setName('expiration').setDescription('Set or clear a registration expiration (management).')
      .addIntegerOption((option) => option.setName('id').setDescription('Application ID').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('expires-at').setDescription('Future ISO date/time; omit to clear').setMaxLength(40))),
  new SlashCommandBuilder()
    .setName('tempadmin')
    .setDescription('Apply for or manage temporary administration applications.')
    .addSubcommand((subcommand) => subcommand.setName('panel').setDescription('Post or refresh the application panel.')
      .addChannelOption((option) => option.setName('channel').setDescription('Public application channel').setRequired(true).addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((subcommand) => subcommand.setName('configure').setDescription('Configure the application form and temporary role (management).')
      .addStringOption((option) => option.setName('title').setDescription('Application panel title').setMaxLength(256))
      .addStringOption((option) => option.setName('description').setDescription('Application instructions').setMaxLength(4000))
      .addRoleOption((option) => option.setName('role').setDescription('Role assigned when approved'))
      .addChannelOption((option) => option.setName('review-channel').setDescription('Private staff review channel').addChannelTypes(ChannelType.GuildText))
      .addIntegerOption((option) => option.setName('duration-hours').setDescription('Temporary role duration in hours').setMinValue(1).setMaxValue(8760))
      .addStringOption((option) => option.setName('question-1').setDescription('First application question').setMaxLength(45))
      .addStringOption((option) => option.setName('question-2').setDescription('Second application question').setMaxLength(45))
      .addStringOption((option) => option.setName('question-3').setDescription('Third application question').setMaxLength(45))
      .addStringOption((option) => option.setName('question-4').setDescription('Fourth application question').setMaxLength(45))
      .addStringOption((option) => option.setName('question-5').setDescription('Fifth application question').setMaxLength(45)))
    .addSubcommand((subcommand) => subcommand.setName('history').setDescription('View your application history, or a player’s history (management).')
      .addUserOption((option) => option.setName('member').setDescription('Player; management only'))),
  new SlashCommandBuilder()
    .setName('townjobs')
    .setDescription('Configure the GV GR Town Jobs role panel.')
    .addSubcommand((subcommand) => subcommand.setName('configure').setDescription('Set the panel title, description, or destination channel.')
      .addStringOption((option) => option.setName('title').setDescription('Panel title').setMaxLength(256))
      .addStringOption((option) => option.setName('description').setDescription('Panel instructions').setMaxLength(4000))
      .addChannelOption((option) => option.setName('channel').setDescription('Panel destination channel').addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((subcommand) => subcommand.setName('add').setDescription('Add a configurable job role button.')
      .addStringOption((option) => option.setName('label').setDescription('Button label').setRequired(true).setMaxLength(80))
      .addRoleOption((option) => option.setName('role').setDescription('Discord role to assign').setRequired(true))
      .addStringOption((option) => option.setName('description').setDescription('Job description').setMaxLength(200))
      .addStringOption((option) => option.setName('emoji').setDescription('Button emoji').setMaxLength(100))
      .addStringOption((option) => option.setName('action').setDescription('Role behavior').addChoices(
        { name: 'Give role', value: 'give' },
        { name: 'Give or remove on repeat click', value: 'toggle' },
        { name: 'Remove role', value: 'remove' },
      ))
      .addStringOption((option) => option.setName('style').setDescription('Button color').addChoices(
        { name: 'Blue', value: 'primary' },
        { name: 'Gray', value: 'secondary' },
        { name: 'Green', value: 'success' },
        { name: 'Red', value: 'danger' },
      )))
    .addSubcommand((subcommand) => subcommand.setName('edit').setDescription('Edit a configured job button.')
      .addStringOption((option) => option.setName('id').setDescription('Job button ID from /townjobs list').setRequired(true).setMaxLength(12))
      .addStringOption((option) => option.setName('label').setDescription('New button label').setMaxLength(80))
      .addRoleOption((option) => option.setName('role').setDescription('New Discord role'))
      .addStringOption((option) => option.setName('description').setDescription('New job description').setMaxLength(200))
      .addStringOption((option) => option.setName('emoji').setDescription('New button emoji').setMaxLength(100))
      .addStringOption((option) => option.setName('action').setDescription('New role behavior').addChoices(
        { name: 'Give role', value: 'give' },
        { name: 'Give or remove on repeat click', value: 'toggle' },
        { name: 'Remove role', value: 'remove' },
      ))
      .addStringOption((option) => option.setName('style').setDescription('New button color').addChoices(
        { name: 'Blue', value: 'primary' },
        { name: 'Gray', value: 'secondary' },
        { name: 'Green', value: 'success' },
        { name: 'Red', value: 'danger' },
      )))
    .addSubcommand((subcommand) => subcommand.setName('remove').setDescription('Remove a job button.')
      .addStringOption((option) => option.setName('id').setDescription('Job button ID from /townjobs list').setRequired(true).setMaxLength(12)))
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('List configured job buttons.'))
    .addSubcommand((subcommand) => subcommand.setName('panel').setDescription('Publish or update the Town Jobs panel.')
      .addChannelOption((option) => option.setName('channel').setDescription('Override the configured panel channel').addChannelTypes(ChannelType.GuildText))),
].map((command) => command.toJSON());

module.exports = { commands };