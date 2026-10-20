const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { inspectAutomodMemberJoin, inspectAutomodMessage } = require('../src/services/automod');
const { applyAutomodMessage } = require('../src/events/automod');
const { submitReport } = require('../src/commands/safety');
const { handleSafetyCommand } = require('../src/commands/safety');

function openDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-automod-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function setting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, JSON.stringify(value));
}

function message(id, content, overrides = {}) {
  return {
    id,
    content,
    guild: { id: 'guild' },
    channelId: 'channel',
    author: { id: 'member', bot: false },
    member: { roles: { cache: new Map() } },
    mentions: { everyone: false, users: { size: 0 }, roles: { size: 0 } },
    ...overrides,
  };
}

test('automod persists message fingerprints, ignores duplicate gateway events, and respects exemptions', (t) => {
  const db = openDatabase(t);
  setting(db, 'AUTOMOD_ENABLED', true);
  setting(db, 'AUTOMOD_SPAM_THRESHOLD', 10);
  setting(db, 'AUTOMOD_REPEAT_THRESHOLD', 3);
  const now = new Date('2026-10-17T12:00:00.000Z');

  assert.equal(inspectAutomodMessage(db, message('message-1', 'same line'), now), null);
  assert.equal(inspectAutomodMessage(db, message('message-2', 'same line'), new Date(now.getTime() + 1000)), null);
  const repeated = inspectAutomodMessage(db, message('message-3', 'same line'), new Date(now.getTime() + 2000));
  assert.equal(repeated.type, 'repeated_message');
  assert.equal(inspectAutomodMessage(db, message('message-3', 'same line'), new Date(now.getTime() + 3000)), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM automod_incidents WHERE incident_type = 'repeated_message'").get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM automod_activity WHERE content_hash IS NOT NULL').get().count, 3);
  assert.equal(db.prepare("PRAGMA table_info(automod_activity)").all().some((column) => column.name === 'content'), false);

  setting(db, 'AUTOMOD_EXEMPT_CHANNEL_IDS', ['exempt-channel']);
  assert.equal(inspectAutomodMessage(db, message('message-exempt', 'ignored', { channelId: 'exempt-channel' }), now), null);
  setting(db, 'AUTOMOD_EXEMPT_ROLE_IDS', ['trusted-role']);
  assert.equal(inspectAutomodMessage(db, message('message-role-exempt', 'ignored', {
    member: { roles: { cache: new Map([['trusted-role', {}]]) } },
  }), now), null);
});

test('automod link filters honor trusted domains and mention limits', (t) => {
  const db = openDatabase(t);
  setting(db, 'AUTOMOD_ENABLED', true);
  setting(db, 'AUTOMOD_FILTER_LINKS', true);
  setting(db, 'AUTOMOD_FILTER_INVITES', true);
  setting(db, 'AUTOMOD_ALLOWLISTED_DOMAINS', ['trusted.example']);
  setting(db, 'AUTOMOD_SPAM_THRESHOLD', 100);
  setting(db, 'AUTOMOD_REPEAT_THRESHOLD', 100);
  setting(db, 'AUTOMOD_MENTION_LIMIT', 3);
  const now = new Date('2026-10-17T12:00:00.000Z');

  assert.equal(inspectAutomodMessage(db, message('trusted', 'https://sub.trusted.example/info'), now), null);
  assert.equal(inspectAutomodMessage(db, message('untrusted', 'https://bad.example/info'), now).type, 'untrusted_link');
  assert.equal(inspectAutomodMessage(db, message('invite', 'https://discord.gg/example'), now).type, 'invite_link');
  const massMention = message('mentions', 'hello', {
    mentions: { everyone: false, users: { size: 2 }, roles: { size: 1 } },
  });
  assert.equal(inspectAutomodMessage(db, massMention, now).type, 'mention_abuse');
});

test('raid detection alerts once per window and never issues an automatic ban', (t) => {
  const db = openDatabase(t);
  setting(db, 'AUTOMOD_ENABLED', true);
  setting(db, 'AUTOMOD_RAID_THRESHOLD', 3);
  setting(db, 'AUTOMOD_RAID_WINDOW_SECONDS', 30);
  const now = new Date('2026-10-17T12:00:00.000Z');
  const member = (id) => ({ guild: { id: 'guild' }, user: { id } });

  assert.equal(inspectAutomodMemberJoin(db, member('join-1'), now), null);
  assert.equal(inspectAutomodMemberJoin(db, member('join-2'), new Date(now.getTime() + 1000)), null);
  const alert = inspectAutomodMemberJoin(db, member('join-3'), new Date(now.getTime() + 2000));
  assert.equal(alert.type, 'raid_alert');
  assert.match(alert.reason, /No automatic bans were applied/);
  assert.equal(inspectAutomodMemberJoin(db, member('join-4'), new Date(now.getTime() + 3000)), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM automod_incidents WHERE incident_type = \'raid_alert\'').get().count, 1);
});

test('automod is log-only by default and applies only an explicitly selected timeout', async (t) => {
  const db = openDatabase(t);
  setting(db, 'AUTOMOD_ENABLED', true);
  setting(db, 'AUTOMOD_MENTION_LIMIT', 2);
  let deletes = 0;
  const timeouts = [];
  const sent = [];
  const message = {
    ...messageFactory('auto-message', 'hello'),
    mentions: { everyone: false, users: { size: 2 }, roles: { size: 0 } },
    member: { roles: { cache: new Map() }, timeout: async (duration) => timeouts.push(duration) },
    delete: async () => { deletes += 1; },
  };
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    send: async (payload) => sent.push(payload),
  }) } };

  await applyAutomodMessage(message, client, db);
  assert.equal(deletes, 0);
  assert.equal(timeouts.length, 0);
  assert.equal(db.prepare("SELECT action_result FROM automod_incidents WHERE source_id = 'auto-message'").get().action_result, 'logged');
  assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent[0]), /hello/);

  db.prepare('DELETE FROM automod_activity').run();
  setting(db, 'AUTOMOD_MODE', 'timeout');
  setting(db, 'AUTOMOD_TIMEOUT_AFTER_INCIDENTS', 1);
  setting(db, 'AUTOMOD_SPAM_THRESHOLD', 3);
  for (const [id, content] of [['spam-1', 'first'], ['spam-2', 'second']]) {
    await applyAutomodMessage({
      ...messageFactory(id, content),
      author: { id: 'spammer', username: 'Spammer', bot: false },
      member: { roles: { cache: new Map() }, timeout: async (duration) => timeouts.push(duration) },
    }, client, db);
  }
  await applyAutomodMessage({
    ...messageFactory('spam-message', 'third'),
    author: { id: 'spammer', username: 'Spammer', bot: false },
    member: { roles: { cache: new Map() }, timeout: async (duration) => timeouts.push(duration) },
  }, client, db);
  assert.deepEqual(timeouts, [10 * 60_000]);
  assert.equal(db.prepare("SELECT action_result FROM automod_incidents WHERE source_id = 'spam-message'").get().action_result, 'timed_out_10_minutes');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM moderation_logs WHERE action LIKE 'automod_%'").get().count, 2);

  setting(db, 'AUTOMOD_MODE', 'warn');
  const warnings = [];
  const warnMessage = (id) => ({
    ...messageFactory(id, 'mass mention'),
    author: { id: 'warn-member', username: 'WarnMember', bot: false, send: async (text) => warnings.push(text) },
    mentions: { everyone: true, users: { size: 0 }, roles: { size: 0 } },
  });
  await applyAutomodMessage(warnMessage('warn-1'), client, db);
  await applyAutomodMessage(warnMessage('warn-2'), client, db);
  assert.equal(warnings.length, 1);
  assert.equal(db.prepare("SELECT action_result FROM automod_incidents WHERE source_id = 'warn-2'").get().action_result, 'warning_suppressed_by_cooldown');
});

test('player reports use a persistent cooldown and do not create duplicate records', async (t) => {
  const db = openDatabase(t);
  const sent = [];
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => false }),
    send: async (payload) => { sent.push(payload); return { channelId: config.REPORT_CHANNEL_ID, id: `report-message-${sent.length}` }; },
  }) } };
  const interactionFor = () => ({
    fields: { getTextInputValue: (key) => ({ player: 'Player', reason: 'Rule breach', description: 'Details', evidence: '' })[key] },
    user: { id: 'reporter', username: 'Reporter' },
    client,
    guild: { id: 'guild', roles: { everyone: { id: 'guild' } } },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  });

  const first = await submitReport(interactionFor(), { db });
  assert.match(first.content, /report \(#1\) was sent privately/i);
  const repeat = await submitReport(interactionFor(), { db });
  assert.match(repeat.content, /Report cooldown: try again in/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reports').get().count, 1);
});

test('player reports are not delivered to a channel visible to @everyone', async (t) => {
  const db = openDatabase(t);
  let sends = 0;
  const client = { channels: { fetch: async () => ({
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async () => { sends += 1; },
  }) } };
  const interaction = {
    fields: { getTextInputValue: (key) => ({ player: 'Player', reason: 'Rule breach', description: 'Details', evidence: '' })[key] },
    user: { id: 'public-channel-reporter', username: 'Reporter' },
    client,
    guild: { id: 'guild', roles: { everyone: { id: 'guild' } } },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  };

  const result = await submitReport(interaction, { db });
  assert.match(result.content, /was saved, but I could not deliver it/i);
  assert.equal(sends, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM reports').get().count, 1);
});

test('moderation commands have a persistent per-manager/per-action cooldown', async (t) => {
  const db = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = { id: 'moderator', roles: { cache: new Map([[managerRole, {}]]) } };
  const guild = { id: 'guild', ownerId: 'owner', members: { fetch: async () => manager } };
  const client = {
    user: { id: 'bot-id' },
    channels: { fetch: async () => ({
      isTextBased: () => true,
      send: async () => {},
    }) },
  };
  const interaction = (targetId) => ({
    commandName: 'mod', guild, client,
    user: { id: manager.id, username: 'Moderator' },
    options: {
      getSubcommand: () => 'warn',
      getUser: () => ({ id: targetId, username: targetId }),
      getString: () => 'Test reason',
    },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  });

  const first = await handleSafetyCommand(interaction('player-one'), { db });
  assert.match(first.content, /Warn recorded/);
  const second = await handleSafetyCommand(interaction('player-two'), { db });
  assert.match(second.content, /Moderation cooldown: try again in/);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM moderation_logs').get().count, 1);
});

function messageFactory(id, content) {
  return {
    id,
    content,
    guild: { id: 'guild' },
    channelId: 'channel',
    author: { id: 'member', username: 'Member', bot: false },
    member: { roles: { cache: new Map() } },
    mentions: { everyone: false, users: { size: 0 }, roles: { size: 0 } },
  };
}