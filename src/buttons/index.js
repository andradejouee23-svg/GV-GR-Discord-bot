const { handleClockButton } = require('../commands/clock');
const { handleSessionJoin } = require('../commands/operations');
const { updateReport } = require('../commands/safety');
const { handleDailyReportReminder, handleStaffCenterButton, handleShiftReminder } = require('../commands/staffCenter');
const { handleOperationButton } = require('../commands/events');

async function handleButton(interaction, ctx) {
  if (interaction.customId.startsWith('gv:event:') || interaction.customId.startsWith('gv:rp:')) {
    return handleOperationButton(interaction, ctx);
  }

  if (interaction.customId.startsWith('gv:daily:remind:')) {
    return handleDailyReportReminder(interaction, ctx);
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