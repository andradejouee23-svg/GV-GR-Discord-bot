const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleButton } = require('../src/buttons');
const {
  claimWorkReward,
  getEconomySettings,
  getWallet,
  handleEconomyCommand,
  resolveDeliveryGame,
  resolveDeliveryOutcome,
  rewardForDeliveryOutcome,
  startDeliveryGame,
} = require('../src/commands/economy');

const managementRoleId = '1556064708795306157';
const managerId = 'economy-manager';
const channelId = '1666064708795306156';

function makeTempDatabase(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-economy-'));
  const filename = path.join(directory, 'economy.sqlite');
  let db = createDatabase(filename);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    filename,
    get db() { return db; },
    reopen() {
      db.close();
      db = createDatabase(filename);
      return db;
    },
  };
}

function createPanelEnvironment(db) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('role_management', JSON.stringify([managementRoleId]));
  const manager = { id: managerId, roles: { cache: new Map([[managementRoleId, { id: managementRoleId, name: 'Admin' }]]) } };
  const regularPlayer = { id: 'economy-player', roles: { cache: new Map() } };
  const guild = {
    id: config.SERVER_ID,
    ownerId: 'server-owner',
    members: {
      me: {},
      fetch: async (id) => id === managerId ? manager : regularPlayer,
    },
  };
  const posts = [];
  const edits = [];
  const channel = {
    id: channelId,
    guildId: guild.id,
    isTextBased: () => true,
    permissionsFor: () => ({ has: () => true }),
    send: async (payload) => {
      posts.push(payload);
      return { id: '1776064708795306156' };
    },
    messages: { fetch: async () => ({ edit: async (payload) => { edits.push(payload); return { id: '1776064708795306156' }; } }) },
  };
  const client = { channels: { fetch: async () => channel } };
  const interaction = (subcommand, options, userId = managerId) => {
    let lastReply;
    return {
      commandName: 'economy',
      guild,
      client,
      user: { id: userId, username: userId === managerId ? 'Manager' : 'Player' },
      options: { getSubcommand: () => subcommand, ...options },
      reply: async (payload) => { lastReply = payload; return payload; },
      get lastReply() { return lastReply; },
    };
  };
  return { db, guild, client, channel, posts, edits, interaction };
}

test('wallet accounts are created lazily, use Discord IDs, and persist after reopen', (t) => {
  const store = makeTempDatabase(t);
  const userId = 'discord-user-123';
  const account = getWallet(store.db, userId, '2026-10-31T12:00:00.000Z');
  assert.equal(account.user_id, userId);
  assert.equal(account.wallet_balance, 0);
  assert.equal(account.bank_balance, 0);
  assert.equal(account.lifetime_earnings, 0);
  assert.equal(account.total_spent, 0);
  assert.equal(account.total_transferred, 0);
  assert.equal(account.created_at, '2026-10-31T12:00:00.000Z');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_accounts').get().count, 1);
  assert.throws(() => store.db.prepare('UPDATE economy_accounts SET wallet_balance = -1 WHERE user_id = ?').run(userId), /CHECK constraint failed/);

  const reopened = store.reopen();
  assert.equal(getWallet(reopened, userId).wallet_balance, 0);
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM economy_accounts').get().count, 1);
});

test('Work rewards are bounded, cooldown-safe, atomic, and survive restarts', (t) => {
  const store = makeTempDatabase(t);
  const settings = { minimumReward: 50, maximumReward: 150, cooldownMinutes: 30 };
  const start = new Date('2026-10-31T12:00:00.000Z');
  const first = claimWorkReward(store.db, 'worker-1', settings, start);
  assert.equal(first.claimed, true);
  assert.ok(first.reward >= settings.minimumReward && first.reward <= settings.maximumReward);
  assert.equal(first.account.wallet_balance, first.reward);
  assert.equal(first.account.lifetime_earnings, first.reward);
  assert.equal(first.nextClaimAt, '2026-10-31T12:30:00.000Z');

  const repeated = claimWorkReward(store.db, 'worker-1', settings, new Date('2026-10-31T12:10:00.000Z'));
  assert.equal(repeated.claimed, false);
  assert.equal(repeated.nextClaimAt, '2026-10-31T12:30:00.000Z');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'work'").get().count, 1);

  const second = claimWorkReward(store.db, 'worker-1', settings, new Date('2026-10-31T12:30:00.000Z'));
  assert.equal(second.claimed, true);
  assert.ok(second.account.wallet_balance >= settings.minimumReward * 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'work'").get().count, 2);

  const reopened = store.reopen();
  const persisted = getWallet(reopened, 'worker-1');
  assert.equal(persisted.wallet_balance, second.account.wallet_balance);
  assert.equal(persisted.lifetime_earnings, second.account.lifetime_earnings);
  assert.equal(persisted.last_work_at, '2026-10-31T12:30:00.000Z');
});

test('management configures and updates one panel; Wallet and Work stay private', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const configure = env.interaction('configure', {
    getChannel: () => env.channel,
    getInteger: (name) => ({
      'minimum-reward': 75,
      'maximum-reward': 125,
      'cooldown-minutes': 20,
      'delivery-minimum': 200,
      'delivery-maximum': 300,
      'delivery-cooldown-minutes': 45,
    }[name] ?? null),
  });
  const configured = await handleEconomyCommand(configure, { db: store.db });
  assert.match(configured.content, /Updated Economy settings/);
  assert.equal(getEconomySettings(store.db).minimumReward, 75);
  assert.equal(getEconomySettings(store.db).deliveryMaximumReward, 300);

  const panel = await handleEconomyCommand(env.interaction('panel', {}), { db: store.db });
  const refreshed = await handleEconomyCommand(env.interaction('panel', {}), { db: store.db });
  assert.match(panel.content, /posted/);
  assert.match(refreshed.content, /refreshed/);
  assert.equal(env.posts.length, 1);
  assert.equal(env.edits.length, 1);
  const panelButtons = env.posts[0].components.flatMap((row) => row.components);
  assert.deepEqual(panelButtons.map((button) => button.data.label), [
    'My Wallet', 'Work', 'Bank', 'Shop', 'Leaderboard', 'Blackjack', 'Transactions', 'Daily Rewards', 'Delivery Rush',
  ]);
  assert.deepEqual(panelButtons.map((button) => button.data.disabled), [
    undefined, undefined, true, true, true, true, true, true, undefined,
  ]);

  const account = getWallet(store.db, 'economy-player');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 300, lifetime_earnings = 300 WHERE user_id = ?').run(account.user_id);
  let walletReply;
  await handleButton({
    customId: 'gv:economy:wallet',
    user: { id: account.user_id, username: 'Player' },
    reply: async (payload) => { walletReply = payload; return payload; },
  }, { db: store.db });
  assert.equal(walletReply.ephemeral, true);
  assert.match(walletReply.embeds[0].data.description, /300 GV Credits/);

  let unauthorizedReply;
  const unauthorized = env.interaction('configure', {
    getChannel: () => null,
    getInteger: () => null,
  }, 'economy-player');
  await handleEconomyCommand(unauthorized, { db: store.db });
  unauthorizedReply = unauthorized.lastReply;
  assert.match(unauthorizedReply.content, /management roles only/i);
});

test('Delivery Rush respects cooldown, resolves once, and pays only through the existing wallet ledger', (t) => {
  const store = makeTempDatabase(t);
  const settings = { ...getEconomySettings(store.db), deliveryMinimumReward: 100, deliveryMaximumReward: 200, deliveryCooldownMinutes: 30 };
  const start = new Date('2026-10-31T15:00:00.000Z');
  assert.deepEqual(['failed', 'delayed', 'successful', 'bonus'], [
    resolveDeliveryOutcome('fast', 0),
    resolveDeliveryOutcome('safe', 20),
    resolveDeliveryOutcome('safe', 50),
    resolveDeliveryOutcome('safe', 95),
  ]);
  assert.equal(rewardForDeliveryOutcome('successful', settings, (minimum) => minimum), 100);
  assert.equal(rewardForDeliveryOutcome('bonus', settings, (minimum) => minimum), 201);
  assert.ok(rewardForDeliveryOutcome('delayed', settings, (minimum) => minimum) < settings.deliveryMinimumReward);
  assert.equal(rewardForDeliveryOutcome('failed', settings), 0);

  const game = startDeliveryGame(store.db, 'delivery-player', settings, start, () => 1);
  assert.equal(game.started, true);
  assert.ok(game.scenario);
  assert.equal(startDeliveryGame(store.db, 'delivery-player', settings, new Date(start.getTime() + 60_000)).reason, 'active');

  const unauthorized = resolveDeliveryGame(store.db, 'other-player', game.gameId, 'safe', settings, new Date(start.getTime() + 60_000));
  assert.deepEqual(unauthorized, { completed: false, reason: 'owner' });
  const result = resolveDeliveryGame(store.db, 'delivery-player', game.gameId, 'safe', settings,
    new Date(start.getTime() + 60_000), () => 50, (minimum) => minimum);
  assert.equal(result.completed, true);
  assert.equal(result.resultType, 'successful');
  assert.equal(result.reward, settings.deliveryMinimumReward);
  assert.equal(result.walletBalance, settings.deliveryMinimumReward);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'delivery_rush'").get().count, 1);

  const duplicate = resolveDeliveryGame(store.db, 'delivery-player', game.gameId, 'safe', settings,
    new Date(start.getTime() + 2 * 60_000), () => 95, (minimum) => minimum);
  assert.deepEqual(duplicate, { completed: false, reason: 'resolved' });
  assert.equal(store.db.prepare('SELECT wallet_balance FROM economy_accounts WHERE user_id = ?').get('delivery-player').wallet_balance, 100);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'delivery_rush'").get().count, 1);
  assert.equal(startDeliveryGame(store.db, 'delivery-player', settings, new Date(start.getTime() + 4 * 60_000)).reason, 'cooldown');

  const reopened = store.reopen();
  assert.equal(getWallet(reopened, 'delivery-player').wallet_balance, 100);
  assert.equal(startDeliveryGame(reopened, 'delivery-player', settings, new Date(start.getTime() + 10 * 60_000)).reason, 'cooldown');
  assert.equal(startDeliveryGame(reopened, 'delivery-player', settings, new Date(start.getTime() + 30 * 60_000)).started, true);
});

test('Delivery Rush panel button starts a private game and only its owner can choose a route', async (t) => {
  const store = makeTempDatabase(t);
  const playerId = 'delivery-button-player';
  let startReply;
  await handleButton({
    customId: 'gv:economy:delivery:start',
    user: { id: playerId, username: 'Driver' },
    reply: async (payload) => { startReply = payload; return payload; },
  }, { db: store.db });
  assert.equal(startReply.ephemeral, true);
  assert.match(startReply.embeds[0].data.title, /Delivery Rush/);
  assert.deepEqual(startReply.components[0].components.map((button) => button.data.label), ['Fast Route', 'Safe Route', 'Shortcut']);
  const choiceId = startReply.components[0].components[1].data.custom_id;

  let deniedReply;
  await handleButton({
    customId: choiceId,
    user: { id: 'another-player' },
    reply: async (payload) => { deniedReply = payload; return payload; },
  }, { db: store.db });
  assert.match(deniedReply.content, /Only the player who started/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_delivery_games WHERE status = 'active'").get().count, 1);

  let resolution;
  await handleButton({
    customId: choiceId,
    user: { id: playerId },
    update: async (payload) => { resolution = payload; return payload; },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(resolution.components.length, 0);
  assert.match(resolution.embeds[0].data.title, /Delivery|Bonus/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_delivery_games WHERE status = 'completed'").get().count, 1);
  const game = store.db.prepare('SELECT * FROM economy_delivery_games WHERE user_id = ?').get(playerId);
  const rewardTransactions = store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE user_id = ? AND type = 'delivery_rush'").get(playerId).count;
  assert.equal(rewardTransactions, game.reward > 0 ? 1 : 0);

  let duplicateReply;
  await handleButton({
    customId: choiceId,
    user: { id: playerId },
    reply: async (payload) => { duplicateReply = payload; return payload; },
  }, { db: store.db });
  assert.match(duplicateReply.content, /already completed/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE user_id = ? AND type = 'delivery_rush'").get(playerId).count, rewardTransactions);
});