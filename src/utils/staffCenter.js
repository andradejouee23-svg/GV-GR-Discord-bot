const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('../../config');
const { getPointsLeaderboard, getStaffStats, getWeekStart } = require('../services/staffRewards');
const { formatDuration } = require('./format');
const { makeEmbed, unixTime } = require('./discord');

function createStaffCenterComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:center:checkin').setLabel('Check In').setEmoji('🟢').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:center:checkout').setLabel('Check Out').setEmoji('🔴').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('gv:center:stats').setLabel('My Stats').setEmoji('📊').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gv:center:leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:center:weekly').setLabel('Weekly Goal').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:center:streak').setLabel('My Streak').setEmoji('🔥').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function createCheckoutReply(db, shift) {
  const stats = getStaffStats(db, shift.user_id, new Date(shift.ended_at));
  const embed = makeEmbed(config.EMBED_COLORS.active, '✅ SHIFT COMPLETE',
    `⏱️ **Shift:** ${formatDuration(shift.duration_seconds)}\n⭐ **Hourly Points:** +${shift.hourly_points}\n⭐ **Current Points:** ${stats.totalPoints}`);
  return {
    embeds: [embed],
    components: [],
  };
}

function createStaffStatsEmbed(db, userId, username, now = new Date()) {
  const stats = getStaffStats(db, userId, now);
  return makeEmbed(config.EMBED_COLORS.info, `GV GR Staff Center • ${username}`,
    `⭐ **Points:** ${stats.totalPoints}\n🔥 **Streak:** ${stats.currentStreak} day${stats.currentStreak === 1 ? '' : 's'}\n⏱️ **Current Shift:** ${stats.activeShift ? formatDuration(stats.activeShift.durationSeconds) : 'Not checked in'}`)
    .addFields(
      { name: 'Total Hours', value: formatDuration(stats.totalSeconds), inline: true },
      { name: 'Completed Shifts', value: String(stats.completedShifts), inline: true },
      { name: 'This Week', value: `${(stats.weeklySeconds / 3600).toFixed(1)} / ${stats.weeklyGoalHours} hours`, inline: true },
      { name: 'Weekly Points', value: String(stats.weeklyPoints), inline: true },
    )
    .setTimestamp(now);
}

function createPermanentLeaderboardEmbed(db) {
  const rows = getPointsLeaderboard(db);
  const medals = ['🥇', '🥈', '🥉'];
  const description = rows.length
    ? rows.map((entry, index) => `${medals[index] ?? `${index + 1}.`} <@${entry.user_id}> • **${entry.points} ⭐**`).join('\n')
    : 'No Staff Points have been earned yet.';
  return makeEmbed(config.EMBED_COLORS.management, '🏆 GV GR STAFF LEADERBOARD', description)
    .setFooter({ text: 'Permanent all-time leaderboard • Staff Points do not reset' });
}

function createWeeklyGoalEmbed(db, userId) {
  const stats = getStaffStats(db, userId);
  const summary = require('../services/staffRewards').getWeeklySummary(db);
  const hours = stats.weeklySeconds / 3600;
  const filled = Math.min(5, Math.floor(hours / Math.max(1, summary.goalHours) * 5));
  const progress = `${'🟩'.repeat(filled)}${'⬜'.repeat(5 - filled)}`;
  const first = summary.leaderboard[0];
  const award = summary.award?.user_id ? `<@${summary.award.user_id}>` : 'No winner yet';
  return makeEmbed(config.EMBED_COLORS.info, '🎯 WEEKLY STAFF GOAL',
    `Goal: **${summary.goalHours} Hours**\n\n${progress}\n**${hours.toFixed(1)} / ${summary.goalHours} Hours**\n\n⭐ Weekly Points: **${stats.weeklyPoints}**\n🏆 Current #1: ${first ? `<@${first.user_id}> (${first.points} ⭐)` : 'No points yet'}\n🏅 Last Staff of the Week: ${award}`)
    .setFooter({ text: `Week starting ${getWeekStart()}` });
}

function createStreakEmbed(db, userId, username) {
  const stats = getStaffStats(db, userId);
  return makeEmbed(config.EMBED_COLORS.warning, `🔥 ${stats.currentStreak} DAY STAFF STREAK`,
    `${username}, complete a qualifying shift on consecutive UTC dates to build your streak.\n\nCurrent streak: **${stats.currentStreak} day${stats.currentStreak === 1 ? '' : 's'}**\nMinimum qualifying completed shift: **${config.STREAK_MIN_SHIFT_MINUTES} minutes**.`);
}

function createActivityEmbed(db, userId) {
  return createStaffStatsEmbed(db, userId, `<@${userId}>`);
}

function formatTimestamp(value) {
  return value ? unixTime(value, 'R') : 'Never';
}

module.exports = {
  createActivityEmbed,
  createCheckoutReply,
  createPermanentLeaderboardEmbed,
  createStaffCenterComponents,
  createStaffStatsEmbed,
  createStreakEmbed,
  createWeeklyGoalEmbed,
  formatTimestamp,
};