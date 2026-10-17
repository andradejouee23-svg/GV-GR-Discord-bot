const { randomUUID } = require('node:crypto');
const { DateTime } = require('luxon');

const EVENT_TYPES = [
  'Police RP', 'Fire/EMS RP', 'DOT RP', 'Government RP', 'Weather/Emergency',
  'Business RP', 'Community Event', 'Other',
];
const RP_TYPES = [
  'Police RP', 'Fire/EMS RP', 'DOT RP', 'Business RP', 'Government RP', 'Emergency RP', 'General RP',
];

function parseDate(dateText) {
  const numeric = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(dateText);
  let year;
  let month;
  let day;
  if (numeric) {
    [, month, day, year] = numeric.map(Number);
  } else {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateText);
    if (iso) [, year, month, day] = iso.map(Number);
    else {
      const parsed = Date.parse(`${dateText} UTC`);
      if (!Number.isFinite(parsed)) return null;
      const date = new Date(parsed);
      year = date.getUTCFullYear();
      month = date.getUTCMonth() + 1;
      day = date.getUTCDate();
    }
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day } : null;
}

function parseTime(timeText) {
  const normalized = timeText.trim().toUpperCase().replace(/\./g, '');
  const twelveHour = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/.exec(normalized);
  const twentyFourHour = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  let hour;
  let minute;
  if (twelveHour) {
    hour = Number(twelveHour[1]) % 12 + (twelveHour[3] === 'PM' ? 12 : 0);
    minute = Number(twelveHour[2] ?? 0);
  } else if (twentyFourHour) {
    hour = Number(twentyFourHour[1]);
    minute = Number(twentyFourHour[2]);
  } else return null;
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function parseStartAt(dateText, timeText, timeZone = 'UTC') {
  const date = parseDate(dateText.trim());
  const time = parseTime(timeText);
  if (!date || !time) return null;
  const local = DateTime.fromObject({ ...date, ...time }, { zone: timeZone, locale: 'en-US' });
  if (!local.isValid || local.year !== date.year || local.month !== date.month || local.day !== date.day
    || local.hour !== time.hour || local.minute !== time.minute) return null;
  const possibleOffsets = local.getPossibleOffsets();
  const unambiguous = possibleOffsets.length > 1
    ? possibleOffsets.sort((left, right) => left.toMillis() - right.toMillis())[0]
    : local;
  return unambiguous.toUTC().toISO({ suppressMilliseconds: false });
}

function parseDurationMinutes(value) {
  const match = /^(\d+)\s*(minutes?|mins?|hours?|hrs?|h|m)$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const minutes = /^(h|hr|hrs|hour|hours)$/.test(unit) ? amount * 60 : amount;
  return Number.isSafeInteger(minutes) && minutes > 0 && minutes <= 10080 ? minutes : null;
}

function formatDurationMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return [hours ? `${hours} hour${hours === 1 ? '' : 's'}` : '', remainder ? `${remainder} minute${remainder === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(' ') || '0 minutes';
}

function nextPublicId(prefix, rowId) {
  return `${prefix}-${String(rowId).padStart(4, '0')}`;
}

function recordEventHistory(db, eventId, actorId, action, details = {}, now = new Date().toISOString()) {
  db.prepare(`INSERT INTO event_history (event_id, actor_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(eventId, actorId, action, JSON.stringify(details), now);
}

function createEvent(db, data, now = new Date().toISOString()) {
  const create = db.transaction(() => {
    const result = db.prepare(`INSERT INTO events
      (name, description, host_id, host_name, starts_at, status, created_at, event_type, duration_minutes,
       voice_channel_id, announcement_channel_id, time_zone)
      VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?)`)
      .run(data.name, data.description, data.hostId, data.hostName, data.startsAt, now,
        data.eventType, data.durationMinutes, data.voiceChannelId, data.announcementChannelId, data.timeZone ?? 'UTC');
    const id = Number(result.lastInsertRowid);
    const eventCode = nextPublicId('GV-EV', id);
    db.prepare('UPDATE events SET event_code = ? WHERE id = ?').run(eventCode, id);
    recordEventHistory(db, id, data.hostId, 'created', { eventCode }, now);
    return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
  });
  return create();
}

function editEvent(db, eventCode, updates, actorId, now = new Date().toISOString()) {
  const event = db.prepare("SELECT * FROM events WHERE event_code = ? AND status = 'scheduled'").get(eventCode);
  if (!event) return null;
  const merged = { ...event, ...updates };
  db.prepare(`UPDATE events SET name = ?, event_type = ?, starts_at = ?, duration_minutes = ?, description = ?,
    host_id = ?, host_name = ?, voice_channel_id = ?, announcement_channel_id = ?, time_zone = ?, edited_at = ? WHERE id = ?`)
    .run(merged.name, merged.event_type, merged.starts_at, merged.duration_minutes, merged.description,
      merged.host_id, merged.host_name, merged.voice_channel_id, merged.announcement_channel_id, merged.time_zone ?? 'UTC', now, event.id);
  recordEventHistory(db, event.id, actorId, 'edited', { eventCode, changes: updates }, now);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(event.id);
}

function setEventAttendance(db, eventId, userId, username, response, now = new Date().toISOString()) {
  if (!['going', 'cant_go'].includes(response)) throw new TypeError('Invalid event response.');
  const result = db.prepare(`INSERT INTO event_attendance (event_id, user_id, username, response, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(event_id, user_id) DO UPDATE SET
      username = excluded.username, response = excluded.response, updated_at = excluded.updated_at
    WHERE event_attendance.response != excluded.response`)
    .run(eventId, userId, username, response, now);
  return result.changes > 0;
}

function createSession(db, data, now = new Date().toISOString()) {
  const create = db.transaction(() => {
    if (db.prepare("SELECT id FROM sessions WHERE status = 'active'").get()) {
      throw new Error('An RP session is already active or scheduled.');
    }
    const startsAt = data.scheduledStartAt && Date.parse(data.scheduledStartAt) > Date.parse(now)
      ? new Date(data.scheduledStartAt).toISOString()
      : now;
    const lifecycleStatus = Date.parse(startsAt) > Date.parse(now) ? 'scheduled' : 'active';
    const result = db.prepare(`INSERT INTO sessions
      (name, description, host_id, host_name, channel_id, started_at, status, rp_type, activity,
       expected_duration, voice_channel_id, announcement_channel_id, lifecycle_status, time_zone,
       scheduled_start_at, actual_started_at, image_url)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(data.name, data.description ?? '', data.hostId, data.hostName, data.announcementChannelId,
        startsAt, data.rpType, data.activity, data.expectedDuration, data.voiceChannelId, data.announcementChannelId,
        lifecycleStatus, data.timeZone ?? 'UTC', startsAt, lifecycleStatus === 'active' ? now : null, data.imageUrl ?? null);
    const id = Number(result.lastInsertRowid);
    const sessionCode = nextPublicId('GV-RP', id);
    db.prepare('UPDATE sessions SET session_code = ? WHERE id = ?').run(sessionCode, id);
    db.prepare(`INSERT INTO session_participants (session_id, user_id, username, joined_at)
      VALUES (?, ?, ?, ?)`).run(id, data.hostId, data.hostName, now);
    return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  });
  return create();
}

function setSessionParticipation(db, sessionId, userId, username, joining, now = new Date().toISOString()) {
  const session = db.prepare("SELECT id FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) return { active: false, changed: false };
  if (joining) {
    const result = db.prepare(`INSERT OR IGNORE INTO session_participants (session_id, user_id, username, joined_at)
      VALUES (?, ?, ?, ?)` ).run(sessionId, userId, username, now);
    return { active: true, changed: result.changes > 0 };
  }
  const result = db.prepare('DELETE FROM session_participants WHERE session_id = ? AND user_id = ?').run(sessionId, userId);
  return { active: true, changed: result.changes > 0 };
}

function getDueEventReminders(db, now = new Date()) {
  const nowIso = now.toISOString();
  const thresholds = [
    { type: 'one_hour', windowMinutes: 60 },
    { type: 'fifteen_minutes', windowMinutes: 15 },
  ];
  const due = [];
  for (const threshold of thresholds) {
    const target = threshold.windowMinutes * 60_000;
    const gracePeriod = 5 * 60_000;
    const lowerBound = new Date(now.getTime() + target - gracePeriod).toISOString();
    const upperBound = new Date(now.getTime() + target).toISOString();
    due.push(...db.prepare(`SELECT * FROM events e WHERE e.status = 'scheduled' AND e.starts_at > ? AND e.starts_at <= ?
      AND NOT EXISTS (SELECT 1 FROM event_reminders r WHERE r.event_id = e.id AND r.reminder_type = ? AND r.delivery_status = 'sent')
      AND NOT EXISTS (SELECT 1 FROM event_reminders r WHERE r.event_id = e.id AND r.reminder_type = ? AND r.delivery_status = 'failed' AND r.attempted_at > ?)`)
      .all(lowerBound, upperBound, threshold.type, threshold.type, new Date(now.getTime() - 60_000).toISOString())
      .map((event) => ({ ...event, reminder_type: threshold.type })));
  }
  due.push(...db.prepare(`SELECT * FROM events e WHERE e.status = 'scheduled' AND e.starts_at <= ?
    AND julianday(e.starts_at) + (e.duration_minutes / 1440.0) > julianday(?)
    AND NOT EXISTS (SELECT 1 FROM event_reminders r WHERE r.event_id = e.id AND r.reminder_type = 'started' AND r.delivery_status = 'sent')
    AND NOT EXISTS (SELECT 1 FROM event_reminders r WHERE r.event_id = e.id AND r.reminder_type = 'started' AND r.delivery_status = 'failed' AND r.attempted_at > ?)`)
    .all(nowIso, nowIso, new Date(now.getTime() - 60_000).toISOString()).map((event) => ({ ...event, reminder_type: 'started' })));
  return due;
}

function claimEventReminder(db, eventId, reminderType, now = new Date().toISOString()) {
  const result = db.prepare(`INSERT INTO event_reminders (event_id, reminder_type, attempted_at, delivery_status)
    SELECT id, ?, ?, 'failed' FROM events WHERE id = ? AND status = 'scheduled'
    ON CONFLICT(event_id, reminder_type) DO UPDATE SET attempted_at = excluded.attempted_at, delivery_status = 'failed'
    WHERE event_reminders.delivery_status = 'failed' AND event_reminders.attempted_at <= ?`)
    .run(reminderType, now, eventId, new Date(Date.parse(now) - 60_000).toISOString());
  return result.changes > 0;
}

function finishEventReminder(db, eventId, reminderType, delivered) {
  db.prepare('UPDATE event_reminders SET delivery_status = ? WHERE event_id = ? AND reminder_type = ?')
    .run(delivered ? 'sent' : 'failed', eventId, reminderType);
}

function createDraft(db, table, userId, data, now = Date.now()) {
  const draftId = randomUUID();
  db.prepare(`INSERT INTO ${table} (draft_id, user_id, data_json, expires_at) VALUES (?, ?, ?, ?)`)
    .run(draftId, userId, JSON.stringify(data), new Date(now + 30 * 60_000).toISOString());
  return draftId;
}

function updateDraft(db, table, draftId, userId, update) {
  const draft = db.prepare(`SELECT * FROM ${table} WHERE draft_id = ? AND user_id = ? AND expires_at > ?`)
    .get(draftId, userId, new Date().toISOString());
  if (!draft) return null;
  const data = { ...JSON.parse(draft.data_json), ...update };
  db.prepare(`UPDATE ${table} SET data_json = ? WHERE draft_id = ?`).run(JSON.stringify(data), draftId);
  return data;
}

function getDraft(db, table, draftId, userId) {
  const draft = db.prepare(`SELECT * FROM ${table} WHERE draft_id = ? AND user_id = ? AND expires_at > ?`)
    .get(draftId, userId, new Date().toISOString());
  return draft ? JSON.parse(draft.data_json) : null;
}

function deleteDraft(db, table, draftId) {
  db.prepare(`DELETE FROM ${table} WHERE draft_id = ?`).run(draftId);
}

module.exports = {
  EVENT_TYPES,
  RP_TYPES,
  claimEventReminder,
  createDraft,
  createEvent,
  createSession,
  deleteDraft,
  editEvent,
  finishEventReminder,
  formatDurationMinutes,
  getDraft,
  getDueEventReminders,
  nextPublicId,
  parseDurationMinutes,
  parseStartAt,
  recordEventHistory,
  setEventAttendance,
  setSessionParticipation,
  updateDraft,
};