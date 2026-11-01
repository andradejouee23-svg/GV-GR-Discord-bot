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
  const transferred = transferToPlayer(store.db, 'starter-user', 'recipient-user', 50, 'thanks', '2026-11-01T21:05:00.000Z');
  assert.equal(transferred.sender.wallet_balance, deposited.walletAfter - 50);
  assert.equal(transferred.recipient.wallet_balance, recipient.wallet_balance + 50);

  const withdrew = withdrawFromBank(store.db, 'starter-user', 25, 'withdraw-test', '2026-11-01T21:10:00.000Z');
  assert.equal(withdrew.walletAfter, transferred.sender.wallet_balance + 25);

  const itemId = createShopItem(store.db, { name: 'Coffee', description: 'Warm drink', price: 120, stock: 3, category: 'Food', imageUrl: 'https://example.com/coffee.png', enabled: true, purchaseLimit: 2 }, 'admin-1');
  assert.ok(itemId);
  assert.equal(editShopItem(store.db, itemId, { price: 100 }, 'admin-1').updated, true);
  const purchase = purchaseShopItem(store.db, 'starter-user', itemId, 1, '2026-11-01T21:30:00.000Z');
  assert.equal(purchase.purchased, true);
  assert.equal(store.db.prepare('SELECT quantity FROM economy_inventory WHERE user_id = ? AND item_id = ?').get('starter-user', itemId).quantity, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'shop_purchase'").get().count, 1);
  assert.equal(removeShopItem(store.db, itemId, 'admin-1').removed, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_shop_items WHERE id = ? AND deleted = 0').get(itemId).count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_purchase_history WHERE item_id = ?').get(itemId).count, 1);
});

test('cash drops recover pending posts after restart, follow persisted intervals, and pay each player once', async (t) => {
  const store = makeTempDatabase(t);
  const channelIdForDrop = '1666064708795306156';
  setConfigValue(store.db, 'ECONOMY_CASH_DROP_CHANNEL_ID', channelIdForDrop);
  setConfigValue(store.db, 'ECONOMY_CASH_DROP_MAX_CLAIMS', 1);
  const sends = [];
  const unavailableClient = { channels: { fetch: async () => ({ isTextBased: () => true, send: async () => { throw new Error('temporary outage'); } }) } };
  const start = new Date('2026-11-01T12:00:00.000Z');
  const failedPost = await processEconomyCashDrops(unavailableClient, store.db, start);
  assert.deepEqual({ posted: failedPost.posted, reason: failedPost.reason }, { posted: false, reason: 'post' });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM economy_cash_drops WHERE status = 'pending'").get().count, 1);

  const reopened = store.reopen();
  const workingClient = {
    channels: {
      fetch: async (id) => ({
        id,
        isTextBased: () => true,
        send: async (payload) => {
          sends.push(payload);
          return { id: `drop-message-${sends.length}` };
        },
      }),
    },
  };
  const recovered = await processEconomyCashDrops(workingClient, reopened, new Date(start.getTime() + 60_000));
  assert.equal(recovered.posted, true);
  assert.equal(sends.length, 1);
  const firstDrop = reopened.prepare('SELECT * FROM economy_cash_drops WHERE drop_id = ?').get(recovered.dropId);
  assert.equal(firstDrop.status, 'open');
  assert.equal(firstDrop.message_id, 'drop-message-1');

  let claimReply;
  await handleButton({
    customId: `gv:economy:drop:claim:${recovered.dropId}`,
    user: { id: 'cash-player' },
    message: { edit: async () => ({}) },
    reply: async (payload) => { claimReply = payload; return payload; },
  }, { db: reopened });
  assert.match(claimReply.content, /Cash drop claimed/);
  assert.equal(claimEconomyCashDrop(reopened, recovered.dropId, 'cash-player', new Date(start.getTime() + 3 * 60_000)).reason, 'closed');
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'cash_drop'").get().count, 1);

  const notDue = await processEconomyCashDrops(workingClient, reopened, new Date(start.getTime() + 14 * 60_000));
  assert.equal(notDue.reason, 'not-due');
  const stillWaiting = await processEconomyCashDrops(workingClient, reopened, new Date(start.getTime() + 15 * 60_000));
  assert.equal(stillWaiting.reason, 'not-due');
  const nextDrop = await processEconomyCashDrops(workingClient, reopened, new Date(start.getTime() + 16 * 60_000));
  assert.equal(nextDrop.posted, true);
  assert.equal(sends.length, 2);
});

test('Discord shop, bank, inventory, and transaction controls reach their persisted handlers', async (t) => {
  const store = makeTempDatabase(t);
  const env = createPanelEnvironment(store.db);
  const itemId = createShopItem(store.db, { name: 'GV Hoodie', description: 'Community merch', price: 75, stock: 2 }, managerId);
  const account = getWallet(store.db, 'economy-player');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 300 WHERE user_id = ?').run(account.user_id);

  const shop = await handleEconomyCommand(env.interaction('shop', {}, 'economy-player'), { db: store.db });
  assert.equal(shop.ephemeral, true);
  assert.match(shop.embeds[0].data.description, /GV Hoodie/);
  const buyId = shop.components[0].components[0].data.custom_id;
  assert.equal(buyId, `gv:economy:shop:buy:${itemId}`);
  let buyReply;
  await handleButton({ customId: buyId, user: { id: 'economy-player' }, reply: async (payload) => { buyReply = payload; return payload; } }, { db: store.db });
  assert.match(buyReply.content, /Purchase complete/);

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
  assert.match(modalReply.content, /Deposited 100 GV Credits/);
  assert.equal(getWallet(store.db, 'economy-player').bank_balance, 100);
});

test('economy leaderboard ranks combined wallet and bank wealth and is available from Discord', async (t) => {
  const store = makeTempDatabase(t);
  for (const [userId, wallet, bank] of [['wallet-rich', 900, 0], ['bank-rich', 100, 2500]]) {
    getWallet(store.db, userId);
    store.db.prepare('UPDATE economy_accounts SET wallet_balance = ?, bank_balance = ? WHERE user_id = ?').run(wallet, bank, userId);
  }
  const rows = getEconomyLeaderboard(store.db);
  assert.equal(rows[0].user_id, 'bank-rich');
  const env = createPanelEnvironment(store.db);
  const leaderboard = await handleEconomyCommand(env.interaction('leaderboard', {}, 'economy-player'), { db: store.db });
  assert.match(leaderboard.embeds[0].data.description, /<@bank-rich>.*Total 2,600 GV Credits/);
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
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM staff_audit_logs WHERE action LIKE 'economy_%'").get().count, 8);
  const reopened = store.reopen();
  assert.equal(getEconomySettings(reopened).cashDropAmount, 400);
  assert.equal(getEconomySettings(reopened).minimumReward, 60);
  assert.equal(getEconomySettings(reopened).panelColor, 0x123abc);
  assert.equal(getEconomySettings(reopened).shopColor, 0xabcdef);
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

test('economy schema upgrades legacy wallet rows additively without resetting balances', (t) => {
  const store = makeTempDatabase(t);
  getWallet(store.db, 'legacy-wallet', '2026-10-31T12:00:00.000Z');
  store.db.prepare('UPDATE economy_accounts SET wallet_balance = 4321 WHERE user_id = ?').run('legacy-wallet');
  store.db.exec('ALTER TABLE economy_accounts DROP COLUMN last_daily_reward_at');
  const reopened = store.reopen();
  const columns = new Set(reopened.pragma('table_info(economy_accounts)').map((column) => column.name));
  assert.ok(columns.has('last_daily_reward_at'));
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
    'My Wallet', 'Work', 'Bank', 'Shop', 'Leaderboard', 'Blackjack', 'Coin Flip', 'Roulette', 'Chicken Road', 'Transactions', 'Daily Rewards', 'Delivery Rush', 'Inventory',
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