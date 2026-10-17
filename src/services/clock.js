const {
  checkInStaff,
  checkOutStaff,
} = require('./staffRewards');

function clockIn(db, member, now = new Date().toISOString()) {
  return checkInStaff(db, member, now);
}

function clockOut(db, userId, now = new Date().toISOString()) {
  return checkOutStaff(db, userId, now);
}

function getOnDuty(db) {
  return db.prepare(`
    SELECT user_id, username, role_name, started_at
    FROM shifts WHERE status = 'active'
    ORDER BY started_at ASC
  `).all();
}

module.exports = { clockIn, clockOut, getOnDuty };