const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleOperationButton, processEventTasks } = require('../src/commands/events');
const {
  claimEventReminder,
  createEvent,
  createSession,
  finishEventReminder,
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
  assert.equal(db.prepare('SELECT lifecycle_status FROM sessions WHERE id = ?').get(session.id).lifecycle_status, 'active');
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