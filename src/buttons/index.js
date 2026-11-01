const { handleClockButton } = require('../commands/clock');
const { handleSessionJoin } = require('../commands/operations');
const { handleSessionPanelButton } = require('../commands/operations');
const { handleAnnouncementManagerInteraction } = require('../commands/announcementManager');
const { handleVehicleButton } = require('../commands/vehicles');
const { handleTempAdminButton } = require('../commands/tempAdmin');
const { handleTownJobButton } = require('../commands/townJobs');
const { handleEconomyButton } = require('../commands/economy');
const { handleBlacklistButton } = require('../commands/blacklist');
const { updateReport } = require('../commands/safety');
const { handleStaffCenterButton, handleShiftReminder } = require('../commands/staffCenter');

async function handleButton(interaction, ctx) {
  if (interaction.customId.startsWith('gv:blacklist:')) {
    return handleBlacklistButton(interaction, ctx);
  }
  if (interaction.customId.startsWith('gv:economy:')) {
    return handleEconomyButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:session_panel:')) {
    return handleSessionPanelButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:townjobs:')) {
    return handleTownJobButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:tempadmin:')) {
    return handleTempAdminButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:vehicle:')) {
    return handleVehicleButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:ann:')) {
    return handleAnnouncementManagerInteraction(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:center:')) {
    return handleStaffCenterButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:shiftrem:')) {
    return handleShiftReminder(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:clock_')
    || interaction.customId === 'gv:status'
    || interaction.customId === 'gv:activity') {
    return handleClockButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:session_join:')) {
    const sessionId = Number(interaction.customId.split(':').at(-1));
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) {
      return interaction.reply({ content: 'That session button is invalid.', ephemeral: true });
    }
    return handleSessionJoin(interaction, ctx, sessionId);
  }

  if (interaction.customId.startsWith('gv:report:')) return updateReport(interaction, ctx);
  return interaction.reply({ content: 'This button is not recognized. Run `/staff-panel` for a current panel.', ephemeral: true });
}

module.exports = { handleButton };