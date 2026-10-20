const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleOperationsCommand } = require('../src/commands/operations');
const { handleOperationButton, handleOperationModal, processEventTasks } = require('../src/commands/events');
const {
  claimEventReminder,
  cancelEventRecord,
  claimEventAnnouncement,
  completeEventAnnouncement,
  completeEventRecord,
  createEvent,
  createSession,
  editEvent,
  endSessionRecord,
  finishEventReminder,
  getCurrentSession,
  getUpcomingEvents,
  releaseEventAnnouncement,
  getDueEventReminders,
  parseDurationMinutes,
  parseStartAt,
  setEventAttendance,
  setSessionParticipation,
} = require('../src/services/operations');

function openDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-operations-'));
  const databasePath = path.join(directory, 'test.sqlite');
  let db = createDatabase(databasePath);
  t.after(() => {
    if (db.open) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get db() { return db; },
    reopen() {
      db.close();
      db = createDatabase(databasePath);
      return db;
    },
  };
}

test('human event date/time and duration input parse consistently as UTC', () => {
  assert.equal(parseStartAt('October 5, 2026', '6:30 PM'), '2026-10-05T18:30:00.000Z');
  assert.equal(parseStartAt('10/05/2026', '6:30 PM'), '2026-10-05T18:30:00.000Z');
  assert.equal(parseStartAt('2026-02-30', '6:30 PM'), null);
  assert.equal(parseDurationMinutes('2 hours'), 120);
  assert.equal(parseDurationMinutes('90 minutes'), 90);
  assert.equal(parseDurationMinutes('0 minutes'), null);
});

test('IANA timezone parsing handles offsets, DST gaps, and repeated fall-back times', () => {
  assert.equal(parseStartAt('October 5, 2026', '6:30 PM', 'America/Chicago'), '2026-10-05T23:30:00.000Z');
  assert.equal(parseStartAt('March 8, 2026', '2:30 AM', 'America/New_York'), null);
  assert.equal(parseStartAt('November 1, 2026', '1:30 AM', 'America/New_York'), '2026-11-01T05:30:00.000Z');
});

test('events keep unique stable IDs and allow one changeable RSVP per user', (t) => {
  const store = openDatabase(t);
  let db = store.db;
  const eventData = {
    name: 'Night Patrol RP', eventType: 'Police RP', startsAt: '2026-10-05T18:30:00.000Z',
    durationMinutes: 120, description: 'Greenville patrols', hostId: 'staff-1', hostName: 'Officer',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
    timeZone: 'America/Chicago',
  };
  const event = createEvent(db, eventData, '2026-10-04T12:00:00.000Z');
  assert.equal(event.event_code, 'GV-EV-0001');
  assert.equal(event.time_zone, 'America/Chicago');
  const second = createEvent(db, { ...eventData, name: 'Fire RP' }, '2026-10-04T12:01:00.000Z');
  assert.equal(second.event_code, 'GV-EV-0002');

  assert.equal(setEventAttendance(db, event.id, 'player-1', 'Player', 'going'), true);
  assert.equal(setEventAttendance(db, event.id, 'player-1', 'Player', 'going'), false);
  assert.equal(setEventAttendance(db, event.id, 'player-1', 'Player', 'cant_go'), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM event_attendance WHERE event_id = ?').get(event.id).count, 1);
  assert.equal(db.prepare('SELECT response FROM event_attendance WHERE event_id = ? AND user_id = ?').get(event.id, 'player-1').response, 'cant_go');

  db = store.reopen();
  const persisted = db.prepare('SELECT event_code, name, time_zone FROM events WHERE id = ?').get(event.id);
  assert.deepEqual(persisted, { event_code: 'GV-EV-0001', name: 'Night Patrol RP', time_zone: 'America/Chicago' });
});

test('shared event cancel and completion transitions are idempotent and retain history', (t) => {
  const { db } = openDatabase(t);
  const base = {
    name: 'Service Event', eventType: 'Other', durationMinutes: 60, description: 'Service test',
    hostId: 'event-host', hostName: 'Host', voiceChannelId: null,
    announcementChannelId: '223456789012345678',
  };
  const cancelled = createEvent(db, { ...base, startsAt: '2026-10-22T18:00:00.000Z' }, '2026-10-20T12:00:00.000Z');
  assert.equal(getUpcomingEvents(db, new Date('2026-10-20T12:00:00.000Z')).some((event) => event.id === cancelled.id), true);
  assert.equal(cancelEventRecord(db, cancelled.id, 'manager', '2026-10-20T12:01:00.000Z').status, 'cancelled');
  assert.equal(cancelEventRecord(db, cancelled.id, 'manager', '2026-10-20T12:02:00.000Z'), null);

  const inProgress = createEvent(db, { ...base, name: 'In Progress', startsAt: '2026-10-20T11:30:00.000Z' }, '2026-10-20T10:00:00.000Z');
  assert.equal(getUpcomingEvents(db, new Date('2026-10-20T12:00:00.000Z')).some((event) => event.id === inProgress.id), true);
  assert.equal(getUpcomingEvents(db, new Date('2026-10-20T12:30:00.000Z')).some((event) => event.id === inProgress.id), false);

  const completed = createEvent(db, { ...base, name: 'Elapsed Event', startsAt: '2026-10-20T10:00:00.000Z' }, '2026-10-20T09:00:00.000Z');
  assert.equal(completeEventRecord(db, completed.id, '2026-10-20T10:59:59.000Z'), null);
  const result = completeEventRecord(db, completed.id, '2026-10-20T11:00:00.000Z');
  assert.equal(result.status, 'completed');
  assert.equal(result.ended_at, '2026-10-20T11:00:00.000Z');
  assert.equal(completeEventRecord(db, completed.id, '2026-10-20T12:00:00.000Z'), null);
  assert.deepEqual(db.prepare('SELECT action FROM event_history WHERE event_id = ? ORDER BY id').all(completed.id), [
    { action: 'created' }, { action: 'completed' },
  ]);
  assert.equal(getUpcomingEvents(db, new Date('2026-10-20T12:00:00.000Z')).some((event) => [cancelled.id, completed.id].includes(event.id)), false);
});

test('event announcement claims prevent concurrent sends and only allow definite-failure release', (t) => {
  const { db } = openDatabase(t);
  const event = createEvent(db, {
    name: 'Claimed Announcement', eventType: 'Other', startsAt: '2026-10-22T18:00:00.000Z',
    durationMinutes: 120, description: '', hostId: 'host', hostName: 'Host',
    announcementChannelId: '223456789012345678',
  }, '2026-10-20T12:00:00.000Z');
  assert.equal(claimEventAnnouncement(db, event.id), true);
  assert.equal(claimEventAnnouncement(db, event.id), false);
  assert.equal(db.prepare('SELECT announcement_message_id FROM events WHERE id = ?').get(event.id).announcement_message_id, 'pending');
  assert.equal(releaseEventAnnouncement(db, event.id), true);
  assert.equal(claimEventAnnouncement(db, event.id), true);
  assert.equal(completeEventAnnouncement(db, event.id, 'published-message'), true);
  assert.equal(claimEventAnnouncement(db, event.id), false);
  assert.equal(db.prepare('SELECT announcement_message_id FROM events WHERE id = ?').get(event.id).announcement_message_id, 'published-message');
});

test('rescheduling an event reopens its existing reminder slots without deleting records', (t) => {
  const { db } = openDatabase(t);
  const event = createEvent(db, {
    name: 'Rescheduled Patrol', eventType: 'Police RP', startsAt: '2026-10-20T14:00:00.000Z',
    durationMinutes: 60, description: 'Patrol', hostId: 'host', hostName: 'Host',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  }, '2026-10-20T12:00:00.000Z');
  claimEventReminder(db, event.id, 'one_hour', '2026-10-20T13:00:00.000Z');
  finishEventReminder(db, event.id, 'one_hour', true);

  const updated = editEvent(db, event.event_code, { starts_at: '2026-10-20T16:00:00.000Z' }, 'manager', '2026-10-20T13:05:00.000Z');
  assert.equal(updated.starts_at, '2026-10-20T16:00:00.000Z');
  assert.deepEqual(db.prepare('SELECT reminder_type, delivery_status, attempted_at FROM event_reminders WHERE event_id = ?').get(event.id), {
    reminder_type: 'one_hour', delivery_status: 'failed', attempted_at: '2026-10-20T13:05:00.000Z',
  });
  assert.deepEqual(getDueEventReminders(db, new Date('2026-10-20T15:00:00.000Z')).map((reminder) => reminder.reminder_type), ['one_hour']);
  assert.equal(db.prepare("SELECT action FROM event_history WHERE event_id = ? ORDER BY id DESC LIMIT 1").get(event.id).action, 'edited');
});

test('slash event commands use shared service, validate channel permissions, and cancel the published panel', async (t) => {
  const { db } = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = { id: 'event-manager', roles: { cache: new Map([[managerRole, {}]]) } };
  const serverId = config.SERVER_ID;
  const channelId = config.EVENT_CHANNEL_ID;
  const eventDateTime = new Date(Date.now() + 2 * 86400_000).toISOString();
  let canPublish = false;
  let sends = 0;
  let eventMessage;
  const channel = {
    id: channelId, guildId: serverId,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => canPublish }),
    send: async (payload) => {
      sends += 1;
      if (payload.components?.length) {
        eventMessage = { id: 'event-announcement', channelId, edit: async (editPayload) => { eventMessage.edited = editPayload; } };
        return eventMessage;
      }
      return { id: `log-${sends}`, channelId };
    },
    messages: { fetch: async () => eventMessage },
  };
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } };
  const guild = {
    id: serverId, ownerId: 'server-owner', members: {
      me: { id: 'bot' }, fetch: async () => manager,
    }, channels: { fetch: async () => channel },
  };
  const command = (action) => ({
    commandName: 'event', guild, client,
    user: { id: manager.id, username: 'Manager' },
    options: {
      getSubcommand: () => action,
      getString: (key) => ({ name: 'Slash Event', datetime: eventDateTime, description: 'A scheduled event.' })[key],
      getInteger: () => 1,
    },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  });

  const blocked = await handleOperationsCommand(command('create'), { db, client, config });
  assert.match(blocked.content, /permissions/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);

  canPublish = true;
  const created = await handleOperationsCommand(command('create'), { db, client, config });
  assert.match(created.content, /GV-EV-0001 scheduled and announced/);
  assert.equal(db.prepare('SELECT event_code, announcement_message_id FROM events').get().announcement_message_id, 'event-announcement');
  assert.equal(eventMessage.edited, undefined);
  const listed = await handleOperationsCommand(command('list'), { db, client, config });
  assert.match(listed.embeds[0].data.description, /GV-EV-0001 • Slash Event/);

  const cancelled = await handleOperationsCommand(command('cancel'), { db, client, config });
  assert.match(cancelled.content, /GV-EV-0001 cancelled/);
  assert.equal(db.prepare('SELECT status FROM events WHERE id = 1').get().status, 'cancelled');
  assert.ok(eventMessage.edited.components[0].components[0].data.disabled);
});

test('a slash-created event with a failed announcement can be published later without a duplicate record', async (t) => {
  const { db } = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = { id: 'retry-manager', roles: { cache: new Map([[managerRole, {}]]) } };
  const dateTime = new Date(Date.now() + 2 * 86400_000).toISOString();
  let failAnnouncement = true;
  const sent = [];
  const channel = {
    id: config.EVENT_CHANNEL_ID, guildId: config.SERVER_ID,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      if (payload.components?.length && failAnnouncement) {
        failAnnouncement = false;
        throw Object.assign(new Error('definite permission rejection'), { status: 403 });
      }
      const message = { id: `sent-${sent.length + 1}`, channelId: config.EVENT_CHANNEL_ID, edit: async (editPayload) => { message.edited = editPayload; } };
      sent.push({ payload, message });
      return message;
    },
    messages: { fetch: async (id) => sent.find((entry) => entry.message.id === id)?.message },
  };
  const client = { user: { id: 'bot' }, channels: { fetch: async () => channel } };
  const guild = { id: config.SERVER_ID, ownerId: 'owner', members: { me: { id: 'bot' }, fetch: async () => manager } };
  const create = await handleOperationsCommand({
    commandName: 'event', guild, client, user: { id: manager.id, username: 'Manager' },
    options: {
      getSubcommand: () => 'create',
      getString: (key) => ({ name: 'Retry Event', datetime: dateTime, description: 'Recoverable announcement.' })[key],
    },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db, client, config });
  assert.match(create.content, /Event GV-EV-0001 was saved, but I could not announce it/i);
  const saved = db.prepare('SELECT * FROM events').get();
  assert.ok(saved.event_code);
  assert.equal(saved.announcement_message_id, null);

  const openEdit = await handleOperationModal({
    customId: 'gv:event:manage:edit', guild, member: manager,
    user: { id: manager.id, username: 'Manager' },
    fields: { getTextInputValue: () => saved.event_code },
    showModal: async (modal) => modal,
    reply: async (payload) => payload,
  }, { db });
  const updated = new Date(dateTime);
  const editResult = await handleOperationModal({
    customId: openEdit.data.custom_id, guild, member: manager, client,
    user: { id: manager.id, username: 'Manager' },
    fields: { getTextInputValue: (key) => ({
      name: 'Retry Event', type: 'Other', date: updated.toISOString().slice(0, 10),
      time: updated.toISOString().slice(11, 16), duration: '2 hours',
    })[key] },
    reply: async (payload) => payload,
  }, { db });
  assert.match(editResult.content, /has been updated/);
  const after = db.prepare('SELECT event_code, announcement_message_id FROM events').get();
  assert.equal(after.event_code, saved.event_code);
  assert.ok(after.announcement_message_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);
  assert.equal(sent.filter((entry) => entry.payload.components?.length).length, 1);
});

test('event reminder windows are distinct, deduplicated, retry failed sends, and ignore cancelled events', (t) => {
  const { db } = openDatabase(t);
  const event = createEvent(db, {
    name: 'Community RP', eventType: 'Community Event', startsAt: '2026-10-05T19:00:00.000Z',
    durationMinutes: 60, description: 'Community scene', hostId: 'staff-2', hostName: 'Host',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  }, '2026-10-04T12:00:00.000Z');

  let due = getDueEventReminders(db, new Date('2026-10-05T18:00:00.000Z'));
  assert.deepEqual(due.map((entry) => entry.reminder_type), ['one_hour']);
  assert.equal(claimEventReminder(db, event.id, 'one_hour', '2026-10-05T18:00:00.000Z'), true);
  assert.equal(claimEventReminder(db, event.id, 'one_hour', '2026-10-05T18:00:01.000Z'), false);
  finishEventReminder(db, event.id, 'one_hour', false);
  assert.equal(getDueEventReminders(db, new Date('2026-10-05T18:00:59.000Z')).length, 0);
  assert.equal(getDueEventReminders(db, new Date('2026-10-05T18:01:00.000Z')).length, 1);
  assert.equal(claimEventReminder(db, event.id, 'one_hour', '2026-10-05T18:01:00.000Z'), true);
  finishEventReminder(db, event.id, 'one_hour', true);
  due = getDueEventReminders(db, new Date('2026-10-05T18:45:00.000Z'));
  assert.deepEqual(due.map((entry) => entry.reminder_type), ['fifteen_minutes']);

  const soon = createEvent(db, {
    name: 'Soon RP', eventType: 'Police RP', startsAt: '2026-10-05T19:00:00.000Z',
    durationMinutes: 60, description: 'A second event', hostId: 'staff-4', hostName: 'Host',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  }, '2026-10-04T12:02:00.000Z');
  due = getDueEventReminders(db, new Date('2026-10-05T18:46:00.000Z'))
    .filter((entry) => entry.event_code === soon.event_code);
  assert.deepEqual(due.map((entry) => entry.reminder_type), ['fifteen_minutes']);
  assert.equal(getDueEventReminders(db, new Date('2026-10-05T20:01:00.000Z'))
    .some((entry) => entry.event_code === soon.event_code && entry.reminder_type === 'started'), false);

  db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(event.id);
  assert.equal(getDueEventReminders(db, new Date('2026-10-05T19:00:00.000Z'))
    .filter((entry) => entry.event_code === event.event_code).length, 0);
});

test('a concurrently cancelled event is rechecked before reminder delivery', async (t) => {
  const { db } = openDatabase(t);
  const now = new Date('2026-10-05T18:00:00.000Z');
  const event = createEvent(db, {
    name: 'Race Check', eventType: 'Community Event', startsAt: '2026-10-05T19:00:00.000Z',
    durationMinutes: 60, description: 'Test cancel race', hostId: 'staff-9', hostName: 'Host',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  }, '2026-10-05T12:00:00.000Z');
  let sends = 0;
  const client = { channels: { fetch: async () => {
    db.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(event.id);
    return { isTextBased: () => true, send: async () => { sends += 1; return { delete: async () => {} }; } };
  } } };

  await processEventTasks(client, db, now);
  assert.equal(sends, 0);
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(event.id).status, 'cancelled');
});

test('failed event-start reminders do not write repeated started-history entries', async (t) => {
  const { db } = openDatabase(t);
  const now = new Date('2026-10-20T18:00:00.000Z');
  const event = createEvent(db, {
    name: 'Reminder Retry', eventType: 'Other', startsAt: now.toISOString(), durationMinutes: 60,
    description: 'Retry history check', hostId: 'host', hostName: 'Host',
    voiceChannelId: null, announcementChannelId: '223456789012345678',
  }, '2026-10-19T18:00:00.000Z');
  const attempted = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    send: async (payload) => { attempted.push(payload); throw new Error('mock send denied'); },
  }) } };

  await processEventTasks(client, db, now);
  await processEventTasks(client, db, new Date(now.getTime() + 60_000));
  assert.doesNotMatch(attempted[0].embeds[0].data.description, /<#null>/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM event_history WHERE event_id = ? AND action = 'started'").get(event.id).count, 0);
  assert.equal(db.prepare("SELECT delivery_status FROM event_reminders WHERE event_id = ? AND reminder_type = 'started'").get(event.id).delivery_status, 'failed');
});

test('scheduled sessions persist, generate unique IDs, and track join/leave without duplicates', (t) => {
  const store = openDatabase(t);
  let db = store.db;
  const session = createSession(db, {
    name: 'Friday Night Greenville RP', activity: 'Patrol and community scenes',
    hostId: 'staff-3', hostName: 'Host', rpType: 'General RP', expectedDuration: '2 hours',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
    scheduledStartAt: '2026-10-05T18:30:00.000Z', timeZone: 'America/Chicago',
  }, '2026-10-04T12:00:00.000Z');
  assert.equal(session.session_code, 'GV-RP-0001');
  assert.equal(session.lifecycle_status, 'scheduled');
  assert.equal(session.started_at, '2026-10-05T18:30:00.000Z');
  assert.equal(session.time_zone, 'America/Chicago');
  assert.throws(() => createSession(db, {
    name: 'Overlap', activity: '', hostId: 'staff-4', hostName: 'Other', rpType: 'General RP',
    expectedDuration: '1 hour', voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  }, '2026-10-04T12:01:00.000Z'), /already active or scheduled/);

  assert.deepEqual(setSessionParticipation(db, session.id, 'player-1', 'Player', true, '2026-10-04T12:02:00.000Z'), { active: true, changed: true });
  assert.deepEqual(setSessionParticipation(db, session.id, 'player-1', 'Player', true, '2026-10-04T12:03:00.000Z'), { active: true, changed: false });
  assert.deepEqual(setSessionParticipation(db, session.id, 'player-1', 'Player', false, '2026-10-04T12:04:00.000Z'), { active: true, changed: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ? AND user_id = ?').get(session.id, 'player-1').count, 0);

  db = store.reopen();
  const persisted = db.prepare('SELECT session_code, lifecycle_status, started_at, time_zone FROM sessions WHERE id = ?').get(session.id);
  assert.deepEqual(persisted, { session_code: 'GV-RP-0001', lifecycle_status: 'scheduled', started_at: '2026-10-05T18:30:00.000Z', time_zone: 'America/Chicago' });
});

test('shared session end refuses scheduled sessions and atomically accounts for pauses', (t) => {
  const { db } = openDatabase(t);
  const startedAt = new Date('2026-10-20T12:00:00.000Z');
  const scheduled = createSession(db, {
    name: 'Scheduled Patrol', activity: 'Patrol', hostId: 'host-one', hostName: 'Host',
    rpType: 'Police RP', expectedDuration: '2 hours', voiceChannelId: '123456789012345678',
    announcementChannelId: '223456789012345678', scheduledStartAt: '2026-10-20T13:00:00.000Z',
  }, startedAt.toISOString());
  assert.equal(getCurrentSession(db).id, scheduled.id);
  assert.equal(endSessionRecord(db, scheduled.id, '2026-10-20T12:30:00.000Z'), null);
  assert.equal(db.prepare('SELECT lifecycle_status FROM sessions WHERE id = ?').get(scheduled.id).lifecycle_status, 'scheduled');

  db.prepare("UPDATE sessions SET status = 'completed', lifecycle_status = 'cancelled', ended_at = ? WHERE id = ?")
    .run('2026-10-20T12:31:00.000Z', scheduled.id);
  const active = createSession(db, {
    name: 'Paused Patrol', activity: 'Patrol', hostId: 'host-two', hostName: 'Host',
    rpType: 'Police RP', expectedDuration: '2 hours', voiceChannelId: '123456789012345678',
    announcementChannelId: '223456789012345678', scheduledStartAt: startedAt.toISOString(),
  }, startedAt.toISOString());
  db.prepare("UPDATE sessions SET lifecycle_status = 'paused', paused_at = ?, paused_seconds = 5 WHERE id = ?")
    .run('2026-10-20T12:00:10.000Z', active.id);

  const ended = endSessionRecord(db, active.id, '2026-10-20T12:00:30.000Z');
  assert.equal(ended.lifecycle_status, 'completed');
  assert.equal(ended.duration_seconds, 5);
  assert.equal(ended.paused_seconds, 25);
  assert.equal(endSessionRecord(db, active.id, '2026-10-20T12:01:00.000Z'), null);
});

test('`/session status` reports the shared session and `/session end` completes it once', async (t) => {
  const { db } = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = { id: 'session-manager', roles: { cache: new Map([[managerRole, {}]]) } };
  const guild = { id: 'session-guild', ownerId: 'server-owner', members: { fetch: async () => manager } };
  const session = createSession(db, {
    name: 'Shared Status Patrol', description: 'Evening patrol.', activity: 'Patrol',
    hostId: 'session-host', hostName: 'Host', rpType: 'Police RP', expectedDuration: '1 hour',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  });
  const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => ({}) }) } };
  const command = (action) => ({
    commandName: 'session', guild, client,
    user: { id: manager.id, username: 'Manager' },
    options: { getSubcommand: () => action },
    reply: async (payload) => payload,
  });

  const status = await handleOperationsCommand(command('status'), { db });
  assert.equal(status.ephemeral, true);
  assert.match(status.embeds[0].data.description, /Shared Status Patrol/i);
  assert.match(status.embeds[0].data.description, /GV-RP-0001/);

  const ended = await handleOperationsCommand(command('end'), { db });
  assert.match(ended.content, /Session GV-RP-0001 ended/);
  assert.equal(db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id).status, 'completed');
  const repeated = await handleOperationsCommand(command('end'), { db });
  assert.match(repeated.content, /There is no active RP session/);
});

test('background tasks start/complete events and sessions and refresh their public posts', async (t) => {
  const { db } = openDatabase(t);
  const start = new Date('2026-10-06T18:00:00.000Z');
  const event = createEvent(db, {
    name: 'Scheduled Police RP', eventType: 'Police RP', startsAt: start.toISOString(),
    durationMinutes: 1, description: 'Patrol', hostId: 'staff-5', hostName: 'EventHost',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  }, '2026-10-05T18:00:00.000Z');
  const session = createSession(db, {
    name: 'Scheduled General RP', activity: 'Community scenes', hostId: 'staff-6', hostName: 'SessionHost',
    rpType: 'General RP', expectedDuration: '1 minute', voiceChannelId: '123456789012345678',
    announcementChannelId: '223456789012345678', scheduledStartAt: start.toISOString(),
  }, '2026-10-05T18:00:00.000Z');
  db.prepare('UPDATE sessions SET channel_id = ?, message_id = ? WHERE id = ?')
    .run('223456789012345678', '323456789012345678', session.id);

  const messages = [];
  const client = {
    channels: {
      fetch: async () => ({
        isTextBased: () => true,
        send: async (payload) => {
          messages.push({ kind: 'send', payload });
          return { id: `sent-${messages.length}` };
        },
        messages: {
          fetch: async () => ({
            edit: async (payload) => messages.push({ kind: 'edit', payload }),
          }),
        },
      }),
    },
  };

  await processEventTasks(client, db, start);
  const eventReminder = db.prepare("SELECT delivery_status FROM event_reminders WHERE event_id = ? AND reminder_type = 'started'").get(event.id);
  assert.equal(eventReminder.delivery_status, 'sent');
  const activatedSession = db.prepare('SELECT lifecycle_status, scheduled_start_at, actual_started_at FROM sessions WHERE id = ?').get(session.id);
  assert.equal(activatedSession.lifecycle_status, 'active');
  assert.equal(activatedSession.scheduled_start_at, start.toISOString());
  assert.equal(activatedSession.actual_started_at, start.toISOString());
  assert.ok(messages.some((entry) => entry.kind === 'edit'));

  await processEventTasks(client, db, new Date(start.getTime() + 61_000));
  assert.equal(db.prepare('SELECT status FROM events WHERE id = ?').get(event.id).status, 'completed');
  const completedSession = db.prepare('SELECT status, lifecycle_status, duration_seconds FROM sessions WHERE id = ?').get(session.id);
  assert.equal(completedSession.status, 'completed');
  assert.equal(completedSession.lifecycle_status, 'completed');
  assert.equal(completedSession.duration_seconds, 61);
  assert.ok(messages.filter((entry) => entry.kind === 'edit').length >= 2);
});

test('session controls acknowledge promptly, reject pre-start ending, and update stored/public lifecycle', async (t) => {
  const { db } = openDatabase(t);
  const now = new Date();
  const session = createSession(db, {
    name: 'Host Controlled RP', activity: 'Patrol', hostId: 'session-host', hostName: 'Host',
    rpType: 'Police RP', expectedDuration: '2 hours', voiceChannelId: '123456789012345678',
    announcementChannelId: '223456789012345678', scheduledStartAt: new Date(now.getTime() + 60_000).toISOString(),
  }, now.toISOString());
  db.prepare('UPDATE sessions SET channel_id = ?, message_id = ? WHERE id = ?')
    .run('223456789012345678', '323456789012345678', session.id);

  const publicEdits = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    send: async () => ({ id: 'log-message', delete: async () => {} }),
    messages: { fetch: async () => ({ edit: async (payload) => publicEdits.push(payload) }) },
  }) } };
  const interactionFor = (action) => {
    let deferred = false;
    let finalPayload;
    return {
      interaction: {
        customId: `gv:rp:control:${session.id}:${action}`,
        guild: { ownerId: 'server-owner' },
        member: { id: 'session-host', roles: { cache: new Map(config.STAFF_ROLE_IDS.map((roleId) => [roleId, {}])) } },
        user: { id: 'session-host', username: 'Host' },
        client,
        reply: async (payload) => { finalPayload = payload; },
        deferUpdate: async () => { deferred = true; },
        editReply: async (payload) => { finalPayload = payload; },
        followUp: async (payload) => { finalPayload = payload; },
      },
      wasDeferred: () => deferred,
      finalPayload: () => finalPayload,
    };
  };

  const prematureEnd = interactionFor('end');
  await handleOperationButton(prematureEnd.interaction, { db });
  assert.match(prematureEnd.finalPayload().content, /has not started yet/i);
  assert.equal(prematureEnd.wasDeferred(), false);
  assert.equal(db.prepare('SELECT lifecycle_status FROM sessions WHERE id = ?').get(session.id).lifecycle_status, 'scheduled');

  const start = interactionFor('start');
  await handleOperationButton(start.interaction, { db });
  assert.equal(start.wasDeferred(), true);
  assert.equal(db.prepare('SELECT lifecycle_status FROM sessions WHERE id = ?').get(session.id).lifecycle_status, 'active');
  assert.ok(db.prepare('SELECT actual_started_at FROM sessions WHERE id = ?').get(session.id).actual_started_at);
  assert.ok(publicEdits.length >= 1);

  const pause = interactionFor('pause');
  await handleOperationButton(pause.interaction, { db });
  assert.equal(db.prepare('SELECT lifecycle_status FROM sessions WHERE id = ?').get(session.id).lifecycle_status, 'paused');

  const resume = interactionFor('pause');
  await handleOperationButton(resume.interaction, { db });
  assert.equal(db.prepare('SELECT lifecycle_status FROM sessions WHERE id = ?').get(session.id).lifecycle_status, 'active');

  const end = interactionFor('end');
  await handleOperationButton(end.interaction, { db });
  assert.equal(db.prepare('SELECT lifecycle_status FROM sessions WHERE id = ?').get(session.id).lifecycle_status, 'completed');
  assert.match(end.finalPayload().content, /ended/i);
  assert.ok(publicEdits.length >= 2);
});

test('scheduled session cancellation requires confirmation and disables the public join controls', async (t) => {
  const { db } = openDatabase(t);
  const now = new Date();
  const session = createSession(db, {
    name: 'Cancelled RP', description: 'A scheduled community scene.', activity: 'Community scene',
    hostId: 'cancel-host', hostName: 'Host', rpType: 'General RP', expectedDuration: '2 hours',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
    scheduledStartAt: new Date(now.getTime() + 60_000).toISOString(),
  }, now.toISOString());
  db.prepare('UPDATE sessions SET channel_id = ?, message_id = ? WHERE id = ?')
    .run('223456789012345678', '323456789012345678', session.id);
  const publicEdits = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    messages: { fetch: async () => ({ edit: async (payload) => publicEdits.push(payload) }) },
  }) } };
  const host = {
    id: 'cancel-host',
    roles: { cache: new Map(config.STAFF_ROLE_IDS.map((roleId) => [roleId, {}])) },
  };
  const guild = { ownerId: 'server-owner' };
  let confirmation;
  await handleOperationButton({
    customId: `gv:rp:control:${session.id}:cancel`, guild, member: host,
    user: { id: host.id, username: 'Host' },
    reply: async (payload) => { confirmation = payload; },
  }, { db });
  assert.equal(confirmation.ephemeral, true);
  assert.equal(confirmation.components[0].components[0].data.custom_id, `gv:rp:control:${session.id}:cancel_confirm`);

  let finalPayload;
  await handleOperationButton({
    customId: `gv:rp:control:${session.id}:cancel_confirm`, guild, member: host,
    user: { id: host.id, username: 'Host' }, client,
    deferUpdate: async () => {},
    editReply: async (payload) => { finalPayload = payload; },
  }, { db });
  assert.match(finalPayload.content, /was cancelled/i);
  assert.equal(db.prepare('SELECT status, lifecycle_status FROM sessions WHERE id = ?').get(session.id).lifecycle_status, 'cancelled');
  assert.equal(publicEdits.length, 1);
  assert.match(publicEdits[0].embeds[0].data.description, /SESSION CANCELLED/);
  assert.equal(publicEdits[0].components[0].components[0].data.disabled, true);
});