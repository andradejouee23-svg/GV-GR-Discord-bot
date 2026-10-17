const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleTicketButton, handleTicketModal, handleTicketPanelCommand, ticketPanelComponents } = require('../src/commands/tickets');

function openDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-tickets-'));
  const db = createDatabase(path.join(directory, 'test.sqlite'));
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}

function makeRoleOverwrite(id, allow = 0, deny = 0) {
  return {
    id,
    type: 0,
    allow: allow ? new PermissionsBitField(allow) : new PermissionsBitField(),
    deny: deny ? new PermissionsBitField(deny) : new PermissionsBitField(),
  };
}

function mockGuild({ privateCategory = true } = {}) {
  const managementRole = '1556064708795306157';
  const botRole = 'bot-role';
  const everyone = privateCategory ? makeRoleOverwrite('ticket-guild', 0, PermissionFlagsBits.ViewChannel)
    : makeRoleOverwrite('ticket-guild', PermissionFlagsBits.ViewChannel, 0);
  const category = {
    id: '123456789012345678',
    type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: new Map([
      ['ticket-guild', everyone],
      [managementRole, makeRoleOverwrite(managementRole, PermissionFlagsBits.ViewChannel)],
      [botRole, makeRoleOverwrite(botRole, PermissionFlagsBits.ViewChannel)],
    ]) },
  };
  return {
    id: 'ticket-guild',
    roles: { everyone: { id: 'ticket-guild' } },
    members: { me: { roles: { cache: new Map([[botRole, {}]]) } } },
    channels: { fetch: async (id) => id === '123456789012345678' ? category : null },
    managementRole,
  };
}

test('ticket panel exposes the three configured private ticket types', () => {
  const ids = ticketPanelComponents()[0].components.map((button) => button.data.custom_id);
  assert.deepEqual(ids, [
    'gv:ticket:create:general',
    'gv:ticket:create:staff_application',
    'gv:ticket:create:admin_recruiting',
  ]);
});

test('management ticket-panel command persists the panel message reference', async (t) => {
  const db = openDatabase(t);
  const managerRole = '1556064708795306157';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const manager = { id: 'ticket-manager', roles: { cache: new Map([[managerRole, {}]]) } };
  const channel = {
    id: '123456789012345678',
    isTextBased: () => true,
    send: async () => ({ id: 'ticket-panel-message' }),
  };
  const interaction = {
    commandName: 'ticket-panel',
    guild: { id: 'guild', ownerId: 'owner' },
    member: manager,
    user: { id: manager.id, username: 'Manager' },
    options: { getChannel: () => channel },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  };
  const result = await handleTicketPanelCommand(interaction, { db });
  assert.match(result.content, /Ticket panel posted/);
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'ticket_panel_message'").get().value), 'ticket-panel-message');
  assert.equal(JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'ticket_panel_channel'").get().value), channel.id);
});

test('ticket creation enforces private category permissions, persists answers, and blocks duplicates', async (t) => {
  const db = openDatabase(t);
  const guild = mockGuild();
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('TICKET_SUPPORT_CATEGORY_ID', JSON.stringify('123456789012345678'));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([guild.managementRole]));
  const createdChannels = [];
  const client = {
    user: { id: 'ticket-bot' },
  };
  guild.channels.create = async (options) => {
    createdChannels.push(options);
    return {
      id: 'private-ticket-channel',
      send: async (payload) => { createdChannels.push(payload); return { id: 'ticket-panel-message' }; },
      delete: async () => {},
    };
  };
  const interaction = {
    guild,
    client,
    user: { id: 'requester', username: 'Requester' },
    fields: { getTextInputValue: (key) => ({
      subject: 'Cannot join',
      details: 'The custom server is not appearing.',
      reference: 'Player 17',
    })[key] ?? '' },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  };

  const result = await handleTicketModal({ ...interaction, customId: 'gv:ticket:submit:general' }, { db });
  assert.match(result.content, /<#[^>]+>/);
  assert.equal(createdChannels.length, 2);
  assert.equal(createdChannels[0].parent, '123456789012345678');
  assert.ok(createdChannels[0].permissionOverwrites.some((overwrite) =>
    overwrite.id === guild.id && overwrite.deny.includes(PermissionFlagsBits.ViewChannel)));
  assert.ok(createdChannels[0].permissionOverwrites.some((overwrite) => overwrite.id === 'requester'));
  assert.match(createdChannels[1].embeds[0].data.fields.find((field) => field.name === 'details').value,
    /custom server is not appearing/i);
  assert.equal(db.prepare("SELECT status FROM tickets WHERE requester_id = 'requester'").get().status, 'open');

  const duplicate = await handleTicketModal({ ...interaction, customId: 'gv:ticket:submit:general' }, { db });
  assert.match(duplicate.content, /already have an open/i);
  assert.equal(createdChannels.length, 2);
});

test('ticket creation refuses an @everyone-visible category before creating a channel', async (t) => {
  const db = openDatabase(t);
  const guild = mockGuild({ privateCategory: false });
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('TICKET_SUPPORT_CATEGORY_ID', JSON.stringify('123456789012345678'));
  const client = { user: { id: 'ticket-bot' } };
  let creates = 0;
  guild.channels.create = async () => { creates += 1; };
  const result = await handleTicketModal({
    guild, client, user: { id: 'requester', username: 'Requester' },
    customId: 'gv:ticket:submit:general',
    fields: { getTextInputValue: () => 'Support request' },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db });
  assert.match(result.content, /not private/i);
  assert.equal(creates, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM tickets').get().count, 0);
});

test('only the configured recruiting role can decide applications or view private notes', async (t) => {
  const db = openDatabase(t);
  const categoryId = '423456789012345678';
  const recruitingRoleId = '823456789012345678';
  const botRoleId = '923456789012345678';
  const category = {
    id: categoryId,
    type: ChannelType.GuildCategory,
    permissionOverwrites: { cache: new Map([
      ['ticket-guild', makeRoleOverwrite('ticket-guild', 0, PermissionFlagsBits.ViewChannel)],
      [recruitingRoleId, makeRoleOverwrite(recruitingRoleId, PermissionFlagsBits.ViewChannel)],
      [botRoleId, makeRoleOverwrite(botRoleId, PermissionFlagsBits.ViewChannel)],
    ]) },
  };
  const publicMessages = [];
  const ticketMessage = {
    id: 'recruit-ticket-message',
    edit: async (payload) => publicMessages.push(JSON.stringify(payload)),
  };
  const privateChannel = {
    id: 'recruit-ticket-channel',
    send: async (payload) => { publicMessages.push(JSON.stringify(payload)); return ticketMessage; },
    messages: { fetch: async () => ticketMessage },
  };
  const guild = {
    id: 'ticket-guild',
    roles: { everyone: { id: 'ticket-guild' } },
    members: { me: { roles: { cache: new Map([[botRoleId, {}]]) } } },
    channels: {
      fetch: async (id) => id === categoryId ? category : privateChannel,
      create: async () => privateChannel,
    },
  };
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('TICKET_RECRUITING_CATEGORY_ID', JSON.stringify(categoryId));
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_admin_recruiting', JSON.stringify([recruitingRoleId]));
  const client = { user: { id: 'ticket-bot' }, channels: { fetch: async () => privateChannel } };
  const answerFields = {
    username: 'GreenvilleUser', position: 'Administrator', availability: 'Evenings',
    experience: 'Community moderation.', scenario: 'I would follow the policy and document the report.',
  };
  const created = await handleTicketModal({
    guild, client, user: { id: 'applicant', username: 'Applicant' },
    customId: 'gv:ticket:submit:admin_recruiting',
    fields: { getTextInputValue: (key) => answerFields[key] },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db });
  assert.match(created.content, /private Admin Testing and Recruiting ticket/i);
  const ticket = db.prepare('SELECT * FROM tickets WHERE requester_id = ?').get('applicant');

  const unauthorized = {
    id: 'other-manager',
    roles: { cache: new Map([[config.OWNER_ROLE_IDS[0], {}]]) },
  };
  let denied;
  await handleTicketButton({
    customId: `gv:ticket:decision:${ticket.id}:accept`, guild, member: unauthorized,
    user: { id: unauthorized.id }, reply: async (payload) => { denied = payload; },
  }, { db });
  assert.match(denied.content, /configured recruiting role/i);

  const recruiter = { id: 'recruiter', roles: { cache: new Map([[recruitingRoleId, {}]]) } };
  const decisionModal = await handleTicketButton({
    customId: `gv:ticket:decision:${ticket.id}:accept`, guild, member: recruiter,
    user: { id: recruiter.id }, showModal: async (modal) => modal, reply: async (payload) => payload,
  }, { db });
  assert.equal(decisionModal.data.custom_id, `gv:ticket:decision_submit:${ticket.id}:accept`);

  const decision = await handleTicketModal({
    customId: decisionModal.data.custom_id, guild, member: recruiter,
    user: { id: recruiter.id }, client,
    fields: { getTextInputValue: () => 'Strong judgment and clear communication.' },
    deferReply: async () => {},
    editReply: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db });
  assert.match(decision.content, /marked accepted/i);
  assert.equal(db.prepare('SELECT status, review_note FROM tickets WHERE id = ?').get(ticket.id).status, 'accepted');
  assert.doesNotMatch(publicMessages.join('\n'), /Strong judgment and clear communication/);

  let noteReply;
  await handleTicketButton({
    customId: `gv:ticket:review_note:${ticket.id}`, guild, member: recruiter,
    user: { id: recruiter.id }, reply: async (payload) => { noteReply = payload; },
  }, { db });
  assert.equal(noteReply.content, 'Strong judgment and clear communication.');
});

test('closing a ticket confirms, locks the requester, and sends transcripts only to a private channel', async (t) => {
  const db = openDatabase(t);
  const requesterId = 'ticket-requester';
  const ticketId = Number(db.prepare(`INSERT INTO tickets
    (ticket_type, requester_id, requester_name, subject, answers_json, channel_id, panel_message_id, status, created_at, updated_at)
    VALUES ('general', ?, 'Requester', 'Support issue', '{"details":"Sensitive details"}', 'ticket-channel', 'ticket-message', 'open', ?, ?)`)
    .run(requesterId, new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('TICKET_TRANSCRIPT_CHANNEL_ID', JSON.stringify('823456789012345678'));
  const sentTranscripts = [];
  const managerRole = '1556064708795306157';
  const botRole = '923456789012345678';
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managerRole]));
  const ticketMessage = { edit: async () => {} };
  const ticketChannel = {
    isTextBased: () => true,
    permissionOverwrites: { edit: async () => {} },
    send: async () => {},
    messages: {
      fetch: async (value) => value === 'ticket-message' ? ticketMessage : {
        values: () => [{ createdAt: new Date(), author: { username: 'Requester' }, content: 'Sensitive details' }][Symbol.iterator](),
      },
    },
  };
  const transcriptChannel = {
    isTextBased: () => true,
    send: async (payload) => sentTranscripts.push(payload),
    permissionOverwrites: { cache: new Map([
      ['ticket-guild', makeRoleOverwrite('ticket-guild', 0, PermissionFlagsBits.ViewChannel)],
      [managerRole, makeRoleOverwrite(managerRole, PermissionFlagsBits.ViewChannel)],
      [botRole, makeRoleOverwrite(botRole, PermissionFlagsBits.ViewChannel)],
    ]) },
  };
  const client = { channels: { fetch: async (id) => id === 'ticket-channel' ? ticketChannel : transcriptChannel } };
  const guild = {
    id: 'ticket-guild',
    roles: { everyone: { id: 'ticket-guild' } },
    members: { me: { roles: { cache: new Map([[botRole, {}]]) } } },
  };
  const requester = { id: requesterId, roles: { cache: new Map() } };
  let confirmation;
  await handleTicketButton({
    customId: `gv:ticket:close:${ticketId}`, guild, member: requester,
    user: { id: requesterId }, reply: async (payload) => { confirmation = payload; },
  }, { db });
  assert.equal(confirmation.ephemeral, true);

  let closedReply;
  await handleTicketButton({
    customId: `gv:ticket:close_confirm:${ticketId}`, guild, member: requester,
    user: { id: requesterId }, client,
    deferUpdate: async () => {},
    editReply: async (payload) => { closedReply = payload; },
    reply: async (payload) => { closedReply = payload; },
  }, { db });
  assert.match(closedReply.content, /closed/i);
  assert.equal(db.prepare('SELECT status, closed_by FROM tickets WHERE id = ?').get(ticketId).status, 'closed');
  assert.equal(db.prepare('SELECT closed_by FROM tickets WHERE id = ?').get(ticketId).closed_by, requesterId);
  assert.equal(sentTranscripts.length, 1);
  assert.equal(sentTranscripts[0].files[0].name, `ticket-${ticketId}-transcript.txt`);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action = 'ticket_closed'").get().count, 1);
});