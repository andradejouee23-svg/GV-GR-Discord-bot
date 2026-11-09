const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const config = require('../config');
const { createDatabase } = require('../src/database');
const { handleButton } = require('../src/buttons');
const {
  claimDailyReward,
  claimEconomyCashDrop,
  claimWorkReward,
  createManualEconomyCashDrop,
  createShopItem,
  depositToBank,
  editShopItem,
  getEconomyLeaderboard,
  getEconomySettings,
  getWallet,
  handleEconomyCommand,
  handleEconomyManagementButton,
  handleEconomyManagementSelect,
  handleEconomyModal,
  purchaseShopItem,
  processEconomyCashDrops,
  removeShopItem,
  resolveDeliveryGame,
  resolveDeliveryOutcome,
  rewardForDeliveryOutcome,
  startDeliveryGame,
  transferToPlayer,
  withdrawFromBank,
} = require('../src/commands/economy');
const { setConfigValue } = require('../src/utils/discord');

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
  setConfigValue(db, 'ECONOMY_MANAGEMENT_ROLE_ID', managementRoleId);
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

test('new accounts begin with the default balance and support daily reward, bank, and transfer flows', (t) => {
  const store = makeTempDatabase(t);
  setConfigValue(store.db, 'ECONOMY_STARTING_BALANCE', 500);
  const settings = getEconomySettings(store.db);
  const starter = getWallet(store.db, 'starter-user', '2026-11-01T12:00:00.000Z');
  assert.equal(starter.wallet_balance, settings.startingBalance);
  assert.equal(starter.bank_balance, 0);

  const reward = claimDailyReward(store.db, 'starter-user', settings, new Date('2026-11-01T12:00:00.000Z'));
  assert.equal(reward.claimed, true);
  assert.equal(reward.amount, settings.dailyReward);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'daily_reward'").get().count, 1);

  const denied = claimDailyReward(store.db, 'starter-user', settings, new Date('2026-11-01T18:00:00.000Z'));
  assert.equal(denied.claimed, false);

  const deposited = depositToBank(store.db, 'starter-user', 150, 'testing deposit', '2026-11-01T20:00:00.000Z');
  assert.equal(deposited.walletAfter, settings.startingBalance + settings.dailyReward - 150);
  assert.equal(deposited.bankAfter, 150);

  const recipient = getWallet(store.db, 'recipient-user', '2026-11-01T21:00:00.000Z');
  const transferred = transferToPlayer(store.db, 'starter-user', 'recipient-user', 50, 'thanks', '2026-11-01T21:05:00.000Z', 'transfer-request-1');
  assert.equal(transferred.sender.wallet_balance, deposited.walletAfter - 50);
  assert.equal(transferred.recipient.wallet_balance, recipient.wallet_balance + 50);
  const repeatedTransfer = transferToPlayer(store.db, 'starter-user', 'recipient-user', 50, 'thanks', '2026-11-01T21:05:00.000Z', 'transfer-request-1');
  assert.equal(repeatedTransfer.duplicate, true);
  assert.equal(repeatedTransfer.sender.wallet_balance, transferred.sender.wallet_balance);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'player_transfer'").get().count, 1);

  const withdrew = withdrawFromBank(store.db, 'starter-user', 25, 'withdraw-test', '2026-11-01T21:10:00.000Z');
  assert.equal(withdrew.walletAfter, transferred.sender.wallet_balance + 25);

  const itemId = createShopItem(store.db, { name: 'Coffee', description: 'Warm drink', price: 120, stock: 3, category: 'Food', imageUrl: 'https://example.com/coffee.png', enabled: true, purchaseLimit: 2 }, 'admin-1');
  assert.ok(itemId);
  assert.equal(editShopItem(store.db, itemId, { price: 100 }, 'admin-1').updated, true);
  const purchase = purchaseShopItem(store.db, 'starter-user', itemId, 1, '2026-11-01T21:30:00.000Z', 'purchase-request-1');
  assert.equal(purchase.purchased, true);
  const repeatedPurchase = purchaseShopItem(store.db, 'starter-user', itemId, 1, '2026-11-01T21:30:00.000Z', 'purchase-request-1');
  assert.equal(repeatedPurchase.duplicate, true);
  assert.equal(store.db.prepare('SELECT stock FROM economy_shop_items WHERE id = ?').get(itemId).stock, 2);
  assert.equal(store.db.prepare('SELECT quantity FROM economy_inventory WHERE user_id = ? AND item_id = ?').get('starter-user', itemId).quantity, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'shop_purchase'").get().count, 1);
  assert.equal(removeShopItem(store.db, itemId, 'admin-1').removed, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_shop_items WHERE id = ? AND deleted = 0').get(itemId).count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_purchase_history WHERE item_id = ?').get(itemId).count, 1);
});

test('default Town Job and vehicle exception review products are visible, purchasable, and seeded once', async (t) => {
  const store = makeTempDatabase(t);
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  ];
  const items = store.db.prepare('SELECT * FROM economy_shop_items WHERE id IN (?, ?) ORDER BY id').all(...ids);
  assert.equal(items.length, 2);
  assert.match(items[0].name, /Town Job Upgrade Request/);
  assert.match(items[0].description, /staff approval is required/i);
  assert.match(items[1].name, /Blacklisted Vehicle Exception Review/);
  assert.match(items[1].description, /does not bypass blacklist status/i);

  const account = getWallet(store.db, 'catalog-player');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 2000 WHERE user_id = ?').run(account.user_id);
  const env = createPanelEnvironment(store.db);
  const listing = await handleEconomyCommand(env.interaction('shop', {}, account.user_id), { db: store.db });
  assert.match(listing.embeds[0].data.description, /Town Job Upgrade Request/);
  assert.match(listing.embeds[0].data.description, /Blacklisted Vehicle Exception Review/);
  const buyId = listing.components.flatMap((row) => row.components)
    .find((button) => button.data.custom_id === `gv:economy:shop:buy:${ids[0]}`).data.custom_id;
  let purchasePrompt;
  await handleButton({
    customId: buyId,
    user: { id: account.user_id },
    reply: async (payload) => { purchasePrompt = payload; return payload; },
  }, { db: store.db });
  assert.match(purchasePrompt.embeds[0].data.description, /\*\*Price:\*\* \$500/);
  assert.deepEqual(purchasePrompt.components[0].components.map((button) => button.data.label), ['Confirm Purchase', 'Cancel']);
  assert.equal(getWallet(store.db, account.user_id).wallet_balance, 2000);
  assert.equal(store.db.prepare('SELECT stock FROM economy_shop_items WHERE id = ?').get(ids[0]).stock, 100);
  let duplicatePrompt;
  await handleButton({
    customId: buyId,
    user: { id: account.user_id },
    reply: async (payload) => { duplicatePrompt = payload; return payload; },
  }, { db: store.db });
  assert.match(duplicatePrompt.content, /pending confirmation/);
  const cancelId = purchasePrompt.components[0].components[1].data.custom_id;
  let cancelled;
  await handleButton({
    customId: cancelId,
    user: { id: account.user_id },
    update: async (payload) => { cancelled = payload; return payload; },
  }, { db: store.db });
  assert.match(cancelled.content, /cancelled/i);
  assert.equal(getWallet(store.db, account.user_id).wallet_balance, 2000);

  const commandPurchase = await handleEconomyCommand(env.interaction('purchase', {
    getString: () => ids[0],
    getInteger: () => 1,
  }, account.user_id), { db: store.db });
  assert.deepEqual(commandPurchase.components[0].components.map((button) => button.data.label), ['Confirm Purchase', 'Cancel']);
  assert.equal(getWallet(store.db, account.user_id).wallet_balance, 2000);
  await handleButton({
    customId: commandPurchase.components[0].components[1].data.custom_id,
    user: { id: account.user_id },
    update: async () => ({}),
  }, { db: store.db });

  let secondPrompt;
  await handleButton({ customId: buyId, user: { id: account.user_id }, reply: async (payload) => { secondPrompt = payload; return payload; } }, { db: store.db });
  let purchaseReply;
  const confirmId = secondPrompt.components[0].components[0].data.custom_id;
  await handleButton({
    customId: confirmId,
    user: { id: account.user_id },
    update: async (payload) => { purchaseReply = payload; return payload; },
  }, { db: store.db });
  assert.match(purchaseReply.content, /Purchase complete/);
  assert.equal(store.db.prepare('SELECT quantity FROM economy_inventory WHERE user_id = ? AND item_id = ?').get(account.user_id, ids[0]).quantity, 1);
  assert.equal(getWallet(store.db, account.user_id).wallet_balance, 1500);

  const reopened = store.reopen();
  assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM economy_shop_items WHERE id IN (?, ?)').get(...ids).count, 2);
  assert.equal(reopened.prepare('SELECT stock FROM economy_shop_items WHERE id = ?').get(ids[0]).stock, 99);
});

test('cash drops recover pending posts after restart, follow persisted intervals, and pay each player once', async (t) => {
  const store = makeTempDatabase(t);
  const channelIdForDrop = '1666064708795306156';
  setConfigValue(store.db, 'ECONOMY_CASH_DROP_CHANNEL_ID', channelIdForDrop);
  setConfigValue(store.db, 'ECONOMY_CASH_DROP_MAX_CLAIMS', 1);
  setConfigValue(store.db, 'ECONOMY_CASH_DROP_LIFETIME_MINUTES', 1440);
  const sends = [];
  const unavailableClient = { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => { throw new Error('temporary outage'); } }) } };
  const start = new Date(Date.now() - 60_000);
  const failedPost = await processEconomyCashDrops(unavailableClient, store.db, start);
  assert.deepEqual({ posted: failedPost.posted, reason: failedPost.reason }, { posted: false, reason: 'post' });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_cash_drops WHERE status = 'pending'").get().count, 1);

  const reopened = store.reopen();
  const updatedDrops = [];
  const workingClient = {
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async (payload) => {
          sends.push(payload);
          return { id: `drop-message-${sends.length}` };
        },
        messages: { fetch: async () => ({ edit: async (payload) => { updatedDrops.push(payload); return payload; } }) },
      }),
    },
  };
  const recovered = await processEconomyCashDrops(workingClient, reopened, new Date(start.getTime() + 60_000));
  assert.equal(recovered.posted, true);
  assert.equal(sends.length, 1);
  const firstDrop = reopened.prepare('SELECT * FROM economy_cash_drops WHERE drop_id = ?').get(recovered.dropId);
  assert.equal(firstDrop.status, 'open');
  assert.equal(firstDrop.message_id, 'drop-message-1');
  assert.notEqual(sends[0].embeds[0].data.color, config.EMBED_COLORS.error);
  assert.equal(sends[0].components[0].components[0].data.disabled, false);

  let claimReply;
  await handleButton({
    customId: `gv:economy:drop:claim:${recovered.dropId}`,
    user: { id: 'cash-player' },
    message: { edit: async () => ({}) },
    client: workingClient,
    reply: async (payload) => { claimReply = payload; return payload; },
  }, { db: reopened });
  assert.match(claimReply.content, /Cash drop claimed/);
  const claimed = reopened.prepare('SELECT * FROM economy_cash_drops WHERE drop_id = ?').get(recovered.dropId);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.claimed_by, 'cash-player');
  assert.ok(claimed.claimed_at);
  assert.equal(updatedDrops[0].embeds[0].data.color, config.EMBED_COLORS.error);
  assert.match(updatedDrops[0].embeds[0].data.description, /<@cash-player>/);
  assert.equal(updatedDrops[0].components[0].components[0].data.label, 'Claimed');
  assert.equal(updatedDrops[0].components[0].components[0].data.disabled, true);
  assert.equal(claimEconomyCashDrop(reopened, recovered.dropId, 'cash-player', new Date(start.getTime() + 3 * 60_000)).reason, 'closed');
  assert.equal(claimEconomyCashDrop(reopened, recovered.dropId, 'another-player', new Date(start.getTime() + 3 * 60_000)).reason, 'closed');
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'cash_drop'").get().count, 1);

  reopened.prepare('UPDATE economy_cash_drops SET claimed_message_updated_at = NULL WHERE drop_id = ?').run(recovered.dropId);
  const restarted = store.reopen();
  await processEconomyCashDrops(workingClient, restarted, new Date(start.getTime() + 4 * 60_000));
  assert.ok(restarted.prepare('SELECT claimed_message_updated_at FROM economy_cash_drops WHERE drop_id = ?').get(recovered.dropId).claimed_message_updated_at);

  const notDue = await processEconomyCashDrops(workingClient, restarted, new Date(start.getTime() + 14 * 60_000));
  assert.equal(notDue.reason, 'not-due');
  const stillWaiting = await processEconomyCashDrops(workingClient, restarted, new Date(start.getTime() + 15 * 60_000));
  assert.equal(stillWaiting.reason, 'not-due');
  const nextDrop = await processEconomyCashDrops(workingClient, restarted, new Date(start.getTime() + 16 * 60_000));
  assert.equal(nextDrop.posted, true);
  assert.equal(sends.length, 2);
});

test('Discord shop, bank, inventory, and transaction controls reach their persisted handlers', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const itemId = createShopItem(store.db, { name: 'GV Hoodie', description: 'Community merch', price: 75, stock: 2, imageUrl: 'https://example.com/hoodie.png' }, managerId);
  const account = getWallet(store.db, 'economy-player');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 300 WHERE user_id = ?').run(account.user_id);

  const shop = await handleEconomyCommand(env.interaction('shop', {}, 'economy-player'), { db: store.db });
  assert.equal(shop.ephemeral, true);
  assert.match(shop.embeds[0].data.description, /GV Hoodie/);
  assert.doesNotMatch(shop.embeds[0].data.description, new RegExp(itemId));
  const buyId = shop.components[0].components[0].data.custom_id;
  assert.equal(buyId, `gv:economy:shop:buy:${itemId}`);
  let prompt;
  await handleButton({ customId: buyId, id: 'shop-buy-1', user: { id: 'economy-player' }, reply: async (payload) => { prompt = payload; return payload; } }, { db: store.db });
  assert.match(prompt.embeds[0].data.description, /Community merch/);
  assert.match(prompt.embeds[0].data.description, /\*\*Price:\*\* \$75/);
  assert.equal(prompt.embeds[0].data.image.url, 'https://example.com/hoodie.png');
  assert.deepEqual(prompt.components[0].components.map((button) => button.data.label), ['Confirm Purchase', 'Cancel']);
  assert.equal(getWallet(store.db, 'economy-player').wallet_balance, 300);
  let cancelled;
  await handleButton({ customId: prompt.components[0].components[1].data.custom_id, user: { id: 'economy-player' }, update: async (payload) => { cancelled = payload; return payload; } }, { db: store.db });
  assert.match(cancelled.content, /cancelled/i);
  assert.equal(getWallet(store.db, 'economy-player').wallet_balance, 300);
  let secondPrompt;
  await handleButton({ customId: buyId, id: 'shop-buy-2', user: { id: 'economy-player' }, reply: async (payload) => { secondPrompt = payload; return payload; } }, { db: store.db });
  let buyReply;
  const confirmId = secondPrompt.components[0].components[0].data.custom_id;
  await handleButton({ customId: confirmId, id: 'shop-confirm-1', user: { id: 'economy-player' }, update: async (payload) => { buyReply = payload; return payload; } }, { db: store.db });
  assert.match(buyReply.content, /Purchase complete/);
  assert.equal(getWallet(store.db, 'economy-player').wallet_balance, 225);

  const inventory = await handleEconomyCommand(env.interaction('inventory', {}, 'economy-player'), { db: store.db });
  assert.match(inventory.embeds[0].data.description, /GV Hoodie/);
  const history = await handleEconomyCommand(env.interaction('history', {}, 'economy-player'), { db: store.db });
  assert.match(history.embeds[0].data.description, /GV Hoodie/);
  const transactions = await handleEconomyCommand(env.interaction('transactions', { getUser: () => null }, 'economy-player'), { db: store.db });
  assert.match(transactions.embeds[0].data.description, /shop purchase/);

  let bankReply;
  await handleButton({ customId: 'gv:economy:bank', user: { id: 'economy-player' }, reply: async (payload) => { bankReply = payload; return payload; } }, { db: store.db });
  assert.deepEqual(bankReply.components[0].components.map((button) => button.data.label), ['Deposit', 'Withdraw']);
  let shownModal;
  await handleButton({ customId: 'gv:economy:bank:deposit', showModal: async (modal) => { shownModal = modal; } }, { db: store.db });
  assert.equal(shownModal.data.custom_id, 'gv:economy:modal:bank:deposit');
  let modalReply;
  await handleEconomyModal({
    customId: shownModal.data.custom_id,
    user: { id: 'economy-player' },
    fields: { getTextInputValue: () => '100' },
    reply: async (payload) => { modalReply = payload; return payload; },
  }, { db: store.db });
  assert.match(modalReply.content, /Deposited \$100/);
  assert.equal(getWallet(store.db, 'economy-player').bank_balance, 100);
  const invalidDeposit = await handleEconomyCommand(env.interaction('deposit', {
    getInteger: () => 10000,
    getString: () => null,
  }, 'economy-player'), { db: store.db });
  assert.match(invalidDeposit.content, /not have enough wallet cash/);
});

test('economy purchase slash command resolves product names and only charges after confirmation', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const itemId = createShopItem(store.db, { name: 'Greenville Tow Truck Job', description: 'Request a job review.', price: 80, stock: 3 }, managerId);
  const account = getWallet(store.db, 'slash-shop-player');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 200 WHERE user_id = ?').run(account.user_id);
  const started = await handleEconomyCommand(env.interaction('purchase', {
    getString: (name) => name === 'product' ? 'Greenville Tow Truck Job' : null,
    getInteger: () => 1,
  }, account.user_id), { db: store.db });
  assert.match(started.embeds[0].data.title, /Confirm Purchase/);
  assert.equal(getWallet(store.db, account.user_id).wallet_balance, 200);
  assert.equal(store.db.prepare('SELECT stock FROM economy_shop_items WHERE id = ?').get(itemId).stock, 3);

  const confirmationId = started.components[0].components[0].data.custom_id;
  let confirmed;
  await handleButton({
    customId: confirmationId,
    user: { id: account.user_id },
    interaction: { id: 'slash-confirm-1' },
    id: 'slash-confirm-1',
    update: async (payload) => { confirmed = payload; return payload; },
  }, { db: store.db });
  assert.match(confirmed.content, /\$80/);
  assert.equal(getWallet(store.db, account.user_id).wallet_balance, 120);
  assert.equal(store.db.prepare('SELECT stock FROM economy_shop_items WHERE id = ?').get(itemId).stock, 2);
});

test('economy leaderboard ranks combined wallet and bank wealth and is available from Discord', async (t) => {
  const store = makeTempDatabase(t);
  for (const [userId, wallet, bank] of [['wallet-rich', 900, 0], ['bank-rich', 100, 2500]]) {
    getWallet(store.db, userId);
    store.db.prepare('UPDATE economy_accounts SET wallet_balance = ?, bank_balance = ? WHERE user_id = ?').run(wallet, bank, userId);
  }
  const rows = getEconomyLeaderboard(store.db);
  assert.equal(rows[0].user_id, 'bank-rich');
  assert.equal(getEconomyLeaderboard(store.db, 10, 'wallet')[0].user_id, 'wallet-rich');
  assert.equal(getEconomyLeaderboard(store.db, 10, 'bank')[0].user_id, 'bank-rich');
  store.db.prepare('UPDATE economy_accounts SET lifetime_earnings = ? WHERE user_id = ?').run(300, 'wallet-rich');
  store.db.prepare('UPDATE economy_accounts SET lifetime_earnings = ? WHERE user_id = ?').run(500, 'bank-rich');
  assert.equal(getEconomyLeaderboard(store.db, 10, 'earnings')[0].user_id, 'bank-rich');
  assert.throws(() => getEconomyLeaderboard(store.db, 10, 'invalid'), /Choose wealth, wallet, bank, or earnings/);
  const env = createPanelEnvironment(store.db);
  const leaderboard = await handleEconomyCommand(env.interaction('leaderboard', {}, 'economy-player'), { db: store.db });
  assert.match(leaderboard.embeds[0].data.description, /<@bank-rich>.*Total \$2,600/);
  const walletLeaderboard = await handleEconomyCommand(env.interaction('leaderboard', { getString: () => 'wallet' }, 'economy-player'), { db: store.db });
  assert.match(walletLeaderboard.embeds[0].data.title, /Wallet balance/);
  assert.match(walletLeaderboard.embeds[0].data.description, /<@wallet-rich>.*Wallet balance \$900/);
});

test('economy game slash commands and decision buttons connect to persistent game state', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const playerId = 'economy-player';
  const account = getWallet(store.db, playerId);
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 2000 WHERE user_id = ?').run(account.user_id);

  const coin = await handleEconomyCommand(env.interaction('coinflip', {
    getInteger: () => 100,
    getString: () => 'heads',
  }, playerId), { db: store.db });
  assert.match(coin.embeds[0].data.title, /Coin Flip/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_games WHERE game_type = 'coinflip' AND status IN ('won', 'lost')").get().count, 1);

  const roulette = await handleEconomyCommand(env.interaction('roulette', {
    getInteger: () => 100,
    getString: () => 'red',
  }, playerId), { db: store.db });
  assert.match(roulette.embeds[0].data.title, /Roulette/);

  const blackjack = await handleEconomyCommand(env.interaction('blackjack', { getInteger: () => 100 }, playerId), { db: store.db });
  assert.match(blackjack.embeds[0].data.title, /Blackjack/);
  assert.equal(blackjack.components.length, blackjack.embeds[0].data.description.includes('Payout') ? 0 : 1);
  if (blackjack.components.length) {
    const standId = blackjack.components[0].components[1].data.custom_id;
    let denied;
    await handleButton({ customId: standId, user: { id: 'another-player' }, reply: async (payload) => { denied = payload; return payload; } }, { db: store.db });
    assert.match(denied.content, /Only the player who started/);
    let settled;
    await handleButton({ customId: standId, user: { id: playerId }, update: async (payload) => { settled = payload; return payload; } }, { db: store.db });
    assert.equal(settled.components.length, 0);
  }

  let modal;
  await handleButton({ customId: 'gv:economy:chicken', showModal: async (value) => { modal = value; } }, { db: store.db });
  assert.equal(modal.data.custom_id, 'gv:economy:modal:game:chicken');
  let chickenStart;
  await handleEconomyModal({
    customId: modal.data.custom_id,
    user: { id: playerId },
    fields: { getTextInputValue: (key) => key === 'bet' ? '100' : '' },
    reply: async (payload) => { chickenStart = payload; return payload; },
  }, { db: store.db });
  assert.match(chickenStart.embeds[0].data.title, /Chicken Road/);
  assert.equal(chickenStart.components.length, 1);
  const stepId = chickenStart.components[0].components[0].data.custom_id;
  let chickenProgress;
  await handleButton({ customId: stepId, user: { id: playerId }, update: async (payload) => { chickenProgress = payload; return payload; } }, { db: store.db });
  assert.match(chickenProgress.embeds[0].data.title, /Chicken Road/);
  if (chickenProgress.components.length) {
    let cashedOut;
    await handleButton({ customId: chickenProgress.components[0].components[1].data.custom_id, user: { id: playerId }, update: async (payload) => { cashedOut = payload; return payload; } }, { db: store.db });
    assert.equal(cashedOut.components.length, 0);
  }
});

test('management dashboard exposes economy controls and persists settings, adjustments, and audit history', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const economyRoleId = '1666064708795306198';
  setConfigValue(store.db, 'ECONOMY_MANAGEMENT_ROLE_ID', economyRoleId);
  let deniedDashboard;
  await handleEconomyManagementButton({
    customId: 'mgmt:economy',
    guild: env.guild,
    user: { id: managerId },
    update: async () => { throw new Error('Unauthorized member reached Economy controls.'); },
    reply: async (payload) => { deniedDashboard = payload; return payload; },
  }, { db: store.db });
  assert.match(deniedDashboard.content, /configured Economy Management role/i);

  const configuredRole = await handleEconomyCommand(env.interaction('access-role', {
    getRole: () => ({ id: economyRoleId }),
  }), { db: store.db });
  assert.match(configuredRole.content, /restricted to/);
  const manager = await env.guild.members.fetch(managerId);
  manager.roles.cache.set(economyRoleId, { id: economyRoleId, name: 'Economy' });
  let dashboard;
  await handleEconomyManagementButton({
    customId: 'mgmt:economy',
    guild: env.guild,
    user: { id: managerId },
    update: async (payload) => { dashboard = payload; return payload; },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.match(dashboard.embeds[0].data.title, /Economy Management/);
  assert.ok(dashboard.components.flatMap((row) => row.components).some((button) => button.data.custom_id === 'gv:economy:staff:balance'));

  let settingsModal;
  await handleEconomyManagementButton({
    customId: 'gv:economy:staff:settings',
    guild: env.guild,
    user: { id: managerId },
    showModal: async (modal) => { settingsModal = modal; },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(settingsModal.data.custom_id, 'gv:economy:modal:staff-settings');
  const settingsValues = { 'drop-amount': '400', 'drop-interval': '15', 'drop-claims': '8', 'panel-color': '#123ABC', 'shop-color': '#ABCDEF' };
  await handleEconomyModal({
    customId: settingsModal.data.custom_id,
    guild: env.guild,
    user: { id: managerId },
    fields: { getTextInputValue: (key) => settingsValues[key] },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(getEconomySettings(store.db).cashDropAmount, 400);
  assert.equal(getEconomySettings(store.db).panelColor, 0x123abc);
  assert.equal(getEconomySettings(store.db).shopColor, 0xabcdef);

  let workModal;
  await handleEconomyManagementButton({
    customId: 'gv:economy:staff:work-rewards',
    guild: env.guild,
    user: { id: managerId },
    showModal: async (modal) => { workModal = modal; },
    reply: async (payload) => payload,
  }, { db: store.db });
  const workValues = { 'work-min': '60', 'work-max': '160', 'daily-amount': '300', 'daily-cooldown': '24' };
  await handleEconomyModal({
    customId: workModal.data.custom_id,
    guild: env.guild,
    user: { id: managerId },
    fields: { getTextInputValue: (key) => workValues[key] },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(getEconomySettings(store.db).minimumReward, 60);
  assert.equal(getEconomySettings(store.db).dailyReward, 300);

  await handleEconomyManagementButton({
    customId: 'gv:economy:staff:products',
    guild: env.guild,
    user: { id: managerId },
    update: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db: store.db });
  let addProductModal;
  await handleEconomyManagementButton({
    customId: 'gv:economy:staff:add-product',
    guild: env.guild,
    user: { id: managerId },
    showModal: async (modal) => { addProductModal = modal; },
    reply: async (payload) => payload,
  }, { db: store.db });
  const productValues = { name: 'GV Hoodie', price: '125', stock: '5', description: 'Community hoodie', category: 'Merch' };
  await handleEconomyModal({
    customId: addProductModal.data.custom_id,
    guild: env.guild,
    user: { id: managerId },
    fields: { getTextInputValue: (key) => productValues[key] },
    reply: async (payload) => payload,
  }, { db: store.db });
  const createdItem = store.db.prepare('SELECT * FROM economy_shop_items WHERE name = ?').get('GV Hoodie');
  assert.ok(createdItem);

  let selectedProduct;
  await handleEconomyManagementSelect({
    customId: 'gv:economy:staff:product-select',
    values: [createdItem.id],
    guild: env.guild,
    user: { id: managerId },
    update: async (payload) => { selectedProduct = payload; return payload; },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.match(selectedProduct.embeds[0].data.description, /Community hoodie/);
  const imageId = selectedProduct.components[0].components[3].data.custom_id;
  let imageModal;
  await handleEconomyManagementButton({
    customId: imageId,
    guild: env.guild,
    user: { id: managerId },
    showModal: async (modal) => { imageModal = modal; },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(imageModal.data.custom_id, `gv:economy:modal:staff-product-image:${createdItem.id}`);
  const imageReply = await handleEconomyModal({
    customId: imageModal.data.custom_id,
    guild: env.guild,
    user: { id: managerId },
    fields: { getTextInputValue: () => 'https://example.com/product.png' },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.match(imageReply.content, /Image saved/);
  assert.equal(store.db.prepare('SELECT image_url FROM economy_shop_items WHERE id = ?').get(createdItem.id).image_url, 'https://example.com/product.png');
  let editProductModal;
  await handleEconomyManagementButton({
    customId: selectedProduct.components[0].components[0].data.custom_id,
    guild: env.guild,
    user: { id: managerId },
    showModal: async (modal) => { editProductModal = modal; },
    reply: async (payload) => payload,
  }, { db: store.db });
  const editedValues = { name: 'GV Hoodie v2', price: '150', stock: '4', description: 'Updated hoodie', category: 'Merchandise' };
  await handleEconomyModal({
    customId: editProductModal.data.custom_id,
    guild: env.guild,
    user: { id: managerId },
    fields: { getTextInputValue: (key) => editedValues[key] },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(store.db.prepare('SELECT name FROM economy_shop_items WHERE id = ?').get(createdItem.id).name, 'GV Hoodie v2');
  const disableId = selectedProduct.components[0].components[1].data.custom_id;
  await handleEconomyManagementButton({
    customId: disableId,
    guild: env.guild,
    user: { id: managerId },
    update: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(store.db.prepare('SELECT enabled FROM economy_shop_items WHERE id = ?').get(createdItem.id).enabled, 0);
  await handleEconomyManagementButton({
    customId: `gv:economy:staff:product:remove:${createdItem.id}`,
    guild: env.guild,
    user: { id: managerId },
    update: async (payload) => payload,
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.equal(store.db.prepare('SELECT deleted FROM economy_shop_items WHERE id = ?').get(createdItem.id).deleted, 1);

  const targetId = '1666064708795306158';
  let adjustment;
  await handleEconomyModal({
    customId: 'gv:economy:modal:staff-balance',
    guild: env.guild,
    user: { id: managerId },
    fields: { getTextInputValue: (key) => ({ 'user-id': targetId, amount: '75', reason: 'Economy test credit' }[key]) },
    reply: async (payload) => { adjustment = payload; return payload; },
  }, { db: store.db });
  assert.match(adjustment.content, /Adjusted/);
  assert.equal(getWallet(store.db, targetId).wallet_balance, 75);
  const commandAdjustment = await handleEconomyCommand(env.interaction('admin', {
    getUser: () => ({ id: targetId }),
    getInteger: () => 25,
    getString: () => 'Command adjustment test',
  }), { db: store.db });
  assert.match(commandAdjustment.content, /Updated <@1666064708795306158>/);
  assert.equal(getWallet(store.db, targetId).wallet_balance, 100);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action LIKE 'economy_%'").get().count, 10);
  const reopened = store.reopen();
  assert.equal(getEconomySettings(reopened).cashDropAmount, 400);
  assert.equal(getEconomySettings(reopened).minimumReward, 60);
  assert.equal(getEconomySettings(reopened).panelColor, 0x123abc);
  assert.equal(getEconomySettings(reopened).shopColor, 0xabcdef);
});

test('staff economy controls publish manual drops, recover pending drops, and review purchases and transactions', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  setConfigValue(store.db, 'ECONOMY_CASH_DROP_CHANNEL_ID', channelId);
  const button = (customId) => ({
    customId,
    guild: env.guild,
    user: { id: managerId },
    update: async (payload) => payload,
    reply: async (payload) => payload,
  });

  const manualModal = await handleEconomyManagementButton({
    ...button('gv:economy:staff:manual-drop'),
    showModal: async (modal) => modal,
  }, { db: store.db });
  assert.equal(manualModal.data.custom_id, 'gv:economy:modal:staff-drop');
  const manualReply = await handleEconomyModal({
    customId: manualModal.data.custom_id,
    guild: env.guild,
    client: env.client,
    user: { id: managerId },
    fields: { getTextInputValue: (key) => ({ amount: '450', claims: '3' })[key] },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.match(manualReply.content, /Manual cash drop posted/);
  const postedDrop = store.db.prepare('SELECT * FROM economy_cash_drops ORDER BY created_at DESC LIMIT 1').get();
  assert.equal(postedDrop.status, 'open');
  assert.equal(postedDrop.amount, 450);
  assert.equal(postedDrop.max_claims, 3);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'ECONOMY_CASH_DROP_NEXT_AT'").get().count, 0);

  const gameSettingsModal = await handleEconomyManagementButton({
    ...button('gv:economy:staff:game-settings'),
    showModal: async (modal) => modal,
  }, { db: store.db });
  const gameSettingsReply = await handleEconomyModal({
    customId: gameSettingsModal.data.custom_id,
    guild: env.guild,
    user: { id: managerId },
    fields: { getTextInputValue: (key) => ({ 'game-max-bet': '5000', 'delivery-min': '125', 'delivery-max': '275', 'delivery-cooldown': '40' })[key] },
    reply: async (payload) => payload,
  }, { db: store.db });
  assert.match(gameSettingsReply.content, /Game wager and Delivery Rush/);
  assert.equal(getEconomySettings(store.db).maximumBet, 5000);
  assert.equal(getEconomySettings(store.db).deliveryMinimumReward, 125);
  assert.equal(getEconomySettings(store.db).deliveryMaximumReward, 275);
  assert.equal(getEconomySettings(store.db).deliveryCooldownMinutes, 40);

  const productId = createShopItem(store.db, { name: 'Review Item', price: 40, stock: 2 }, managerId);
  const player = getWallet(store.db, 'purchase-review-player');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 100 WHERE user_id = ?').run(player.user_id);
  purchaseShopItem(store.db, player.user_id, productId, 1, '2026-11-01T12:05:00.000Z');
  const purchases = await handleEconomyManagementButton(button('gv:economy:staff:purchases'), { db: store.db });
  assert.match(purchases.embeds[0].data.description, /Review Item/);
  assert.match(purchases.embeds[0].data.description, /purchase-review-player/);
  const transactions = await handleEconomyManagementButton(button('gv:economy:staff:transactions'), { db: store.db });
  assert.match(transactions.embeds[0].data.description, /shop purchase/);
  const dropHistory = await handleEconomyManagementButton(button('gv:economy:staff:drop-history'), { db: store.db });
  assert.match(dropHistory.embeds[0].data.description, /\$450.*0\/3 claimed.*open/);

  const pending = createManualEconomyCashDrop(store.db, {
    channelId,
    amount: 125,
    maxClaims: 2,
    lifetimeMinutes: 10,
    actorId: managerId,
  }, new Date('2026-11-01T12:10:00.000Z'));
  setConfigValue(store.db, 'ECONOMY_CASH_DROPS_ENABLED', false);
  const reopened = store.reopen();
  const recoveryClient = { channels: { fetch: async () => ({
    isTextBased: () => true,
    send: async () => ({ id: 'recovered-manual-drop' }),
  }) } };
  const recovered = await processEconomyCashDrops(recoveryClient, reopened, new Date('2026-11-01T12:11:00.000Z'));
  assert.equal(recovered.posted, true);
  assert.equal(reopened.prepare('SELECT status FROM economy_cash_drops WHERE drop_id = ?').get(pending.drop_id).status, 'open');
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM settings WHERE key = 'ECONOMY_CASH_DROP_NEXT_AT'").get().count, 0);
  const expiredPending = createManualEconomyCashDrop(reopened, {
    channelId,
    amount: 125,
    maxClaims: 2,
    lifetimeMinutes: 1,
    actorId: managerId,
  }, new Date('2026-11-01T12:00:00.000Z'));
  const expiredRecovery = await processEconomyCashDrops(recoveryClient, reopened, new Date('2026-11-01T12:02:00.000Z'));
  assert.equal(expiredRecovery.reason, 'disabled');
  assert.equal(reopened.prepare('SELECT status FROM economy_cash_drops WHERE drop_id = ?').get(expiredPending.drop_id).status, 'expired');
});

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

test('a configured starting balance is awarded once even if account creation repeats', (t) => {
  const store = makeTempDatabase(t);
  setConfigValue(store.db, 'ECONOMY_STARTING_BALANCE', 250);
  const first = getWallet(store.db, 'one-time-starter', '2026-10-31T12:00:00.000Z');
  setConfigValue(store.db, 'ECONOMY_STARTING_BALANCE', 900);
  const repeated = getWallet(store.db, 'one-time-starter', '2026-10-31T13:00:00.000Z');
  assert.equal(first.wallet_balance, 250);
  assert.equal(repeated.wallet_balance, 250);
  assert.equal(repeated.created_at, '2026-10-31T12:00:00.000Z');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_accounts WHERE user_id = ?').get('one-time-starter').count, 1);
});

test('economy schema upgrades legacy wallet rows additively without resetting balances', (t) => {
  const store = makeTempDatabase(t);
  getWallet(store.db, 'legacy-wallet', '2026-10-31T12:00:00.000Z');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 4321 WHERE user_id = ?').run('legacy-wallet');
  store.db.exec('ALTER TABLE economy_accounts DROP COLUMN last_daily_reward_at');
  store.db.exec('DROP INDEX economy_transactions_idempotency; ALTER TABLE economy_transactions DROP COLUMN idempotency_key;');
  store.db.exec('ALTER TABLE economy_cash_drops DROP COLUMN claimed_message_updated_at; ALTER TABLE economy_cash_drops DROP COLUMN claimed_at; ALTER TABLE economy_cash_drops DROP COLUMN claimed_by;');
  const reopened = store.reopen();
  const columns = new Set(reopened.pragma('table_info(economy_accounts)').map((column) => column.name));
  const transactionColumns = new Set(reopened.pragma('table_info(economy_transactions)').map((column) => column.name));
  const cashDropColumns = new Set(reopened.pragma('table_info(economy_cash_drops)').map((column) => column.name));
  assert.ok(columns.has('last_daily_reward_at'));
  assert.ok(transactionColumns.has('idempotency_key'));
  assert.ok(cashDropColumns.has('claimed_by'));
  assert.ok(cashDropColumns.has('claimed_at'));
  assert.ok(cashDropColumns.has('claimed_message_updated_at'));
  assert.equal(getWallet(reopened, 'legacy-wallet').wallet_balance, 4321);
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

test('Work checks current Town Jobs roles, explains the current job, and changes immediately with the role', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const playerId = 'economy-player';
  const firstRole = '1666064708795306151';
  const secondRole = '1666064708795306152';
  const player = { id: playerId, roles: { cache: new Map() } };
  env.guild.members.fetch = async (request) => {
    assert.deepEqual(request, { user: playerId, force: true });
    return player;
  };
  setConfigValue(store.db, 'TOWN_JOBS_PANEL_CHANNEL_ID', channelId);
  setConfigValue(store.db, 'TOWN_JOBS_ROLE_OPTIONS', [
    { id: 'a1b2c3d4', roleId: firstRole, label: 'City Mechanic', description: 'Repair civilian vehicles around town.', emoji: '🛠️', action: 'give', style: 'primary' },
    { id: 'd4c3b2a1', roleId: secondRole, label: 'Roadside Assistance', description: 'Help stranded drivers return safely.', emoji: '🚗', action: 'give', style: 'success' },
  ]);
  const clickWork = async () => {
    let response;
    await handleButton({
      customId: 'gv:economy:work',
      guild: env.guild,
      user: { id: playerId, username: 'Player' },
      reply: async (payload) => { response = payload; return payload; },
    }, { db: store.db });
    return response;
  };

  const noJob = await clickWork();
  assert.match(noJob.content, /active Town Job role/i);
  assert.match(noJob.content, new RegExp(channelId));
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'work'").get().count, 0);

  player.roles.cache.set(firstRole, { name: 'City Mechanic' });
  const firstWork = await clickWork();
  assert.match(firstWork.embeds[0].data.title, /City Mechanic/);
  assert.match(firstWork.embeds[0].data.description, /Repair civilian vehicles/);
  assert.match(firstWork.embeds[0].data.description, /Available reward/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'work'").get().count, 1);

  player.roles.cache.clear();
  const removedJob = await clickWork();
  assert.match(removedJob.content, /active Town Job role/i);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'work'").get().count, 1);

  player.roles.cache.set(secondRole, { name: 'Roadside Assistance' });
  store.db.prepare('UPDATE economy_accounts SET last_work_at = ? WHERE user_id = ?').run('2026-10-01T00:00:00.000Z', playerId);
  const changedJob = await clickWork();
  assert.match(changedJob.embeds[0].data.title, /Roadside Assistance/);
  assert.match(changedJob.embeds[0].data.description, /Help stranded drivers/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'work'").get().count, 2);
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
      'maximum-bet': 7000,
    }[name] ?? null),
  });
  const configured = await handleEconomyCommand(configure, { db: store.db });
  assert.match(configured.content, /Updated Economy settings/);
  assert.equal(getEconomySettings(store.db).minimumReward, 75);
  assert.equal(getEconomySettings(store.db).deliveryMaximumReward, 300);
  assert.equal(getEconomySettings(store.db).maximumBet, 7000);

  const panel = await handleEconomyCommand(env.interaction('panel', {}), { db: store.db });
  const refreshed = await handleEconomyCommand(env.interaction('panel', {}), { db: store.db });
  assert.match(panel.content, /posted/);
  assert.match(refreshed.content, /refreshed/);
  assert.equal(env.posts.length, 1);
  assert.equal(env.edits.length, 1);
  const panelButtons = env.posts[0].components.flatMap((row) => row.components);
  assert.deepEqual(panelButtons.map((button) => button.data.label), [
    'My Wallet', 'Work', 'Bank', 'Shop', 'Leaderboard', 'Blackjack', 'Coin Flip', 'Roulette', 'Chicken Road', 'History', 'Daily Rewards', 'Delivery Rush', 'Inventory',
  ]);
  assert.ok(panelButtons.every((button) => !button.data.disabled));

  const account = getWallet(store.db, 'economy-player');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 300, lifetime_earnings = 300 WHERE user_id = ?').run(account.user_id);
  let walletReply;
  await handleButton({
    customId: 'gv:economy:wallet',
    user: { id: account.user_id, username: 'Player' },
    reply: async (payload) => { walletReply = payload; return payload; },
  }, { db: store.db });
  assert.equal(walletReply.ephemeral, true);
  assert.match(walletReply.embeds[0].data.fields.find((field) => field.name.includes('Wallet')).value, /\$300/);
  assert.match(walletReply.embeds[0].data.fields.find((field) => field.name.includes('Bank')).value, /\$0/);
  assert.equal(JSON.stringify(walletReply).includes(account.user_id), false);

  let unauthorizedReply;
  const unauthorized = env.interaction('configure', {
    getChannel: () => null,
    getInteger: () => null,
  }, 'economy-player');
  await handleEconomyCommand(unauthorized, { db: store.db });
  unauthorizedReply = unauthorized.lastReply;
  assert.match(unauthorizedReply.content, /configured Economy Management role/i);
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

test('transaction history paginates all rows newest-first and keeps each viewer bound to their own account', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const userId = 'history-owner';
  const otherUserId = 'history-other';
  getWallet(store.db, userId);
  getWallet(store.db, otherUserId);
  const insert = store.db.prepare(`
    INSERT INTO economy_transactions (id, user_id, type, amount, wallet_after, bank_after, created_at, metadata_json)
    VALUES (?, ?, 'work', ?, ?, 0, ?, ?)
  `);
  for (let index = 1; index <= 17; index += 1) {
    insert.run(`history-${index}`, userId, index, index,
      new Date(Date.parse('2026-11-01T10:00:00.000Z') + index * 60_000).toISOString(),
      JSON.stringify({ description: `Reason ${index}` }));
  }
  insert.run('other-history-1', otherUserId, 999, 999, '2026-11-01T12:00:00.000Z', JSON.stringify({ description: 'Private other account' }));

  let firstPage;
  await handleButton({
    customId: 'gv:economy:transactions',
    user: { id: userId },
    reply: async (payload) => { firstPage = payload; return payload; },
  }, { db: store.db });
  assert.match(firstPage.embeds[0].data.footer.text, /Page 1 of 2 • 17 transactions/);
  assert.ok(firstPage.embeds[0].data.description.indexOf('Reason 17') < firstPage.embeds[0].data.description.indexOf('Reason 8'));
  assert.doesNotMatch(firstPage.embeds[0].data.description, /Reason 7/);
  const nextId = firstPage.components[0].components[1].data.custom_id;

  let secondPage;
  await handleButton({
    customId: nextId,
    user: { id: userId },
    update: async (payload) => { secondPage = payload; return payload; },
  }, { db: store.db });
  assert.match(secondPage.embeds[0].data.footer.text, /Page 2 of 2 • 17 transactions/);
  assert.match(secondPage.embeds[0].data.description, /Reason 7/);
  assert.match(secondPage.embeds[0].data.description, /Reason 1/);
  assert.equal(secondPage.components[0].components[0].data.disabled, false);
  assert.equal(secondPage.components[0].components[1].data.disabled, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_transactions WHERE user_id = ?').get(userId).count, 17);

  let denied;
  await handleButton({
    customId: `gv:economy:transactions:page:${userId}:${otherUserId}:0`,
    guild: env.guild,
    user: { id: userId },
    reply: async (payload) => { denied = payload; return payload; },
  }, { db: store.db });
  assert.match(denied.content, /configured Economy Management role/i);
  assert.doesNotMatch(JSON.stringify(denied), /Private other account/);
});