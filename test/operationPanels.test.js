const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChannelType } = require('discord.js');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleButton } = require('../src/buttons');
const { handleOperationsCommand } = require('../src/commands/operations');
const { createDraft, createEvent, createSession, updateDraft } = require('../src/services/operations');
const {
  eventManageComponents,
  handleOperationButton,
  handleOperationModal,
  handleOperationSelect,
  handleStaffCenterControl,
  makeGraphic,
  parseSessionStartAt,
  sessionEmbed,
  sessionPublicComponents,
} = require('../src/commands/events');
const { createStaffCenterComponents } = require('../src/utils/staffCenter');

function member(id, roleIds = []) {
  return { id, roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) } };
}

function openDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-operation-panels-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

test('Events panel exposes all requested management actions and staff can reach it', async (t) => {
  const db = openDatabase(t);
  const panelButtons = createStaffCenterComponents().flatMap((actionRow) =>
    actionRow.components.map((component) => component.data.custom_id));
  assert.ok(panelButtons.includes('gv:center:events'));
  assert.ok(panelButtons.includes('gv:center:rp:start'));
  assert.equal(panelButtons.includes('gv:center:rp:history'), false);

  const eventActions = eventManageComponents().flatMap((actionRow) =>
    actionRow.components.map((component) => component.data.custom_id));
  assert.deepEqual(eventActions, [
    'gv:center:event:create',
    'gv:center:event:upcoming',
    'gv:center:event:edit',
    'gv:center:event:cancel',
    'gv:center:event:attendance',
    'gv:center:event:history',
    'gv:center:event:host',
  ]);

  let reply;
  await handleStaffCenterControl({
    customId: 'gv:center:events',
    user: { id: 'event-staff' },
    member: member('event-staff', config.STAFF_ROLE_IDS),
    guild: { ownerId: 'server-owner' },
    reply: async (payload) => { reply = payload; },
  }, { db });
  assert.equal(reply.ephemeral, true);
  assert.match(reply.embeds[0].data.title, /GV GR EVENTS/);
  assert.deepEqual(reply.components.flatMap((actionRow) => actionRow.components.map((component) => component.data.custom_id)), eventActions);

  let denied;
  await handleStaffCenterControl({
    customId: 'gv:center:event:create',
    user: { id: 'ordinary-user' },
    member: member('ordinary-user'),
    guild: { ownerId: 'server-owner' },
    reply: async (payload) => { denied = payload; },
  }, { db });
  assert.match(denied.content, /configured staff only/i);
});

test('hiding RP History leaves completed session data and participants intact', (t) => {
  const db = openDatabase(t);
  db.prepare('INSERT INTO staff (user_id, username, role_name, first_seen_at) VALUES (?, ?, ?, ?)')
    .run('session-host', 'Host', 'Moderator', '2026-10-01T00:00:00.000Z');
  db.prepare(`INSERT INTO sessions (
    name, description, host_id, host_name, started_at, ended_at, duration_seconds, status,
    session_code, rp_type, activity, lifecycle_status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, 'completed')`)
    .run('Evening Patrol', '', 'session-host', 'Host', '2026-10-04T18:00:00.000Z', '2026-10-04T20:00:00.000Z', 7200,
      'GV-RP-0007', 'Police RP', 'Night patrol');
  const sessionId = db.prepare('SELECT id FROM sessions WHERE session_code = ?').get('GV-RP-0007').id;
  db.prepare(`INSERT INTO session_participants (session_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, 'participant-1', 'Participant', '2026-10-04T18:10:00.000Z');

  const session = db.prepare('SELECT session_code, name, status FROM sessions WHERE session_code = ?').get('GV-RP-0007');
  const participants = db.prepare('SELECT user_id FROM session_participants WHERE session_id = ?').all(sessionId);
  assert.deepEqual(session, { session_code: 'GV-RP-0007', name: 'Evening Patrol', status: 'completed' });
  assert.deepEqual(participants, [{ user_id: 'participant-1' }]);
  assert.equal(createStaffCenterComponents().flatMap((row) => row.components.map((component) => component.data.custom_id))
    .some((customId) => customId.includes('rp:history')), false);
});

test('session embed separates scheduled and actual start and shows the configured join code', () => {
  const embed = sessionEmbed({
    name: 'Friday Patrol',
    description: 'A coordinated city patrol.',
    host_id: 'session-host',
    scheduled_start_at: '2026-10-08T18:00:00.000Z',
    actual_started_at: null,
    expected_duration: '2 hours',
    rp_type: 'Police RP',
    activity: 'Patrol and traffic stops',
    voice_channel_id: '123456789012345678',
    session_code: 'GV-RP-0008',
    lifecycle_status: 'scheduled',
    join_code: 'OWNER-CONFIGURED-CODE',
    join_url: 'https://example.com/join',
    image_url: 'https://example.com/banner.png',
  });
  assert.match(embed.data.description, /Friday Patrol/i);
  assert.match(embed.data.description, /A coordinated city patrol/);
  assert.match(embed.data.description, /Not started yet/);
  assert.match(embed.data.description, /OWNER-CONFIGURED-CODE/);
  assert.match(embed.data.description, /Open Greenville/);
  assert.match(embed.data.description, /Custom Servers menu/);
  assert.equal(embed.data.image.url, 'https://example.com/banner.png');
  assert.equal(sessionPublicComponents(8, false, 'https://example.com/join')[0].components.length, 4);
});

test('RP time inputs roll to the next UTC day if today’s entered time already passed', () => {
  assert.equal(parseSessionStartAt('6:30 PM', new Date('2026-10-05T17:00:00.000Z')), '2026-10-05T18:30:00.000Z');
  assert.equal(parseSessionStartAt('6:30 PM', new Date('2026-10-05T18:45:00.000Z')), '2026-10-06T18:30:00.000Z');
  assert.equal(parseSessionStartAt('6:30 PM', new Date('2026-10-05T22:45:00.000Z'), 'America/Chicago'), '2026-10-05T23:30:00.000Z');
  assert.equal(parseSessionStartAt('6:30 PM', new Date('2026-10-31T23:45:00.000Z'), 'America/Chicago'), '2026-11-02T00:30:00.000Z');
});

test('event graphic renderer creates a valid PNG attachment', async () => {
  const graphic = await makeGraphic('Police RP', 'Night Patrol RP');
  assert.equal(graphic.name, 'gv-gr-event.png');
  assert.deepEqual(graphic.attachment.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test('regular staff cannot open management-only event attendance controls', async (t) => {
  const db = openDatabase(t);
  let reply;
  await handleStaffCenterControl({
    customId: 'gv:center:event:attendance',
    user: { id: 'regular-staff' },
    member: member('regular-staff', config.STAFF_ROLE_IDS),
    guild: { ownerId: 'server-owner' },
    reply: async (payload) => { reply = payload; },
  }, { db });
  assert.equal(reply.ephemeral, true);
  assert.match(reply.content, /management access is required/i);
});

test('staff event and RP session buttons flow through modal, type dropdown, and channel selection', async (t) => {
  const db = openDatabase(t);
  const staff = member('form-staff', config.STAFF_ROLE_IDS);
  const guild = {
    ownerId: 'server-owner',
    members: { fetch: async (userId) => userId === staff.id ? {
      ...staff,
      user: { id: staff.id, username: 'FormStaff' },
    } : null },
    channels: { fetch: async (channelId) => ({
      id: channelId,
      type: channelId.startsWith('1') ? ChannelType.GuildText : ChannelType.GuildVoice,
    }) },
  };
  const makeInteraction = (customId, values = {}) => ({
    customId,
    guild,
    member: staff,
    user: { id: staff.id, username: 'FormStaff' },
    values: values.values ?? [],
    fields: { getTextInputValue: (field) => values.fields?.[field] ?? '' },
    reply: async (payload) => payload,
    update: async (payload) => payload,
    showModal: async (modal) => modal,
  });

  const eventStart = await handleStaffCenterControl(makeInteraction('gv:center:event:create'), { db });
  assert.match(eventStart.data.custom_id, /^gv:event:create:[0-9a-f-]+:basics$/);
  const eventDraftId = eventStart.data.custom_id.split(':')[3];
  const eventDate = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
  const eventTypePrompt = await handleOperationModal(makeInteraction(`gv:event:create:${eventDraftId}:basics`, {
    fields: { name: 'Night Patrol RP', date: eventDate, time: '6:30 PM', duration: '2 hours' },
  }), { db });
  assert.deepEqual(eventTypePrompt.components[0].components[0].toJSON().options.map((option) => option.value), [
    'Police RP', 'Fire/EMS RP', 'DOT RP', 'Government RP', 'Weather/Emergency', 'Business RP', 'Community Event', 'Other',
  ]);
  const eventDescription = await handleOperationSelect(makeInteraction(`gv:event:type:${eventDraftId}`, { values: ['Police RP'] }), { db });
  assert.equal(eventDescription.data.custom_id, `gv:event:create:${eventDraftId}:description`);

  const sessionStart = await handleStaffCenterControl(makeInteraction('gv:center:rp:start'), { db });
  assert.match(sessionStart.data.custom_id, /^gv:rp:create:[0-9a-f-]+$/);
  const sessionDraftId = sessionStart.data.custom_id.split(':')[3];
  const sessionTypePrompt = await handleOperationModal(makeInteraction(`gv:rp:create:${sessionDraftId}`, {
    fields: { name: 'Friday Night RP', description: 'An organized community roleplay session.', date: eventDate, time: '6:30 PM' },
  }), { db });
  assert.equal(sessionTypePrompt.data.custom_id, `gv:rp:create:${sessionDraftId}:details`);
  const sessionTypeMenu = await handleOperationModal(makeInteraction(`gv:rp:create:${sessionDraftId}:details`, {
    fields: { duration: '2 hours', activity: 'Patrols and community RP', image_url: '' },
  }), { db });
  assert.deepEqual(sessionTypeMenu.components[0].components[0].toJSON().options.map((option) => option.value), [
    'Police RP', 'Fire/EMS RP', 'DOT RP', 'Business RP', 'Government RP', 'Emergency RP', 'General RP',
  ]);
  const voicePrompt = await handleOperationSelect(makeInteraction(`gv:rp:type:${sessionDraftId}`, { values: ['Police RP'] }), { db });
  assert.equal(voicePrompt.components[0].components[0].data.custom_id, `gv:rp:channel:${sessionDraftId}:voice`);
  const selectedVoice = await handleOperationSelect(makeInteraction(`gv:rp:channel:${sessionDraftId}:voice`, { values: ['223456789012345678'] }), { db });
  assert.match(selectedVoice.content, /Voice channel selected/);

  const eventDescriptionPrompt = await handleOperationModal(makeInteraction(`gv:event:create:${eventDraftId}:description`, {
    fields: { description: 'Police patrol details.' },
  }), { db });
  const eventVoiceId = eventDescriptionPrompt.components[1].components[0].data.custom_id;
  const eventVoice = await handleOperationSelect(makeInteraction(eventVoiceId, { values: ['223456789012345678'] }), { db });
  assert.match(eventVoice.content, /Voice channel selected/);
  const eventChannelId = eventVoice.components[0].components[0].data.custom_id;
  const eventChannel = await handleOperationSelect(makeInteraction(eventChannelId, { values: ['123456789012345678'] }), { db });
  assert.match(eventChannel.content, /Announcement channel selected/);
});

test('Start RP Session button and `/session start` open the shared authorized workflow', async (t) => {
  const db = openDatabase(t);
  const managementRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managementRole]));
  const manager = member('session-manager', [managementRole]);
  const host = member('session-host', config.STAFF_ROLE_IDS);
  const members = new Map([
    [manager.id, { ...manager, user: { id: manager.id, username: 'Manager' } }],
    [host.id, { ...host, user: { id: host.id, username: 'Host' } }],
  ]);
  const guild = { ownerId: 'server-owner', members: { fetch: async (userId) => members.get(userId) ?? null } };
  const makeInteraction = (customId) => ({
    customId, guild, member: manager,
    user: { id: manager.id, username: 'Manager' },
    options: { getUser: () => ({ id: host.id, username: 'Host' }), getSubcommand: () => 'start' },
    reply: async (payload) => payload,
    showModal: async (modal) => modal,
  });

  const panelModal = await handleStaffCenterControl(makeInteraction('gv:center:rp:start'), { db });
  const slashModal = await handleOperationsCommand({ ...makeInteraction(''), commandName: 'session' }, { db });
  assert.match(panelModal.data.custom_id, /^gv:rp:create:[0-9a-f-]+$/);
  assert.match(slashModal.data.custom_id, /^gv:rp:create:[0-9a-f-]+$/);
  assert.notEqual(panelModal.data.custom_id, slashModal.data.custom_id);
  const drafts = db.prepare('SELECT data_json FROM session_drafts ORDER BY rowid').all().map((row) => JSON.parse(row.data_json));
  assert.equal(drafts.length, 2);
  assert.equal(drafts.find((draft) => draft.managementOnly).hostId, host.id);
  assert.equal(drafts.find((draft) => !draft.managementOnly).hostId, manager.id);

  let denied;
  await handleStaffCenterControl({
    customId: 'gv:center:rp:start', guild, member: member('ordinary-user'),
    user: { id: 'ordinary-user', username: 'Guest' },
    reply: async (payload) => { denied = payload; },
  }, { db });
  assert.match(denied.content, /configured staff only/i);
});

test('RP session publish persists once and a repeated publish click cannot duplicate it', async (t) => {
  const db = openDatabase(t);
  const staff = member('publish-staff', config.STAFF_ROLE_IDS);
  const guild = {
    ownerId: 'server-owner',
    members: { me: { id: 'session-bot' }, fetch: async (userId) => userId === staff.id ? { ...staff, user: { id: staff.id, username: 'Publisher' } } : null },
  };
  const draftId = createDraft(db, 'session_drafts', staff.id, {
    name: 'Night Patrol', description: 'Community patrol.', activity: 'Patrol', rpType: 'Police RP',
    expectedDuration: '1 hour', voiceChannelId: '123456789012345678', scheduledStartAt: new Date(Date.now() + 3600_000).toISOString(),
    timeZone: 'UTC', hostId: staff.id, hostName: 'Publisher', startLabel: '6:30 PM',
  });
  updateDraft(db, 'session_drafts', draftId, staff.id, { voiceChannelId: '123456789012345678' });
  const sent = [];
  const client = { channels: { fetch: async (channelId) => ({
    id: channelId,
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => { sent.push(payload); return { id: `message-${sent.length}`, channelId }; },
  }) } };
  let final;
  const interaction = {
    customId: `gv:rp:preview:${draftId}`, guild, member: staff,
    user: { id: staff.id, username: 'Publisher' }, client,
    deferUpdate: async () => {},
    deferReply: async () => {},
    editReply: async (payload) => { final = payload; return payload; },
    reply: async (payload) => { final = payload; return payload; },
    update: async (payload) => { final = payload; return payload; },
  };

  await handleOperationButton(interaction, { db });
  assert.match(final.content, /Preview for \*\*Night Patrol\*\*/);
  const confirmId = final.components[0].components.find((button) => button.data.custom_id?.startsWith('gv:rp:confirm:')).data.custom_id;
  interaction.customId = confirmId;
  await handleOperationButton(interaction, { db });
  assert.match(final.content, /GV-RP-0001/);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE status = 'active'").get().count, 1);
  assert.equal(db.prepare('SELECT channel_id, message_id FROM sessions WHERE id = 1').get().message_id, 'message-1');
  const sentMessages = sent.length;
  await handleOperationButton(interaction, { db });
  assert.match(final.content, /form expired/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  assert.equal(sent.length, sentMessages);
});

test('selected-host session drafts recheck management access at each publish step', async (t) => {
  const db = openDatabase(t);
  const staff = member('downgraded-manager', config.STAFF_ROLE_IDS);
  const guild = { ownerId: 'server-owner' };
  const draftId = createDraft(db, 'session_drafts', staff.id, {
    name: 'Management Hosted RP', description: 'Selected host session.', activity: 'Patrol',
    rpType: 'Police RP', expectedDuration: '1 hour', voiceChannelId: '123456789012345678',
    scheduledStartAt: new Date(Date.now() + 3600_000).toISOString(), timeZone: 'UTC',
    hostId: 'selected-host', hostName: 'SelectedHost', managementOnly: true,
  });
  const makeInteraction = (customId, values = []) => ({
    customId, guild, member: staff,
    user: { id: staff.id, username: 'Former Manager' },
    values,
    reply: async (payload) => payload,
    update: async (payload) => payload,
  });

  const type = await handleOperationSelect(makeInteraction(`gv:rp:type:${draftId}`, ['Police RP']), { db });
  assert.match(type.content, /Management access is required/i);
  const channel = await handleOperationSelect(makeInteraction(`gv:rp:channel:${draftId}:voice`, ['123456789012345678']), { db });
  assert.match(channel.content, /Management access is required/i);
  const preview = await handleOperationButton(makeInteraction(`gv:rp:preview:${draftId}`), { db });
  assert.match(preview.content, /Management access is required/i);
  const confirm = await handleOperationButton(makeInteraction(`gv:rp:confirm:${draftId}`), { db });
  assert.match(confirm.content, /Management access is required/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
});

test('public event RSVP and RP session Join/Leave buttons reach persistent handlers', async (t) => {
  const db = openDatabase(t);
  const event = createEvent(db, {
    name: 'Patrol Night', eventType: 'Police RP', startsAt: '2026-10-07T18:00:00.000Z',
    durationMinutes: 90, description: 'Patrols', hostId: 'host', hostName: 'Host',
    voiceChannelId: '123456789012345678', announcementChannelId: '223456789012345678',
  }, '2026-10-05T12:00:00.000Z');
  const session = createSession(db, {
    name: 'Public RP', activity: 'Community play', hostId: 'host', hostName: 'Host',
    rpType: 'General RP', expectedDuration: '2 hours', voiceChannelId: '123456789012345678',
    announcementChannelId: '223456789012345678', scheduledStartAt: '2026-10-07T18:00:00.000Z',
  }, '2026-10-05T12:00:00.000Z');
  const sent = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    send: async (payload) => sent.push(payload),
  }) } };
  async function press(customId, userId) {
    let response;
    const interaction = {
      customId,
      user: { id: userId, username: userId },
      client,
      deferUpdate: async () => {},
      deferReply: async () => {},
      editReply: async (payload) => { response = payload; },
      reply: async (payload) => { response = payload; },
    };
    await handleButton(interaction, { db });
    return response;
  }

  const going = await press(`gv:event:rsvp:${event.id}:going`, 'player-1');
  assert.match(going.content, /response is now \*\*Going\*\*/);
  const duplicate = await press(`gv:event:rsvp:${event.id}:going`, 'player-1');
  assert.match(duplicate.content, /already recorded/);
  const changed = await press(`gv:event:rsvp:${event.id}:cant_go`, 'player-1');
  assert.match(changed.content, /response is now \*\*Can't Go\*\*/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM event_attendance WHERE event_id = ?').get(event.id).count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM event_history WHERE event_id = ? AND action LIKE 'attendance_%'").get(event.id).count, 2);

  assert.match((await press(`gv:rp:join:${session.id}`, 'player-2')).content, /joined GV-RP-0001/);
  assert.match((await press(`gv:rp:leave:${session.id}`, 'player-2')).content, /left GV-RP-0001/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM session_participants WHERE session_id = ? AND user_id = ?').get(session.id, 'player-2').count, 0);
  assert.equal(sent.length, 2);
});