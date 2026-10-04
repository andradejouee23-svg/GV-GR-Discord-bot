function formatDuration(totalSeconds) {
  const minutes = Math.max(0, Math.floor(totalSeconds / 60));
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days) return `${days}d ${remainingHours}h ${remainingMinutes}m`;
  if (hours) return `${hours}h ${remainingMinutes}m`;
  return `${remainingMinutes}m`;
}

function toUnixSeconds(isoDate) {
  return Math.floor(new Date(isoDate).getTime() / 1000);
}

module.exports = { formatDuration, toUnixSeconds };