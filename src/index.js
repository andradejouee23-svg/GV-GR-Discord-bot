require('dotenv').config();

const {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} = require('discord.js');
const config = require('../config');
const { getConfigValue } = require('./utils/discord');
const { createDatabase } = require('./database');
const { commands } = require('./commands/definitions');
const { handleButton } = require('./buttons');
const { handleClockCommand } = require('./commands/clock');
const { handleOperationsCommand, submitSessionModal } = require('./commands/operations');
const { handleSafetyCommand, submitReport } = require('./commands/safety');
const { handleStaffCommand } = require('./commands/staff');
const { applyAutomodJoin, applyAutomodMessage } = require('./events/automod');
const {
  handleAnnouncementButton,
  handleAnnouncementCommand,
  handleAnnouncementModal,
  handleAnnouncementSelect,
} = require('./commands/announcements');
const { handleTicketButton, handleTicketModal, handleTicketPanelCommand } = require('./commands/tickets');
const {
  handleOperationButton,
  handleOperationModal,
  handleOperationSelect,
  processEventTasks,
} = require('./commands/events');
const {
  handleStaffCenterCommand,
  handleDailyReportSelect,
  handleDailyReportModal,
  handleShiftReminder,
  processDailyReportReminders,
  processShiftReminders,
  processStaffOfWeek,
  processWeeklyGoalReminders,
} = require('./commands/staffCenter');
const {
  handleManagementButton,
  handleManagementSelect,
  handleManagementShiftActionSelect,
  handleManagementShiftConfirm,
  handleManagementShiftModal,
  handleOwnerActionModal,
  handleOwnerActionSelect,
  handleOwnerButton,
  handleOwnerConfirm,
  handleOwnerCleanupSelect,
  handleOwnerHistorySelect,
  handleOwnerSettingsModal,
  handleOwnerSettingsSelect,
} = require('./commands/staffManagement');

function requireSetup() {
  const missing = [];
  if (!process.env.DISCORD_TOKEN || process.env.DISCORD_TOKEN === 'put_your_bot_token_here') missing.push('DISCORD_TOKEN in .env');
  if (!/^\d{17,20}$/.test(process.env.DISCORD_CLIENT_ID ?? '')) missing.push('DISCORD_CLIENT_ID in .env');
  if (!/^\d{17,20}$/.test(config.SERVER_ID)) missing.push('SERVER_ID in config.js');
  if (missing.length) {
    console.error(`Bot setup is incomplete. Configure: ${missing.join(', ')}.`);
    process.exitCode = 1;
    return false;
  }
  return true;
}

if (requireSetup()) {
  const db = createDatabase(config.DATABASE_PATH);
  const useMessageContent = getConfigValue(db, 'AUTOMOD_ENABLED') === true;
  const runStaffTasks = async () => {
    try {
      await processShiftReminders(client, db);
      await processDailyReportReminders(client, db);
      await processWeeklyGoalReminders(client, db);
      await processStaffOfWeek(client, db);
    } catch (error) {
      console.error('Staff background task failed:', error);
    }
  };
  const runEventTasks = async () => {
    try {
      await processEventTasks(client, db);
    } catch (error) {
      console.error('Event/session background task failed:', error);
    }
  };
  const intents = [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildMessages,
    ];
  if (useMessageContent) intents.push(GatewayIntentBits.MessageContent);
  const client = new Client({
    intents,
    partials: [Partials.Message],
  });
  const context = { client, db, config };
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  let isClosing = false;
  let staffTaskTimer;
  let eventTaskTimer;

  async function closeBot() {
    if (isClosing) return;
    isClosing = true;
    try {
      if (staffTaskTimer) clearInterval(staffTaskTimer);
      if (eventTaskTimer) clearInterval(eventTaskTimer);
      client.destroy();
      db.close();
    } catch (error) {
      console.error('Error while shutting down:', error);
      process.exitCode = 1;
    }
  }

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`${config.BOT_NAME} connected as ${readyClient.user.tag}.`);
    await runStaffTasks();
    await runEventTasks();
    staffTaskTimer = setInterval(runStaffTasks, 15 * 60 * 1000);
    staffTaskTimer.unref();
    eventTaskTimer = setInterval(runEventTasks, 60_000);
    eventTaskTimer.unref();
    try {
      await rest.put(
        Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, config.SERVER_ID),
        { body: commands },
      );
      console.log(`Registered ${commands.length} slash commands in the configured server.`);
    } catch (error) {
      console.error('Could not register slash commands. Check DISCORD_CLIENT_ID, SERVER_ID, and the bot application:', error);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.inGuild()) {
        if (interaction.isRepliable()) {
          await interaction.reply({ content: 'This bot can only be used inside the Greenville RP server.', ephemeral: true });
        }
        return;
      }

      if (interaction.isChatInputCommand()) {
        const handlers = [handleClockCommand, handleStaffCenterCommand, handleStaffCommand, handleAnnouncementCommand, handleTicketPanelCommand, handleOperationsCommand, handleSafetyCommand];
        for (const handler of handlers) {
          const result = await handler(interaction, context);
          if (result !== null && result !== undefined) return;
          if (interaction.replied || interaction.deferred) return;
        }
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'That command is not available.', ephemeral: true });
        }
        return;
      }

      if (interaction.isButton()) {
        if (interaction.customId.startsWith('gv:announce:')) return handleAnnouncementButton(interaction, context);
        if (interaction.customId.startsWith('gv:ticket:')) return handleTicketButton(interaction, context);
        if (interaction.customId.startsWith('mgmt:shift_confirm:') || interaction.customId.startsWith('mgmt:shift_cancel:')) {
          return handleManagementShiftConfirm(interaction, context);
        }
        if (interaction.customId.startsWith('mgmt:')) return handleManagementButton(interaction, context);
        if (interaction.customId.startsWith('owner:confirm:') || interaction.customId.startsWith('owner:cancel:')) {
          return handleOwnerConfirm(interaction, context);
        }
        if (interaction.customId.startsWith('owner:')) return handleOwnerButton(interaction, context);
        if (interaction.customId.startsWith('gv:event:') || interaction.customId.startsWith('gv:rp:')) {
          return handleOperationButton(interaction, context);
        }
        return handleButton(interaction, context);
      }
      if (interaction.isChannelSelectMenu()) {
        if (interaction.customId.startsWith('owner:settings:')) return handleOwnerSettingsSelect(interaction, context);
        if (interaction.customId.startsWith('gv:event:channel:') || interaction.customId.startsWith('gv:rp:channel:')) {
          return handleOperationSelect(interaction, context);
        }
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('gv:daily:rating:')) {
        return handleDailyReportSelect(interaction, context);
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('gv:announce:')) {
        return handleAnnouncementSelect(interaction, context);
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('owner:action:')) {
        return handleOwnerActionSelect(interaction, context);
      }
      if (interaction.isStringSelectMenu() && interaction.customId === 'owner:cleanup:category') {
        return handleOwnerCleanupSelect(interaction, context);
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('owner:settings:')) {
        return handleOwnerSettingsSelect(interaction, context);
      }
      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mgmt:shift_action:')) {
        return handleManagementShiftActionSelect(interaction, context);
      }
      if (interaction.isUserSelectMenu()) {
        if (interaction.customId.startsWith('gv:event:host_select:')) return handleOperationSelect(interaction, context);
        if (interaction.customId === 'mgmt:staff_history') return handleManagementSelect(interaction, context);
        if (interaction.customId === 'owner:select_staff') return handleOwnerHistorySelect(interaction, context);
      }
      if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('owner:settings:')) {
        return handleOwnerSettingsSelect(interaction, context);
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('gv:announce:')) return handleAnnouncementModal(interaction, context);
        if (interaction.customId.startsWith('gv:ticket:')) return handleTicketModal(interaction, context);
        if (interaction.customId.startsWith('owner:automod:')) return handleOwnerSettingsModal(interaction, context);
        if (interaction.customId === 'owner:settings:timezone_modal') return handleOwnerSettingsModal(interaction, context);
        if (interaction.customId.startsWith('owner:settings:session_modal:')) return handleOwnerSettingsModal(interaction, context);
        if (interaction.customId.startsWith('gv:event:') || interaction.customId.startsWith('gv:rp:create:')) {
          return handleOperationModal(interaction, context);
        }
        if (interaction.customId === 'gv:report_submit') return submitReport(interaction, context);
        if (interaction.customId.startsWith('gv:daily:submit:')) return handleDailyReportModal(interaction, context);
        if (interaction.customId.startsWith('gv:session_start:')) return submitSessionModal(interaction, context);
        if (interaction.customId.startsWith('owner:modal:')) return handleOwnerActionModal(interaction, context);
        if (interaction.customId.startsWith('mgmt:shift_modal:')) return handleManagementShiftModal(interaction, context);
      }
    } catch (error) {
      console.error('Interaction failed:', error);
      if (!interaction.isRepliable() || interaction.replied || interaction.deferred) {
        if (interaction.isRepliable() && (interaction.replied || interaction.deferred)) {
          await interaction.followUp({ content: 'Something went wrong while handling that request. The error has been logged.', ephemeral: true }).catch(() => {});
        }
        return;
      }
      await interaction.reply({ content: 'Something went wrong while handling that request. The error has been logged.', ephemeral: true }).catch(() => {});
    }
  });

  client.on(Events.Error, (error) => console.error('Discord client error:', error));
  client.on(Events.Warn, (message) => console.warn('Discord.js warning:', message));
  client.on(Events.MessageCreate, async (message) => {
    try { await applyAutomodMessage(message, client, db); }
    catch (error) { console.error('AutoMod message handling failed:', error); }
  });
  client.on(Events.GuildMemberAdd, async (member) => {
    try { await applyAutomodJoin(member, client, db); }
    catch (error) { console.error('AutoMod join monitoring failed:', error); }
  });
  process.on('SIGINT', closeBot);
  process.on('SIGTERM', closeBot);
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    process.exitCode = 1;
    closeBot();
  });
  process.on('unhandledRejection', (error) => console.error('Unhandled promise rejection:', error));

  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('Could not log in. Verify DISCORD_TOKEN and check the Discord Developer Portal:', error.message);
    process.exitCode = 1;
    closeBot();
  });
}