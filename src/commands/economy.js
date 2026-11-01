const { randomInt, randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement: ensureStaffManagement } = require('./staff');
const {
  beginBlackjack,
  cardLabel,
  handValue,
  playCoinFlip,
  playRoulette,
  resolveBlackjackAction,
  resolveChickenAction,
  startChickenRoad,
} = require('../services/economyGames');
const {
  getConfigValue,
  getInteractionMember,
  makeEmbed,
  memberRoleIds,
  setConfigValue,
  validId,
} = require('../utils/discord');
const { applyPanelCustomization, ensurePanelHeader } = require('./panelEditor');

function getEconomySettings(db) {
  return {
    channelId: getConfigValue(db, 'ECONOMY_PANEL_CHANNEL_ID'),
    messageChannelId: getConfigValue(db, 'ECONOMY_PANEL_MESSAGE_CHANNEL_ID'),
    messageId: getConfigValue(db, 'ECONOMY_PANEL_MESSAGE_ID'),
    minimumReward: Number(getConfigValue(db, 'ECONOMY_WORK_MIN_REWARD') ?? config.ECONOMY_WORK_MIN_REWARD),
    maximumReward: Number(getConfigValue(db, 'ECONOMY_WORK_MAX_REWARD') ?? config.ECONOMY_WORK_MAX_REWARD),
    cooldownMinutes: Number(getConfigValue(db, 'ECONOMY_WORK_COOLDOWN_MINUTES') ?? config.ECONOMY_WORK_COOLDOWN_MINUTES),
    startingBalance: Number(getConfigValue(db, 'ECONOMY_STARTING_BALANCE') ?? config.ECONOMY_STARTING_BALANCE),
    dailyReward: Number(getConfigValue(db, 'ECONOMY_DAILY_REWARD_AMOUNT') ?? config.ECONOMY_DAILY_REWARD_AMOUNT),
    dailyRewardCooldownHours: Number(getConfigValue(db, 'ECONOMY_DAILY_REWARD_COOLDOWN_HOURS') ?? config.ECONOMY_DAILY_REWARD_COOLDOWN_HOURS),
    panelColor: Number(getConfigValue(db, 'ECONOMY_PANEL_COLOR') ?? config.ECONOMY_PANEL_COLOR),
    shopColor: Number(getConfigValue(db, 'ECONOMY_SHOP_COLOR') ?? config.ECONOMY_SHOP_COLOR),
    cashDropsEnabled: getConfigValue(db, 'ECONOMY_CASH_DROPS_ENABLED') !== false,
    cashDropChannelId: getConfigValue(db, 'ECONOMY_CASH_DROP_CHANNEL_ID') ?? getConfigValue(db, 'ECONOMY_PANEL_CHANNEL_ID'),
    cashDropIntervalMinutes: Number(getConfigValue(db, 'ECONOMY_CASH_DROP_INTERVAL_MINUTES') ?? config.ECONOMY_CASH_DROP_INTERVAL_MINUTES),
    cashDropAmount: Number(getConfigValue(db, 'ECONOMY_CASH_DROP_AMOUNT') ?? config.ECONOMY_CASH_DROP_AMOUNT),
    cashDropMaxClaims: Number(getConfigValue(db, 'ECONOMY_CASH_DROP_MAX_CLAIMS') ?? config.ECONOMY_CASH_DROP_MAX_CLAIMS),
    cashDropLifetimeMinutes: Number(getConfigValue(db, 'ECONOMY_CASH_DROP_LIFETIME_MINUTES') ?? config.ECONOMY_CASH_DROP_LIFETIME_MINUTES),
    deliveryMinimumReward: Number(getConfigValue(db, 'ECONOMY_DELIVERY_MIN_REWARD') ?? config.ECONOMY_DELIVERY_MIN_REWARD),
    deliveryMaximumReward: Number(getConfigValue(db, 'ECONOMY_DELIVERY_MAX_REWARD') ?? config.ECONOMY_DELIVERY_MAX_REWARD),
    deliveryCooldownMinutes: Number(getConfigValue(db, 'ECONOMY_DELIVERY_COOLDOWN_MINUTES') ?? config.ECONOMY_DELIVERY_COOLDOWN_MINUTES),
    maximumBet: Number(getConfigValue(db, 'ECONOMY_GAME_MAX_BET') ?? config.ECONOMY_GAME_MAX_BET),
    currencyName: getConfigValue(db, 'ECONOMY_CURRENCY_NAME') ?? config.ECONOMY_CURRENCY_NAME,
  };
}

function hasEconomyAccess(member, db) {
  const roleId = getConfigValue(db, 'ECONOMY_MANAGEMENT_ROLE_ID');
  return validId(roleId) && memberRoleIds(member).includes(roleId);
}

async function ensureManagement(interaction, db) {
  const member = await getInteractionMember(interaction);
  if (member && hasEconomyAccess(member, db)) return true;
  const roleId = getConfigValue(db, 'ECONOMY_MANAGEMENT_ROLE_ID');
  await interaction.reply({
    content: validId(roleId)
      ? 'This economy control is restricted to the configured Economy Management role.'
      : 'Economy access is not configured. A manager can run `/economy access-role` first.',
    ephemeral: true,
  });
  return false;
}

async function configureEconomyAccessRole(interaction, ctx) {
  if (!await ensureStaffManagement(interaction, ctx.db)) return;
  const role = interaction.options.getRole('role', true);
  const previous = getConfigValue(ctx.db, 'ECONOMY_MANAGEMENT_ROLE_ID') ?? null;
  setConfigValue(ctx.db, 'ECONOMY_MANAGEMENT_ROLE_ID', role.id);
  recordEconomyAudit(ctx.db, {
    actorId: interaction.user.id,
    action: 'access_role_changed',
    previousValue: previous,
    newValue: role.id,
    reason: 'Economy management access role configured',
  });
  return interaction.reply({ content: `Economy management access is now restricted to <@&${role.id}>.`, ephemeral: true });
}

function validateWorkSettings(settings) {
  if (!Number.isSafeInteger(settings.minimumReward) || settings.minimumReward < 1
    || !Number.isSafeInteger(settings.maximumReward) || settings.maximumReward < settings.minimumReward
    || settings.maximumReward > 1_000_000) {
    return 'Work rewards must be positive whole numbers, with the maximum at least the minimum and no greater than 1,000,000.';
  }
  if (!Number.isSafeInteger(settings.cooldownMinutes) || settings.cooldownMinutes < 1 || settings.cooldownMinutes > 10080) {
    return 'Work cooldown must be between 1 minute and 7 days.';
  }
  return null;
}

function validateDeliverySettings(settings) {
  if (!Number.isSafeInteger(settings.deliveryMinimumReward) || settings.deliveryMinimumReward < 1
    || !Number.isSafeInteger(settings.deliveryMaximumReward)
    || settings.deliveryMaximumReward < settings.deliveryMinimumReward
    || settings.deliveryMaximumReward > 1_000_000) {
    return 'Delivery Rush rewards must be positive whole numbers, with the maximum at least the minimum and no greater than 1,000,000.';
  }
  if (!Number.isSafeInteger(settings.deliveryCooldownMinutes)
    || settings.deliveryCooldownMinutes < 1 || settings.deliveryCooldownMinutes > 10080) {
    return 'Delivery Rush cooldown must be between 1 minute and 7 days.';
  }
  return null;
}

function formatCurrency(amount) {
  return `$${new Intl.NumberFormat('en-US').format(amount)}`;
}

function ensureEconomyAccount(db, userId, now = new Date().toISOString()) {
  const settings = getEconomySettings(db);
  const startingBalance = Number(settings.startingBalance ?? config.ECONOMY_STARTING_BALANCE ?? 0);
  db.prepare(`
    INSERT INTO economy_accounts (user_id, wallet_balance, bank_balance, lifetime_earnings, total_spent, total_transferred, created_at)
    VALUES (?, ?, 0, 0, 0, 0, ?)
    ON CONFLICT(user_id) DO NOTHING
  `).run(userId, startingBalance, now);
  return db.prepare('SELECT * FROM economy_accounts WHERE user_id = ?').get(userId);
}

function getWallet(db, userId, now = new Date().toISOString()) {
  return ensureEconomyAccount(db, userId, now);
}

function recordEconomyTransaction(db, {
  userId,
  relatedUserId = null,
  type,
  amount,
  walletAfter,
  bankAfter,
  description = '',
  metadata = {},
  idempotencyKey = null,
  now = new Date().toISOString(),
}) {
  if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Transaction amount must be a positive whole number.');
  db.prepare(`
    INSERT INTO economy_transactions (id, user_id, related_user_id, type, amount, wallet_after, bank_after, created_at, metadata_json, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, relatedUserId, type, amount, walletAfter, bankAfter, now, JSON.stringify({ description, ...metadata }), idempotencyKey);
}

function recordEconomyAudit(db, { actorId, targetId = 'economy', action, reason = '', previousValue = null, newValue = null, details = {}, now = new Date().toISOString() }) {
  db.prepare(`
    INSERT INTO staff_audit_logs (action, target_id, actor_id, reason, previous_value, new_value, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(`economy_${action}`, targetId, actorId, reason, previousValue, newValue, JSON.stringify(details), now);
}

function claimDailyReward(db, userId, settings = getEconomySettings(db), now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Daily reward time is invalid.');
  const nowIso = nowDate.toISOString();
  return db.transaction(() => {
    const account = ensureEconomyAccount(db, userId, nowIso);
    const cooldownHours = Number(settings.dailyRewardCooldownHours ?? 24);
    const amount = Number(settings.dailyReward ?? 0);
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000
      || !Number.isSafeInteger(cooldownHours) || cooldownHours < 1 || cooldownHours > 168) {
      throw new Error('Daily reward settings are invalid.');
    }
    const cooldownMs = cooldownHours * 60 * 60 * 1000;
    if (account.last_daily_reward_at) {
      const nextAvailableAt = Date.parse(account.last_daily_reward_at) + cooldownMs;
      if (Number.isFinite(nextAvailableAt) && nowDate.getTime() < nextAvailableAt) {
        return { claimed: false, amount, nextRewardAt: new Date(nextAvailableAt).toISOString() };
      }
    }
    const newWallet = account.wallet_balance + amount;
    const newLifetime = account.lifetime_earnings + amount;
    if (!Number.isSafeInteger(newWallet) || !Number.isSafeInteger(newLifetime)) {
      throw new Error('Daily reward would exceed the safe account balance limit. Contact management.');
    }
    db.prepare(`
      UPDATE economy_accounts
      SET wallet_balance = ?, lifetime_earnings = ?, last_daily_reward_at = ?
      WHERE user_id = ?
    `).run(newWallet, newLifetime, nowIso, userId);
    recordEconomyTransaction(db, { userId, type: 'daily_reward', amount, walletAfter: newWallet, bankAfter: account.bank_balance, description: 'Daily reward', now: nowIso });
    return { claimed: true, amount, nextRewardAt: new Date(nowDate.getTime() + cooldownMs).toISOString(), walletAfter: newWallet };
  })();
}

function depositToBank(db, userId, amount, description = 'Bank deposit', now = new Date().toISOString()) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Deposit amount must be a positive whole number.');
  return db.transaction(() => {
    const account = ensureEconomyAccount(db, userId, now);
    if (account.wallet_balance < amount) throw new Error('You do not have enough wallet cash to make that deposit.');
    const newWallet = account.wallet_balance - amount;
    const newBank = account.bank_balance + amount;
    if (!Number.isSafeInteger(newBank)) throw new Error('Bank balance would exceed the safe account limit.');
    db.prepare('UPDATE economy_accounts SET wallet_balance = ?, bank_balance = ? WHERE user_id = ?').run(newWallet, newBank, userId);
    recordEconomyTransaction(db, { userId, type: 'bank_deposit', amount, walletAfter: newWallet, bankAfter: newBank, description, now });
    return { walletAfter: newWallet, bankAfter: newBank, amount };
  })();
}

function withdrawFromBank(db, userId, amount, description = 'Bank withdrawal', now = new Date().toISOString()) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Withdrawal amount must be a positive whole number.');
  return db.transaction(() => {
    const account = ensureEconomyAccount(db, userId, now);
    if (account.bank_balance < amount) throw new Error('You do not have enough funds in your bank account.');
    const newWallet = account.wallet_balance + amount;
    const newBank = account.bank_balance - amount;
    if (!Number.isSafeInteger(newWallet)) throw new Error('Wallet balance would exceed the safe account limit.');
    db.prepare('UPDATE economy_accounts SET wallet_balance = ?, bank_balance = ? WHERE user_id = ?').run(newWallet, newBank, userId);
    recordEconomyTransaction(db, { userId, type: 'bank_withdrawal', amount, walletAfter: newWallet, bankAfter: newBank, description, now });
    return { walletAfter: newWallet, bankAfter: newBank, amount };
  })();
}

function transferToPlayer(db, fromUserId, toUserId, amount, description = 'Player transfer', now = new Date().toISOString(), idempotencyKey = null) {
  if (fromUserId === toUserId) throw new Error('You cannot transfer money to yourself.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Transfer amount must be a positive whole number.');
  return db.transaction(() => {
    const senderKey = typeof idempotencyKey === 'string' && idempotencyKey ? `${idempotencyKey}:sender` : null;
    if (senderKey) {
      const previous = db.prepare('SELECT related_user_id FROM economy_transactions WHERE idempotency_key = ?').get(senderKey);
      if (previous) {
        if (previous.related_user_id !== toUserId) throw new Error('This transfer request was already used for a different recipient.');
        return { sender: getWallet(db, fromUserId, now), recipient: getWallet(db, toUserId, now), amount, duplicate: true };
      }
    }
    const sender = ensureEconomyAccount(db, fromUserId, now);
    const recipient = ensureEconomyAccount(db, toUserId, now);
    if (sender.wallet_balance < amount) throw new Error('You do not have enough wallet cash to make that transfer.');
    const senderWallet = sender.wallet_balance - amount;
    const recipientWallet = recipient.wallet_balance + amount;
    const transferredTotal = sender.total_transferred + amount;
    if (!Number.isSafeInteger(recipientWallet) || !Number.isSafeInteger(transferredTotal)) throw new Error('Transfer would exceed a safe account balance limit.');
    db.prepare('UPDATE economy_accounts SET wallet_balance = ?, total_transferred = ? WHERE user_id = ?').run(senderWallet, transferredTotal, fromUserId);
    db.prepare('UPDATE economy_accounts SET wallet_balance = ? WHERE user_id = ?').run(recipientWallet, toUserId);
    recordEconomyTransaction(db, { userId: fromUserId, relatedUserId: toUserId, type: 'player_transfer', amount, walletAfter: senderWallet, bankAfter: sender.bank_balance, description, metadata: { recipientId: toUserId }, idempotencyKey: senderKey, now });
    recordEconomyTransaction(db, { userId: toUserId, relatedUserId: fromUserId, type: 'player_transfer_received', amount, walletAfter: recipientWallet, bankAfter: recipient.bank_balance, description: `Incoming transfer from <@${fromUserId}>`, idempotencyKey: senderKey ? `${idempotencyKey}:recipient` : null, now });
    return { sender: getWallet(db, fromUserId, now), recipient: getWallet(db, toUserId, now), amount };
  })();
}

function createShopItem(db, item, createdBy, now = new Date().toISOString()) {
  const payload = {
    id: item.id ?? randomUUID(),
    name: String(item.name ?? '').trim(),
    description: String(item.description ?? '').trim(),
    price: Number(item.price ?? 0),
    category: String(item.category ?? 'General').trim() || 'General',
    stock: Number(item.stock ?? 0),
    imageUrl: item.imageUrl ?? null,
    enabled: item.enabled === false ? 0 : 1,
    purchaseLimit: item.purchaseLimit == null ? null : Number(item.purchaseLimit),
    createdBy,
    now,
  };
  if (!payload.name || !Number.isSafeInteger(payload.price) || payload.price < 1 || !Number.isSafeInteger(payload.stock) || payload.stock < 0
    || (payload.purchaseLimit !== null && (!Number.isSafeInteger(payload.purchaseLimit) || payload.purchaseLimit < 1))) {
    throw new Error('Shop item name, price, and stock must be valid.');
  }
  if (payload.imageUrl) {
    let imageUrl;
    try { imageUrl = new URL(payload.imageUrl); } catch { throw new Error('Shop item image must be a valid HTTPS URL.'); }
    if (imageUrl.protocol !== 'https:') throw new Error('Shop item image must be a valid HTTPS URL.');
  }
  db.prepare(`
    INSERT INTO economy_shop_items (id, name, description, price, category, stock, image_url, enabled, purchase_limit, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(payload.id, payload.name, payload.description, payload.price, payload.category, payload.stock, payload.imageUrl, payload.enabled, payload.purchaseLimit, payload.createdBy, now, now);
  recordEconomyAudit(db, { actorId: createdBy, targetId: payload.id, action: 'shop_item_created', newValue: JSON.stringify(payload), now });
  return payload.id;
}

function editShopItem(db, itemId, changes, actorId, now = new Date().toISOString()) {
  const existing = db.prepare('SELECT * FROM economy_shop_items WHERE id = ? AND deleted = 0').get(itemId);
  if (!existing) return { updated: false, reason: 'missing' };
  const allowed = {
    name: (value) => String(value).trim(),
    description: (value) => String(value).trim(),
    price: (value) => Number(value),
    category: (value) => String(value).trim() || 'General',
    stock: (value) => Number(value),
    imageUrl: (value) => value || null,
    purchaseLimit: (value) => value == null ? null : Number(value),
    enabled: (value) => value ? 1 : 0,
  };
  const next = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined && allowed[key]) next[key] = allowed[key](value);
  }
  if (!Object.keys(next).length) return { updated: false, reason: 'empty' };
  if ((next.name !== undefined && !next.name)
    || (next.price !== undefined && (!Number.isSafeInteger(next.price) || next.price < 1))
    || (next.stock !== undefined && (!Number.isSafeInteger(next.stock) || next.stock < 0))
    || (next.purchaseLimit !== undefined && next.purchaseLimit !== null && (!Number.isSafeInteger(next.purchaseLimit) || next.purchaseLimit < 1))) {
    throw new Error('Shop item name, price, stock, or purchase limit is invalid.');
  }
  if (next.imageUrl) {
    let imageUrl;
    try { imageUrl = new URL(next.imageUrl); } catch { throw new Error('Shop item image must be a valid HTTPS URL.'); }
    if (imageUrl.protocol !== 'https:') throw new Error('Shop item image must be a valid HTTPS URL.');
  }
  const fields = Object.keys(next);
  const assignments = fields.map((field) => `${({ imageUrl: 'image_url', purchaseLimit: 'purchase_limit' })[field] ?? field} = ?`);
  const values = fields.map((field) => next[field]);
  db.prepare(`UPDATE economy_shop_items SET ${assignments.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now, itemId);
  const updated = db.prepare('SELECT * FROM economy_shop_items WHERE id = ?').get(itemId);
  recordEconomyAudit(db, { actorId, targetId: itemId, action: 'shop_item_edited', previousValue: JSON.stringify(existing), newValue: JSON.stringify(updated), now });
  return { updated: true, item: updated };
}

function removeShopItem(db, itemId, actorId, now = new Date().toISOString()) {
  const existing = db.prepare('SELECT * FROM economy_shop_items WHERE id = ? AND deleted = 0').get(itemId);
  if (!existing) return { removed: false, reason: 'missing' };
  db.prepare('UPDATE economy_shop_items SET deleted = 1, enabled = 0, updated_at = ? WHERE id = ?').run(now, itemId);
  recordEconomyAudit(db, { actorId, targetId: itemId, action: 'shop_item_removed', previousValue: JSON.stringify(existing), now });
  return { removed: true, itemId };
}

function listShopItems(db, includeDisabled = true) {
  const rows = db.prepare(`
    SELECT * FROM economy_shop_items WHERE deleted = 0 AND (? = 1 OR enabled = 1) ORDER BY category, name ASC
  `).all(includeDisabled ? 1 : 0);
  return rows;
}

function getPlayerInventory(db, userId) {
  return db.prepare(`
    SELECT i.item_id, i.item_name, i.quantity, i.purchased_at, s.description, s.category
    FROM economy_inventory i
    JOIN economy_shop_items s ON s.id = i.item_id
    WHERE i.user_id = ?
    ORDER BY i.purchased_at DESC
  `).all(userId);
}

function getPlayerPurchaseHistory(db, userId, limit = 20) {
  return db.prepare(`
    SELECT * FROM economy_purchase_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
  `).all(userId, limit);
}

function purchaseShopItem(db, userId, itemId, quantity = 1, now = new Date().toISOString(), idempotencyKey = null) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Purchase quantity must be a positive whole number.');
  return db.transaction(() => {
    if (typeof idempotencyKey === 'string' && idempotencyKey) {
      const previous = db.prepare('SELECT * FROM economy_transactions WHERE idempotency_key = ?').get(idempotencyKey);
      if (previous) {
        if (previous.type !== 'shop_purchase') throw new Error('This purchase request was already used for another transaction.');
        const account = getWallet(db, userId, now);
        return { purchased: true, duplicate: true, itemId, totalCost: previous.amount, walletAfter: account.wallet_balance, bankAfter: account.bank_balance };
      }
    }
    const item = db.prepare('SELECT * FROM economy_shop_items WHERE id = ?').get(itemId);
    if (!item || item.deleted) return { purchased: false, reason: 'missing' };
    if (!item.enabled) return { purchased: false, reason: 'disabled' };
    if (item.stock < quantity) return { purchased: false, reason: 'stock' };
    const account = ensureEconomyAccount(db, userId, now);
    const totalCost = item.price * quantity;
    if (!Number.isSafeInteger(totalCost)) throw new Error('Purchase total exceeds the safe currency limit.');
    if (account.wallet_balance + account.bank_balance < totalCost) return { purchased: false, reason: 'funds' };
    if (item.purchase_limit) {
      const owned = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS owned FROM economy_purchase_history WHERE user_id = ? AND item_id = ?').get(userId, itemId).owned;
      if (owned + quantity > item.purchase_limit) return { purchased: false, reason: 'limit' };
    }
    const stockUpdate = db.prepare(`
      UPDATE economy_shop_items SET stock = stock - ?, updated_at = ?
      WHERE id = ? AND deleted = 0 AND enabled = 1 AND stock >= ?
    `).run(quantity, now, itemId, quantity);
    if (!stockUpdate.changes) return { purchased: false, reason: 'stock' };
    const walletSpent = Math.min(account.wallet_balance, totalCost);
    const bankSpent = totalCost - walletSpent;
    const newWallet = account.wallet_balance - walletSpent;
    const newBank = account.bank_balance - bankSpent;
    const newSpent = account.total_spent + totalCost;
    if (!Number.isSafeInteger(newSpent)) throw new Error('Lifetime spending would exceed the safe account limit.');
    db.prepare('UPDATE economy_accounts SET wallet_balance = ?, bank_balance = ?, total_spent = ? WHERE user_id = ?')
      .run(newWallet, newBank, newSpent, userId);
    db.prepare(`
      INSERT INTO economy_inventory (user_id, item_id, item_name, quantity, purchased_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, item_id) DO UPDATE SET quantity = economy_inventory.quantity + excluded.quantity, purchased_at = excluded.purchased_at
    `).run(userId, item.id, item.name, quantity, now);
    db.prepare(`
      INSERT INTO economy_purchase_history (id, user_id, item_id, item_name, quantity, price, total_cost, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), userId, item.id, item.name, quantity, item.price, totalCost, now);
    recordEconomyTransaction(db, { userId, type: 'shop_purchase', amount: totalCost, walletAfter: newWallet, bankAfter: newBank, description: `${item.name} x${quantity}`, metadata: { itemId: item.id, quantity }, idempotencyKey, now });
    return { purchased: true, itemId: item.id, totalCost, walletAfter: newWallet, bankAfter: newBank, remainingStock: item.stock - quantity };
  })();
}

const shopPurchaseConfirmationLifetimeMs = 5 * 60_000;

function prepareShopPurchase(db, userId, itemId, quantity = 1, now = new Date()) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Purchase quantity must be a positive whole number.');
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Purchase time is invalid.');
  const nowIso = nowDate.toISOString();
  return db.transaction(() => {
    db.prepare("UPDATE economy_shop_purchase_confirmations SET status = 'expired' WHERE user_id = ? AND item_id = ? AND status = 'pending' AND expires_at <= ?")
      .run(userId, itemId, nowIso);
    const pending = db.prepare("SELECT confirmation_id FROM economy_shop_purchase_confirmations WHERE user_id = ? AND item_id = ? AND status = 'pending' LIMIT 1")
      .get(userId, itemId);
    if (pending) return { prepared: false, reason: 'pending', confirmationId: pending.confirmation_id };
    const item = db.prepare('SELECT * FROM economy_shop_items WHERE id = ?').get(itemId);
    if (!item || item.deleted) return { prepared: false, reason: 'missing' };
    if (!item.enabled) return { prepared: false, reason: 'disabled' };
    if (item.stock < quantity) return { prepared: false, reason: 'stock' };
    const account = ensureEconomyAccount(db, userId, nowIso);
    const totalCost = item.price * quantity;
    if (!Number.isSafeInteger(totalCost)) throw new Error('Purchase total exceeds the safe currency limit.');
    if (account.wallet_balance + account.bank_balance < totalCost) return { prepared: false, reason: 'funds' };
    if (item.purchase_limit) {
      const owned = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS owned FROM economy_purchase_history WHERE user_id = ? AND item_id = ?').get(userId, itemId).owned;
      if (owned + quantity > item.purchase_limit) return { prepared: false, reason: 'limit' };
    }
    const confirmationId = randomUUID().replaceAll('-', '');
    const expiresAt = new Date(nowDate.getTime() + shopPurchaseConfirmationLifetimeMs).toISOString();
    db.prepare(`
      INSERT INTO economy_shop_purchase_confirmations (confirmation_id, user_id, item_id, quantity, quoted_price, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(confirmationId, userId, item.id, quantity, item.price, nowIso, expiresAt);
    return { prepared: true, confirmationId, expiresAt, item, totalCost, quantity, panelColor: getEconomySettings(db).shopColor };
  })();
}

function completeShopPurchase(db, confirmationId, userId, idempotencyKey, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Purchase confirmation time is invalid.');
  const nowIso = nowDate.toISOString();
  return db.transaction(() => {
    const confirmation = db.prepare('SELECT * FROM economy_shop_purchase_confirmations WHERE confirmation_id = ?').get(confirmationId);
    if (!confirmation || confirmation.user_id !== userId) return { purchased: false, reason: 'owner' };
    if (confirmation.status !== 'pending') return { purchased: false, reason: 'duplicate' };
    if (confirmation.expires_at <= nowIso) {
      db.prepare("UPDATE economy_shop_purchase_confirmations SET status = 'expired' WHERE confirmation_id = ? AND status = 'pending'").run(confirmationId);
      return { purchased: false, reason: 'expired' };
    }
    const item = db.prepare('SELECT * FROM economy_shop_items WHERE id = ? AND deleted = 0 AND enabled = 1').get(confirmation.item_id);
    if (!item || item.stock < confirmation.quantity) return { purchased: false, reason: 'stock' };
    if (item.price !== confirmation.quoted_price) {
      db.prepare("UPDATE economy_shop_purchase_confirmations SET status = 'expired' WHERE confirmation_id = ? AND status = 'pending'").run(confirmationId);
      return { purchased: false, reason: 'price-changed' };
    }
    const claimed = db.prepare("UPDATE economy_shop_purchase_confirmations SET status = 'confirmed', completed_at = ? WHERE confirmation_id = ? AND user_id = ? AND status = 'pending'")
      .run(nowIso, confirmationId, userId);
    if (!claimed.changes) return { purchased: false, reason: 'duplicate' };
    const result = purchaseShopItem(db, userId, confirmation.item_id, confirmation.quantity, nowIso, `shop-confirm:${confirmationId}:${idempotencyKey}`);
    if (!result.purchased) {
      db.prepare("UPDATE economy_shop_purchase_confirmations SET status = 'expired' WHERE confirmation_id = ? AND status = 'confirmed'").run(confirmationId);
      return result;
    }
    return { ...result, confirmationId };
  })();
}

function cancelShopPurchase(db, confirmationId, userId, now = new Date()) {
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const result = db.prepare("UPDATE economy_shop_purchase_confirmations SET status = 'cancelled', completed_at = ? WHERE confirmation_id = ? AND user_id = ? AND status = 'pending'")
    .run(nowIso, confirmationId, userId);
  return result.changes > 0;
}

function adjustPlayerBalance(db, actorId, userId, amount, reason, now = new Date().toISOString()) {
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('Adjustment amount must be a nonzero whole number.');
  if (!reason?.trim()) throw new Error('A reason is required for balance adjustments.');
  return db.transaction(() => {
    const account = ensureEconomyAccount(db, userId, now);
    const nextWallet = account.wallet_balance + amount;
    if (nextWallet < 0) throw new Error('A player balance cannot go below zero.');
    if (!Number.isSafeInteger(nextWallet)) throw new Error('This adjustment exceeds the safe account balance limit.');
    db.prepare('UPDATE economy_accounts SET wallet_balance = ? WHERE user_id = ?').run(nextWallet, userId);
    recordEconomyTransaction(db, {
      userId,
      type: amount > 0 ? 'admin_credit' : 'admin_debit',
      amount: Math.abs(amount),
      walletAfter: nextWallet,
      bankAfter: account.bank_balance,
      description: `${reason} • staff ${actorId}`,
      now,
    });
    recordEconomyAudit(db, { actorId, targetId: userId, action: 'balance_adjusted', reason, previousValue: String(account.wallet_balance), newValue: String(nextWallet), now });
    return { userId, walletAfter: nextWallet, amount, reason };
  })();
}

function getEconomyLeaderboard(db, limit = 10, ranking = 'wealth') {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Leaderboard limit must be from 1 to 100.');
  const rankingExpressions = {
    wealth: 'wallet_balance + bank_balance',
    wallet: 'wallet_balance',
    bank: 'bank_balance',
    earnings: 'lifetime_earnings',
  };
  const rankingExpression = rankingExpressions[ranking];
  if (!rankingExpression) throw new Error('Choose wealth, wallet, bank, or earnings for the leaderboard.');
  return db.prepare(`
    SELECT user_id, wallet_balance, bank_balance, lifetime_earnings
    FROM economy_accounts
      ORDER BY ${rankingExpression} DESC, lifetime_earnings DESC, user_id ASC
    LIMIT ?
  `).all(limit);
}

function getEconomyTransactions(db, userId = null, limit = 25) {
  if (userId) {
    return db.prepare('SELECT * FROM economy_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, limit);
  }
  return db.prepare('SELECT * FROM economy_transactions ORDER BY created_at DESC LIMIT ?').all(limit);
}

function cashDropComponents(dropId, claimedBy = null) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:economy:drop:claim:${dropId}`).setLabel(claimedBy ? 'Claimed' : 'Claim Cash Drop')
      .setEmoji(claimedBy ? '✅' : '💵').setStyle(claimedBy ? ButtonStyle.Danger : ButtonStyle.Success).setDisabled(Boolean(claimedBy)),
  )];
}

function claimedCashDropEmbed(drop) {
  const claimant = drop.claimed_by ? `<@${drop.claimed_by}>` : 'A player';
  return makeEmbed(config.EMBED_COLORS.error, '💵 Cash Drop Claimed',
    `This cash drop is no longer available.\n\n**Claimed by:** ${claimant}\n**Reward:** ${formatCurrency(drop.amount)}\n**Claimed:** <t:${Math.floor(new Date(drop.claimed_at).getTime() / 1000)}:R>`);
}

async function updateClaimedCashDropMessage(client, db, drop) {
  if (!drop?.message_id || !drop.channel_id || !drop.claimed_by || drop.claimed_message_updated_at) return false;
  try {
    const channel = await client.channels.fetch(drop.channel_id);
    const message = channel?.isTextBased() ? await channel.messages.fetch(drop.message_id) : null;
    if (!message) return false;
    await message.edit({
      embeds: [claimedCashDropEmbed(drop)],
      components: cashDropComponents(drop.drop_id, drop.claimed_by),
      allowedMentions: { users: [drop.claimed_by] },
    });
    db.prepare('UPDATE economy_cash_drops SET claimed_message_updated_at = ? WHERE drop_id = ? AND claimed_by = ?')
      .run(new Date().toISOString(), drop.drop_id, drop.claimed_by);
    return true;
  } catch (error) {
    console.error(`Could not update claimed cash drop ${drop.drop_id}:`, error.message);
    return false;
  }
}

async function reconcileClaimedCashDropMessages(client, db) {
  const pendingUpdates = db.prepare("SELECT * FROM economy_cash_drops WHERE status = 'claimed' AND claimed_by IS NOT NULL AND claimed_message_updated_at IS NULL ORDER BY claimed_at").all();
  let updated = 0;
  for (const drop of pendingUpdates) {
    if (await updateClaimedCashDropMessage(client, db, drop)) updated += 1;
  }
  return updated;
}

function createManualEconomyCashDrop(db, { channelId, amount, maxClaims, lifetimeMinutes, actorId }, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Cash drop time is invalid.');
  if (!validId(channelId) || !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000
    || !Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 100
    || !Number.isSafeInteger(lifetimeMinutes) || lifetimeMinutes < 1 || lifetimeMinutes > 1440) {
    throw new Error('Cash drop channel, amount, claim limit, or lifetime is invalid.');
  }
  const nowIso = nowDate.toISOString();
  const dropId = randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO economy_cash_drops (drop_id, channel_id, amount, max_claims, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `).run(dropId, channelId, amount, maxClaims, nowIso, new Date(nowDate.getTime() + lifetimeMinutes * 60_000).toISOString());
    recordEconomyAudit(db, {
      actorId,
      action: 'cash_drop_created',
      newValue: JSON.stringify({ amount, maxClaims, lifetimeMinutes, channelId, manual: true }),
      now: nowIso,
    });
  })();
  return db.prepare('SELECT * FROM economy_cash_drops WHERE drop_id = ?').get(dropId);
}

function claimEconomyCashDrop(db, dropId, userId, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Cash drop claim time is invalid.');
  const nowIso = nowDate.toISOString();
  return db.transaction(() => {
    const drop = db.prepare('SELECT * FROM economy_cash_drops WHERE drop_id = ?').get(dropId);
    if (!drop) return { claimed: false, reason: 'missing' };
    if (drop.status !== 'open') return { claimed: false, reason: 'closed' };
    if (drop.expires_at <= nowIso) {
      db.prepare("UPDATE economy_cash_drops SET status = 'expired' WHERE drop_id = ? AND status = 'open'").run(dropId);
      return { claimed: false, reason: 'expired' };
    }
    if (db.prepare('SELECT 1 FROM economy_cash_drop_claims WHERE drop_id = ? AND user_id = ?').get(dropId, userId)) {
      return { claimed: false, reason: 'duplicate' };
    }
    const account = ensureEconomyAccount(db, userId, nowIso);
    const walletAfter = account.wallet_balance + drop.amount;
    const lifetimeAfter = account.lifetime_earnings + drop.amount;
    if (!Number.isSafeInteger(walletAfter) || !Number.isSafeInteger(lifetimeAfter)) {
      throw new Error('Cash drop would exceed the safe account balance limit. Contact management.');
    }
    const updated = db.prepare(`
      UPDATE economy_cash_drops
      SET claim_count = claim_count + 1, status = 'claimed', claimed_by = ?, claimed_at = ?
      WHERE drop_id = ? AND status = 'open' AND expires_at > ? AND claim_count = 0
    `).run(userId, nowIso, dropId, nowIso);
    if (!updated.changes) return { claimed: false, reason: 'closed' };
    db.prepare('INSERT INTO economy_cash_drop_claims (drop_id, user_id, amount, claimed_at) VALUES (?, ?, ?, ?)')
      .run(dropId, userId, drop.amount, nowIso);
    db.prepare('UPDATE economy_accounts SET wallet_balance = ?, lifetime_earnings = ? WHERE user_id = ?')
      .run(walletAfter, lifetimeAfter, userId);
    recordEconomyTransaction(db, {
      userId,
      type: 'cash_drop',
      amount: drop.amount,
      walletAfter,
      bankAfter: account.bank_balance,
      description: `Cash drop ${dropId}`,
      now: nowIso,
    });
    return { claimed: true, amount: drop.amount, walletAfter, claimCount: drop.claim_count + 1, maxClaims: drop.max_claims, dropId };
  })();
}

async function postPendingCashDrop(client, db, drop, processedAt) {
  let channel;
  try {
    channel = await client.channels.fetch(drop.channel_id);
    if (!channel?.isTextBased() || !channel.send) return { posted: false, reason: 'channel' };
    const message = await channel.send({
      embeds: [makeEmbed(getEconomySettings(db).panelColor, '💵 GV GR Cash Drop',
        `A cash drop is available! The first player to claim receives **${formatCurrency(drop.amount, getEconomySettings(db).currencyName)}**.\nExpires <t:${Math.floor(new Date(drop.expires_at).getTime() / 1000)}:R>.`)],
      components: cashDropComponents(drop.drop_id),
    });
    db.transaction(() => {
      db.prepare("UPDATE economy_cash_drops SET message_id = ?, status = 'open' WHERE drop_id = ? AND status = 'pending'")
        .run(message.id, drop.drop_id);
      if (drop.schedule_key) {
        const currentNextAt = Date.parse(getConfigValue(db, 'ECONOMY_CASH_DROP_NEXT_AT'));
        const nextAfterPost = processedAt.getTime() + getEconomySettings(db).cashDropIntervalMinutes * 60_000;
        if (!Number.isFinite(currentNextAt) || currentNextAt < nextAfterPost) {
          setConfigValue(db, 'ECONOMY_CASH_DROP_NEXT_AT', new Date(nextAfterPost).toISOString());
        }
      }
    })();
    return { posted: true, dropId: drop.drop_id, messageId: message.id };
  } catch (error) {
    console.error('Could not post Economy Cash Drop:', error.message);
    return { posted: false, reason: 'post', error };
  }
}

async function processEconomyCashDrops(client, db, now = new Date()) {
  const settings = getEconomySettings(db);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Cash drop scheduler time is invalid.');
  const nowIso = nowDate.toISOString();
  await reconcileClaimedCashDropMessages(client, db);
  db.prepare("UPDATE economy_cash_drops SET status = 'expired' WHERE status = 'open' AND expires_at <= ?").run(nowIso);

  let pending = db.prepare("SELECT * FROM economy_cash_drops WHERE status = 'pending' ORDER BY created_at LIMIT 1").get();
  if (pending && pending.expires_at <= nowIso) {
    db.prepare("UPDATE economy_cash_drops SET status = 'expired' WHERE drop_id = ? AND status = 'pending'").run(pending.drop_id);
    pending = db.prepare("SELECT * FROM economy_cash_drops WHERE status = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 1").get(nowIso);
  }
  if (!pending) {
    if (!settings.cashDropsEnabled) return { created: false, reason: 'disabled' };
    if (!validId(settings.cashDropChannelId)) return { created: false, reason: 'channel' };
    const intervalMinutes = settings.cashDropIntervalMinutes;
    if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440
      || !Number.isSafeInteger(settings.cashDropAmount) || settings.cashDropAmount < 1
      || !Number.isSafeInteger(settings.cashDropMaxClaims) || settings.cashDropMaxClaims < 1
      || !Number.isSafeInteger(settings.cashDropLifetimeMinutes) || settings.cashDropLifetimeMinutes < 1) {
      return { created: false, reason: 'settings' };
    }
    const intervalMs = intervalMinutes * 60_000;
    let scheduledAt = getConfigValue(db, 'ECONOMY_CASH_DROP_NEXT_AT');
    const scheduledTime = scheduledAt ? Date.parse(scheduledAt) : nowDate.getTime();
    if (!Number.isFinite(scheduledTime)) scheduledAt = nowIso;
    else if (nowDate.getTime() < scheduledTime) return { created: false, reason: 'not-due', nextAt: scheduledAt };
    const dueTime = Date.parse(scheduledAt) || nowDate.getTime();
    const nextTime = nowDate.getTime() + intervalMs;
    const dropId = randomUUID();
    const expiresAt = new Date(nowDate.getTime() + settings.cashDropLifetimeMinutes * 60_000).toISOString();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO economy_cash_drops (drop_id, schedule_key, channel_id, amount, max_claims, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(dropId, new Date(dueTime).toISOString(), settings.cashDropChannelId, settings.cashDropAmount, settings.cashDropMaxClaims, nowIso, expiresAt);
      setConfigValue(db, 'ECONOMY_CASH_DROP_NEXT_AT', new Date(nextTime).toISOString());
    })();
    pending = db.prepare('SELECT * FROM economy_cash_drops WHERE drop_id = ?').get(dropId);
  }
  return postPendingCashDrop(client, db, pending, nowDate);
}

function claimWorkReward(db, userId, settings, now = new Date()) {
  const invalid = validateWorkSettings(settings);
  if (invalid) throw new Error(invalid);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Work claim time is invalid.');
  const nowIso = nowDate.toISOString();
  const cooldownMs = settings.cooldownMinutes * 60_000;
  return db.transaction(() => {
    const account = ensureEconomyAccount(db, userId, nowIso);
    if (account.last_work_at) {
      const lastWorkTime = Date.parse(account.last_work_at);
      if (Number.isFinite(lastWorkTime)) {
        const nextWorkTime = lastWorkTime + cooldownMs;
        if (nowDate.getTime() < nextWorkTime) {
          return { claimed: false, nextClaimAt: new Date(nextWorkTime).toISOString(), account };
        }
      }
    }
    const reward = randomInt(settings.minimumReward, settings.maximumReward + 1);
    const walletBalance = account.wallet_balance + reward;
    const lifetimeEarnings = account.lifetime_earnings + reward;
    if (!Number.isSafeInteger(walletBalance) || !Number.isSafeInteger(lifetimeEarnings)) {
      throw new Error('This reward would exceed the safe account balance limit. Contact management.');
    }
    db.prepare(`
      UPDATE economy_accounts
      SET wallet_balance = ?, lifetime_earnings = ?, last_work_at = ?
      WHERE user_id = ?
    `).run(walletBalance, lifetimeEarnings, nowIso, userId);
    db.prepare(`
      INSERT INTO economy_transactions (id, user_id, type, amount, wallet_after, bank_after, created_at, metadata_json)
      VALUES (?, ?, 'work', ?, ?, ?, ?, '{}')
    `).run(randomUUID(), userId, reward, walletBalance, account.bank_balance, nowIso);
    return {
      claimed: true,
      reward,
      nextClaimAt: new Date(nowDate.getTime() + cooldownMs).toISOString(),
      account: db.prepare('SELECT * FROM economy_accounts WHERE user_id = ?').get(userId),
    };
  })();
}

function walletEmbed(account, username, settings) {
  const embed = makeEmbed(settings.panelColor, `💳 ${username}'s GV GR Wallet`,
    `**Wallet:** ${formatCurrency(account.wallet_balance, settings.currencyName)}\n**Bank:** ${formatCurrency(account.bank_balance, settings.currencyName)}\n**Lifetime earnings:** ${formatCurrency(account.lifetime_earnings, settings.currencyName)}\n**Total spent:** ${formatCurrency(account.total_spent, settings.currencyName)}\n**Total transferred:** ${formatCurrency(account.total_transferred, settings.currencyName)}\n**Account created:** <t:${Math.floor(new Date(account.created_at).getTime() / 1000)}:D>`)
    .setFooter({ text: `Account ID • ${account.user_id}` });
  return embed;
}

function economyPanelEmbed(settings) {
  return makeEmbed(settings.panelColor, '💰 GV GR | ECONOMY',
    'Manage your virtual roleplay money from one place. Your wallet and account history are private to you.\n\n'
    + `**Work:** Earn ${formatCurrency(settings.minimumReward, settings.currencyName)}–${formatCurrency(settings.maximumReward, settings.currencyName)} every ${settings.cooldownMinutes} minutes.\n`
    + `**Delivery Rush:** Deliver for ${formatCurrency(settings.deliveryMinimumReward, settings.currencyName)}–${formatCurrency(settings.deliveryMaximumReward * 2, settings.currencyName)} every ${settings.deliveryCooldownMinutes} minutes.\n`
    + `**Daily reward:** ${formatCurrency(settings.dailyReward, settings.currencyName)} every ${settings.dailyRewardCooldownHours} hours.\n`
    + `**Automatic cash drops:** ${settings.cashDropsEnabled ? 'Enabled' : 'Disabled'}; claim from the drop message when available.\n`
    + '**My Wallet:** View wallet, bank, and account totals. Shop, games, inventory, leaderboards, and private history are available below.')
    .setFooter({ text: 'GV GR • Virtual currency only' });
}

function economyPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gv:economy:wallet').setLabel('My Wallet').setEmoji('💳').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gv:economy:work').setLabel('Work').setEmoji('🧰').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:economy:bank').setLabel('Bank').setEmoji('🏦').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:shop').setLabel('Shop').setEmoji('🛍️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:economy:blackjack').setLabel('Blackjack').setEmoji('🃏').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:coinflip').setLabel('Coin Flip').setEmoji('🪙').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:roulette').setLabel('Roulette').setEmoji('🎡').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:chicken').setLabel('Chicken Road').setEmoji('🐔').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:transactions').setLabel('Transactions').setEmoji('📜').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:economy:daily').setLabel('Daily Rewards').setEmoji('🎁').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:delivery:start').setLabel('Delivery Rush').setEmoji('🚗').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:economy:inventory').setLabel('Inventory').setEmoji('🎒').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const deliveryScenarios = [
  'A hot meal needs to reach a family across town before it gets cold.',
  'A small parcel is due downtown before the rain starts.',
  'A customer is waiting for groceries near the Greenville countryside.',
  'A late-night order needs a careful trip through the city.',
  'A delivery has to cross town while traffic is building.',
];

const deliveryRoutes = {
  fast: { label: 'Fast Route', failure: 20, delayed: 40, successful: 85 },
  safe: { label: 'Safe Route', failure: 10, delayed: 30, successful: 90 },
  shortcut: { label: 'Shortcut', failure: 30, delayed: 45, successful: 85 },
};
const deliveryGameLifetimeMs = 5 * 60 * 1000;

function resolveDeliveryOutcome(route, roll) {
  const routeSettings = deliveryRoutes[route];
  if (!routeSettings || !Number.isInteger(roll) || roll < 0 || roll > 99) return null;
  if (roll < routeSettings.failure) return 'failed';
  if (roll < routeSettings.delayed) return 'delayed';
  if (roll < routeSettings.successful) return 'successful';
  return 'bonus';
}

function rewardForDeliveryOutcome(outcome, settings, rewardRandomInt = randomInt) {
  if (outcome === 'failed') return 0;
  if (outcome === 'successful') return rewardRandomInt(settings.deliveryMinimumReward, settings.deliveryMaximumReward + 1);
  if (outcome === 'bonus') return rewardRandomInt(settings.deliveryMaximumReward + 1, settings.deliveryMaximumReward * 2 + 1);
  if (outcome === 'delayed') {
    const upperBound = Math.max(2, Math.floor(settings.deliveryMinimumReward / 2) + 1);
    return rewardRandomInt(1, upperBound);
  }
  throw new Error('Unknown Delivery Rush result.');
}

function startDeliveryGame(db, userId, settings, now = new Date(), scenarioPicker = randomInt) {
  const invalid = validateDeliverySettings(settings);
  if (invalid) throw new Error(invalid);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Delivery Rush start time is invalid.');
  const nowIso = nowDate.toISOString();
  const cooldownMs = settings.deliveryCooldownMinutes * 60_000;
  try {
    return db.transaction(() => {
      ensureEconomyAccount(db, userId, nowIso);
      db.prepare(`
        UPDATE economy_delivery_games SET status = 'expired'
        WHERE user_id = ? AND status = 'active' AND expires_at <= ?
      `).run(userId, nowIso);
      const active = db.prepare("SELECT game_id, expires_at FROM economy_delivery_games WHERE user_id = ? AND status = 'active'")
        .get(userId);
      if (active) return { started: false, reason: 'active', expiresAt: active.expires_at };

      const cooldown = db.prepare('SELECT last_started_at FROM economy_delivery_cooldowns WHERE user_id = ?').get(userId);
      if (cooldown) {
        const nextStartAt = Date.parse(cooldown.last_started_at) + cooldownMs;
        if (Number.isFinite(nextStartAt) && nowDate.getTime() < nextStartAt) {
          return { started: false, reason: 'cooldown', nextStartAt: new Date(nextStartAt).toISOString() };
        }
      }

      const gameId = randomUUID();
      const scenario = deliveryScenarios[scenarioPicker(deliveryScenarios.length)];
      const expiresAt = new Date(nowDate.getTime() + deliveryGameLifetimeMs).toISOString();
      db.prepare(`
        INSERT INTO economy_delivery_games (game_id, user_id, scenario, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `).run(gameId, userId, scenario, nowIso, expiresAt);
      db.prepare(`
        INSERT INTO economy_delivery_cooldowns (user_id, last_started_at) VALUES (?, ?)
        ON CONFLICT(user_id) DO UPDATE SET last_started_at = excluded.last_started_at
      `).run(userId, nowIso);
      return { started: true, gameId, scenario, expiresAt };
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { started: false, reason: 'active' };
    throw error;
  }
}

function makeDeliveryGameComponents(gameId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:economy:delivery:choose:${gameId}:fast`).setLabel('Fast Route').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gv:economy:delivery:choose:${gameId}:safe`).setLabel('Safe Route').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gv:economy:delivery:choose:${gameId}:shortcut`).setLabel('Shortcut').setStyle(ButtonStyle.Secondary),
  )];
}

function deliveryResult(game, route, resultType, reward, walletBalance, settings) {
  const titles = {
    successful: '✅ Delivery Complete',
    bonus: '🌟 Bonus Delivery!',
    delayed: '⏱️ Delivery Delayed',
    failed: '🚧 Delivery Failed',
  };
  const outcomeText = {
    successful: 'You made the delivery on time.',
    bonus: 'You made the delivery quickly and earned a bonus.',
    delayed: 'The delivery arrived late, so the reward is smaller.',
    failed: 'The delivery could not be completed. No money was awarded.',
  };
  return makeEmbed(resultType === 'failed' ? config.EMBED_COLORS.error : config.EMBED_COLORS.active,
    titles[resultType], `${game.scenario}\n\n**Route:** ${deliveryRoutes[route].label}\n${outcomeText[resultType]}\n**Reward:** ${formatCurrency(reward, settings.currencyName)}${walletBalance === null ? '' : `\n**Wallet:** ${formatCurrency(walletBalance, settings.currencyName)}`}`)
    .setFooter({ text: 'GV GR • Delivery Rush' });
}

function resolveDeliveryGame(db, userId, gameId, route, settings, now = new Date(), outcomeRoll = () => randomInt(100), rewardRandomInt = randomInt) {
  const invalid = validateDeliverySettings(settings);
  if (invalid) throw new Error(invalid);
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Delivery Rush result time is invalid.');
  const nowIso = nowDate.toISOString();
  return db.transaction(() => {
    const game = db.prepare('SELECT * FROM economy_delivery_games WHERE game_id = ?').get(gameId);
    if (!game) return { completed: false, reason: 'missing' };
    if (game.user_id !== userId) return { completed: false, reason: 'owner' };
    if (game.status !== 'active') return { completed: false, reason: 'resolved' };
    if (game.expires_at <= nowIso) {
      db.prepare("UPDATE economy_delivery_games SET status = 'expired' WHERE game_id = ? AND status = 'active'").run(gameId);
      return { completed: false, reason: 'expired' };
    }
    if (!deliveryRoutes[route]) return { completed: false, reason: 'route' };

    const resultType = resolveDeliveryOutcome(route, outcomeRoll());
    const reward = rewardForDeliveryOutcome(resultType, settings, rewardRandomInt);
    const claimed = db.prepare(`
      UPDATE economy_delivery_games
      SET status = 'completed', route = ?, result_type = ?, reward = ?, resolved_at = ?
      WHERE game_id = ? AND user_id = ? AND status = 'active' AND expires_at > ?
    `).run(route, resultType, reward, nowIso, gameId, userId, nowIso);
    if (!claimed.changes) return { completed: false, reason: 'resolved' };

    let walletBalance = null;
    if (reward > 0) {
      const account = ensureEconomyAccount(db, userId, nowIso);
      walletBalance = account.wallet_balance + reward;
      const lifetimeEarnings = account.lifetime_earnings + reward;
      if (!Number.isSafeInteger(walletBalance) || !Number.isSafeInteger(lifetimeEarnings)) {
        throw new Error('This reward would exceed the safe account balance limit. Contact management.');
      }
      db.prepare('UPDATE economy_accounts SET wallet_balance = ?, lifetime_earnings = ? WHERE user_id = ?')
        .run(walletBalance, lifetimeEarnings, userId);
      db.prepare(`
        INSERT INTO economy_transactions (id, user_id, type, amount, wallet_after, bank_after, created_at, metadata_json)
        VALUES (?, ?, 'delivery_rush', ?, ?, ?, ?, ?)
      `).run(randomUUID(), userId, reward, walletBalance, account.bank_balance, nowIso, JSON.stringify({
        gameId,
        scenario: game.scenario,
        route,
        resultType,
      }));
    }
    return { completed: true, game, route, resultType, reward, walletBalance };
  })();
}

async function configureEconomy(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const options = interaction.options;
  const current = getEconomySettings(ctx.db);
  const channel = options.getChannel('channel');
  const minimumReward = options.getInteger('minimum-reward') ?? current.minimumReward;
  const maximumReward = options.getInteger('maximum-reward') ?? current.maximumReward;
  const cooldownMinutes = options.getInteger('cooldown-minutes') ?? current.cooldownMinutes;
  const deliveryMinimumReward = options.getInteger('delivery-minimum') ?? current.deliveryMinimumReward;
  const deliveryMaximumReward = options.getInteger('delivery-maximum') ?? current.deliveryMaximumReward;
  const deliveryCooldownMinutes = options.getInteger('delivery-cooldown-minutes') ?? current.deliveryCooldownMinutes;
  const maximumBet = options.getInteger('maximum-bet') ?? current.maximumBet;
  const dropChannel = options.getChannel('drop-channel');
  const dropAmount = options.getInteger('drop-amount') ?? current.cashDropAmount;
  const dropClaims = options.getInteger('drop-claims') ?? current.cashDropMaxClaims;
  const dropInterval = options.getInteger('drop-interval-minutes') ?? current.cashDropIntervalMinutes;
  const dropLifetime = options.getInteger('drop-lifetime-minutes') ?? current.cashDropLifetimeMinutes;
  const dropsEnabled = options.getBoolean?.('drop-enabled');
  const panelColorInput = options.getString?.('panel-color');
  const shopColorInput = options.getString?.('shop-color');
  const settingsError = validateWorkSettings({ minimumReward, maximumReward, cooldownMinutes });
  if (settingsError) return interaction.reply({ content: settingsError, ephemeral: true });
  const deliveryError = validateDeliverySettings({ deliveryMinimumReward, deliveryMaximumReward, deliveryCooldownMinutes });
  if (deliveryError) return interaction.reply({ content: deliveryError, ephemeral: true });
  if (!Number.isSafeInteger(maximumBet) || maximumBet < 1 || maximumBet > 1_000_000_000) {
    return interaction.reply({ content: 'Maximum game wager must be from 1 to 1,000,000,000.', ephemeral: true });
  }
  if (!Number.isSafeInteger(dropAmount) || dropAmount < 1 || dropAmount > 1_000_000_000
    || !Number.isSafeInteger(dropClaims) || dropClaims < 1 || dropClaims > 100
    || !Number.isSafeInteger(dropInterval) || dropInterval < 1 || dropInterval > 1440
    || !Number.isSafeInteger(dropLifetime) || dropLifetime < 1 || dropLifetime > 1440) {
    return interaction.reply({ content: 'Cash drop amount, claims, interval, or lifetime is outside the allowed range.', ephemeral: true });
  }
  const parseColor = (value) => value == null ? null : (/^#?[0-9a-f]{6}$/i.test(value) ? Number.parseInt(value.replace(/^#/, ''), 16) : NaN);
  const panelColor = parseColor(panelColorInput);
  const shopColor = parseColor(shopColorInput);
  if (Number.isNaN(panelColor) || Number.isNaN(shopColor)) {
    return interaction.reply({ content: 'Colors must be six-digit HEX values such as #1F7AE0.', ephemeral: true });
  }
  const changes = [];
  if (channel) changes.push(['ECONOMY_PANEL_CHANNEL_ID', channel.id]);
  if (dropChannel) changes.push(['ECONOMY_CASH_DROP_CHANNEL_ID', dropChannel.id]);
  if (options.getInteger('minimum-reward') !== null) changes.push(['ECONOMY_WORK_MIN_REWARD', minimumReward]);
  if (options.getInteger('maximum-reward') !== null) changes.push(['ECONOMY_WORK_MAX_REWARD', maximumReward]);
  if (options.getInteger('cooldown-minutes') !== null) changes.push(['ECONOMY_WORK_COOLDOWN_MINUTES', cooldownMinutes]);
  if (options.getInteger('delivery-minimum') !== null) changes.push(['ECONOMY_DELIVERY_MIN_REWARD', deliveryMinimumReward]);
  if (options.getInteger('delivery-maximum') !== null) changes.push(['ECONOMY_DELIVERY_MAX_REWARD', deliveryMaximumReward]);
  if (options.getInteger('delivery-cooldown-minutes') !== null) changes.push(['ECONOMY_DELIVERY_COOLDOWN_MINUTES', deliveryCooldownMinutes]);
  if (options.getInteger('maximum-bet') !== null) changes.push(['ECONOMY_GAME_MAX_BET', maximumBet]);
  if (options.getInteger('drop-amount') !== null) changes.push(['ECONOMY_CASH_DROP_AMOUNT', dropAmount]);
  if (options.getInteger('drop-claims') !== null) changes.push(['ECONOMY_CASH_DROP_MAX_CLAIMS', dropClaims]);
  if (options.getInteger('drop-interval-minutes') !== null) changes.push(['ECONOMY_CASH_DROP_INTERVAL_MINUTES', dropInterval]);
  if (options.getInteger('drop-lifetime-minutes') !== null) changes.push(['ECONOMY_CASH_DROP_LIFETIME_MINUTES', dropLifetime]);
  if (typeof dropsEnabled === 'boolean') changes.push(['ECONOMY_CASH_DROPS_ENABLED', dropsEnabled]);
  if (panelColor !== null) changes.push(['ECONOMY_PANEL_COLOR', panelColor]);
  if (shopColor !== null) changes.push(['ECONOMY_SHOP_COLOR', shopColor]);
  if (!changes.length) return interaction.reply({ content: 'Provide a panel channel or at least one Work setting to configure.', ephemeral: true });
  ctx.db.transaction(() => {
    for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
    recordEconomyAudit(ctx.db, { actorId: interaction.user.id, action: 'settings_updated', reason: 'Economy configuration updated', newValue: JSON.stringify(Object.fromEntries(changes)) });
  })();
  return interaction.reply({ content: `Updated Economy settings: ${changes.map(([key]) => `**${key}**`).join(', ')}.`, ephemeral: true });
}

async function publishEconomyPanel(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const settings = getEconomySettings(ctx.db);
  const settingsError = validateWorkSettings(settings);
  if (settingsError) return interaction.reply({ content: settingsError, ephemeral: true });
  if (!validId(settings.channelId)) {
    return interaction.reply({ content: 'Configure the Economy Panel channel with `/economy configure channel:<channel>` first.', ephemeral: true });
  }
  let channel;
  try {
    channel = await interaction.client.channels.fetch(settings.channelId);
  } catch (error) {
    console.error('Could not fetch the Economy Panel channel:', error.message);
  }
  if (!channel?.isTextBased() || !channel.send) {
    return interaction.reply({ content: 'The configured Economy Panel channel is unavailable.', ephemeral: true });
  }
  const permissions = channel.permissionsFor(interaction.guild.members.me);
  if (!permissions?.has(PermissionFlagsBits.ViewChannel)
    || !permissions.has(PermissionFlagsBits.SendMessages)
    || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
    return interaction.reply({ content: 'The bot needs View Channel, Send Messages, and Embed Links permissions in the Economy Panel channel.', ephemeral: true });
  }
  const customized = applyPanelCustomization(ctx.db, 'economy', economyPanelEmbed(settings), economyPanelComponents());
  const payload = { embeds: [customized.embed], components: customized.components };
  let message;
  let savedMessageId = settings.messageId;
  const header = await ensurePanelHeader(interaction.client, ctx.db, 'economy', channel);
  if (header.created && savedMessageId && settings.messageChannelId === channel.id) {
    try { const previous = await channel.messages.fetch(savedMessageId); if (previous.author?.id === interaction.client.user?.id) await previous.delete(); } catch {}
    setConfigValue(ctx.db, 'ECONOMY_PANEL_MESSAGE_ID', null);
    savedMessageId = null;
  }
  if (settings.messageChannelId === channel.id && validId(savedMessageId)) {
    try {
      const previous = await channel.messages.fetch(savedMessageId);
      message = await previous.edit(payload);
    } catch {
      message = null;
    }
  }
  const refreshed = Boolean(message);
  if (!message) {
    try {
      message = await channel.send(payload);
    } catch (error) {
      console.error('Could not publish the Economy Panel:', error.message);
      return interaction.reply({ content: 'I could not publish the Economy Panel. Check the channel permissions and try again.', ephemeral: true });
    }
  }
  if (!refreshed && validId(settings.messageChannelId) && settings.messageChannelId !== channel.id && validId(savedMessageId)) {
    try {
      const oldChannel = await interaction.client.channels.fetch(settings.messageChannelId);
      const oldMessage = oldChannel?.isTextBased() ? await oldChannel.messages.fetch(savedMessageId) : null;
      if (oldMessage?.author?.id === interaction.client.user?.id) await oldMessage.delete();
    } catch (error) {
      console.error('Could not remove the previous Economy Panel:', error.message);
    }
  }
  setConfigValue(ctx.db, 'ECONOMY_PANEL_MESSAGE_ID', message.id);
  setConfigValue(ctx.db, 'ECONOMY_PANEL_MESSAGE_CHANNEL_ID', channel.id);
  return interaction.reply({ content: `Economy Panel ${refreshed ? 'refreshed' : 'posted'} in <#${channel.id}>.`, ephemeral: true });
}

async function showWallet(interaction, ctx) {
  const settings = getEconomySettings(ctx.db);
  const account = getWallet(ctx.db, interaction.user.id);
  return interaction.reply({ embeds: [walletEmbed(account, interaction.user.username, settings)], ephemeral: true });
}

async function work(interaction, ctx) {
  const settings = getEconomySettings(ctx.db);
  let result;
  try {
    result = claimWorkReward(ctx.db, interaction.user.id, settings);
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (!result.claimed) {
    return interaction.reply({ content: `You have already worked recently. You can work again <t:${Math.floor(new Date(result.nextClaimAt).getTime() / 1000)}:R>.`, ephemeral: true });
  }
  return interaction.reply({
    embeds: [makeEmbed(config.EMBED_COLORS.active, '🧰 Work Complete',
      `You earned **${formatCurrency(result.reward, settings.currencyName)}**.\n**Wallet balance:** ${formatCurrency(result.account.wallet_balance, settings.currencyName)}\n**Next Work:** <t:${Math.floor(new Date(result.nextClaimAt).getTime() / 1000)}:R>`)],
    ephemeral: true,
  });
}

async function startDeliveryRush(interaction, ctx) {
  const settings = getEconomySettings(ctx.db);
  const invalid = validateDeliverySettings(settings);
  if (invalid) return interaction.reply({ content: invalid, ephemeral: true });
  let game;
  try {
    game = startDeliveryGame(ctx.db, interaction.user.id, settings);
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (!game.started) {
    if (game.reason === 'active') {
      return interaction.reply({ content: 'You already have an active Delivery Rush. Choose a route in your current game before starting another.', ephemeral: true });
    }
    return interaction.reply({ content: `Delivery Rush is cooling down. You can start again <t:${Math.floor(new Date(game.nextStartAt).getTime() / 1000)}:R>.`, ephemeral: true });
  }
  return interaction.reply({
    embeds: [makeEmbed(config.EMBED_COLORS.info, '🚗 Delivery Rush',
      `${game.scenario}\n\nChoose a route below. You have five minutes to finish the delivery.`)],
    components: makeDeliveryGameComponents(game.gameId),
    ephemeral: true,
  });
}

async function chooseDeliveryRoute(interaction, ctx, gameId, route) {
  const settings = getEconomySettings(ctx.db);
  let result;
  try {
    result = resolveDeliveryGame(ctx.db, interaction.user.id, gameId, route, settings);
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (!result.completed) {
    const messages = {
      missing: 'This Delivery Rush game could not be found.',
      owner: 'Only the player who started this Delivery Rush can choose its route.',
      resolved: 'This Delivery Rush was already completed.',
      expired: 'This Delivery Rush expired. Start a new game when your cooldown ends.',
      route: 'Choose one of the available delivery routes.',
    };
    return interaction.reply({ content: messages[result.reason] ?? 'This Delivery Rush is unavailable.', ephemeral: true });
  }
  return interaction.update({
    embeds: [deliveryResult(result.game, result.route, result.resultType, result.reward, result.walletBalance, settings)],
    components: [],
  });
}

async function handleBankCommand(interaction, ctx) {
  const action = interaction.options.getSubcommand();
  const amount = interaction.options.getInteger('amount', true);
  const description = interaction.options.getString('description') || 'Economy transfer';
  try {
    if (action === 'deposit') {
      const result = depositToBank(ctx.db, interaction.user.id, amount, description);
      return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.active, '🏦 Bank Deposit', `Deposited **${formatCurrency(amount, getEconomySettings(ctx.db).currencyName)}** to your bank account.\n**Wallet:** ${formatCurrency(result.walletAfter, getEconomySettings(ctx.db).currencyName)}\n**Bank:** ${formatCurrency(result.bankAfter, getEconomySettings(ctx.db).currencyName)}`)], ephemeral: true });
    }
    if (action === 'withdraw') {
      const result = withdrawFromBank(ctx.db, interaction.user.id, amount, description);
      return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.active, '🏦 Bank Withdrawal', `Withdrew **${formatCurrency(amount, getEconomySettings(ctx.db).currencyName)}** from your bank account.\n**Wallet:** ${formatCurrency(result.walletAfter, getEconomySettings(ctx.db).currencyName)}\n**Bank:** ${formatCurrency(result.bankAfter, getEconomySettings(ctx.db).currencyName)}`)], ephemeral: true });
    }
    if (action === 'transfer') {
      const target = interaction.options.getUser('member', true);
      const result = transferToPlayer(ctx.db, interaction.user.id, target.id, amount, description, new Date().toISOString(), interaction.id);
      return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, '💸 Transfer Complete', `Transferred **${formatCurrency(amount, getEconomySettings(ctx.db).currencyName)}** to <@${target.id}>.\n**Sender wallet:** ${formatCurrency(result.sender.wallet_balance, getEconomySettings(ctx.db).currencyName)}\n**Recipient wallet:** ${formatCurrency(result.recipient.wallet_balance, getEconomySettings(ctx.db).currencyName)}`)], ephemeral: true });
    }
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  return interaction.reply({ content: 'Bank action not recognized.', ephemeral: true });
}

async function handleDailyRewardCommand(interaction, ctx) {
  const settings = getEconomySettings(ctx.db);
  const result = claimDailyReward(ctx.db, interaction.user.id, settings, new Date());
  if (!result.claimed) {
    return interaction.reply({ content: `Your daily reward is still cooling down. It will be ready <t:${Math.floor(new Date(result.nextRewardAt).getTime() / 1000)}:R>.`, ephemeral: true });
  }
  return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.active, '🎁 Daily Reward Claimed', `You claimed **${formatCurrency(result.amount, settings.currencyName)}**.\n**Wallet:** ${formatCurrency(result.walletAfter, settings.currencyName)}`)], ephemeral: true });
}

function shopPagePayload(db, page = 0) {
  const settings = getEconomySettings(db);
  const items = listShopItems(db, false).filter((item) => item.stock > 0);
  const pageSize = 5;
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const shown = items.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const description = shown.length
    ? shown.map((item) => `**${item.name}** • ${formatCurrency(item.price)} • Stock: ${item.stock}\n${item.description || 'No description'}`).join('\n\n').slice(0, 3900)
    : 'The shop is empty right now.';
  const rows = [];
  for (let index = 0; index < shown.length; index += 2) {
    const row = new ActionRowBuilder();
    for (const item of shown.slice(index, index + 2)) {
      row.addComponents(new ButtonBuilder().setCustomId(`gv:economy:shop:buy:${item.id}`)
        .setLabel(`Buy ${item.name}`.slice(0, 80)).setEmoji('🛒').setStyle(ButtonStyle.Success));
    }
    rows.push(row);
  }
  if (pageCount > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:economy:shop:page:${safePage - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(safePage === 0),
      new ButtonBuilder().setCustomId(`gv:economy:shop:page:${safePage + 1}`).setLabel(`Page ${safePage + 1}/${pageCount}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId(`gv:economy:shop:page:${safePage + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(safePage >= pageCount - 1),
    ));
  }
  const customized = applyPanelCustomization(db, 'shop', makeEmbed(settings.shopColor, '🛍️ GV GR Shop', description), rows);
  return {
    embeds: [customized.embed],
    components: customized.components,
    ephemeral: true,
  };
}

function shopPurchaseConfirmationPayload(prepared) {
  const { item, quantity, totalCost, confirmationId, expiresAt } = prepared;
  const embed = makeEmbed(prepared.panelColor, `🛒 Confirm Purchase • ${item.name}`,
    `${item.description || 'No description'}\n\n**Price:** ${formatCurrency(totalCost)}${quantity > 1 ? ` (${quantity} × ${formatCurrency(item.price)})` : ''}\n**Available stock:** ${item.stock}\n\nConfirm to complete this purchase. This confirmation expires <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:R>.`);
  if (item.image_url) embed.setImage(item.image_url);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gv:economy:shop:confirm:${confirmationId}`).setLabel('Confirm Purchase').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`gv:economy:shop:cancel:${confirmationId}`).setLabel('Cancel').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    )],
    ephemeral: true,
  };
}

function amountModal(customId, title, label = 'Amount in dollars') {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('amount').setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
    ),
  );
}

function economyTransactionsEmbed(db, userId, title = 'Your Transactions') {
  const rows = getEconomyTransactions(db, userId, 15);
  const settings = getEconomySettings(db);
  const description = rows.length
    ? rows.map((row) => {
      let note = '';
      try { note = JSON.parse(row.metadata_json).description || ''; } catch {}
      const direction = ['bank_deposit', 'player_transfer', 'shop_purchase', 'admin_debit'].includes(row.type) || row.type.endsWith('_bet') ? '-' : '+';
      return `**${row.type.replaceAll('_', ' ')}** • ${direction}${formatCurrency(row.amount, settings.currencyName)}\n${note ? `${note} • ` : ''}<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`;
    }).join('\n\n')
    : 'No economy transactions have been recorded yet.';
  return makeEmbed(settings.panelColor, title, description.slice(0, 4000));
}

function gameBetModal(gameType) {
  const modal = new ModalBuilder().setCustomId(`gv:economy:modal:game:${gameType}`).setTitle(`${gameType === 'chicken' ? 'Chicken Road' : gameType[0].toUpperCase() + gameType.slice(1)} Wager`);
  modal.addComponents(new ActionRowBuilder().addComponents(
    new TextInputBuilder().setCustomId('bet').setLabel('Wager from your wallet').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12),
  ));
  if (gameType === 'coinflip' || gameType === 'roulette') {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('choice').setLabel(gameType === 'coinflip' ? 'heads or tails' : 'red, black, or green').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10),
    ));
  }
  return modal;
}

function blackjackComponents(gameId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:economy:game:blackjack:${gameId}:hit`).setLabel('Hit').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gv:economy:game:blackjack:${gameId}:stand`).setLabel('Stand').setStyle(ButtonStyle.Success),
  )];
}

function chickenComponents(gameId) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`gv:economy:game:chicken:${gameId}:step`).setLabel('Take another step').setEmoji('🐔').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`gv:economy:game:chicken:${gameId}:cashout`).setLabel('Cash out').setStyle(ButtonStyle.Success),
  )];
}

function blackjackEmbed(result, settings) {
  const state = result.state;
  const active = result.active === true || (result.started && !result.status);
  const dealerCards = active ? `${cardLabel(state.dealerCards[0])}, ??` : state.dealerCards.map(cardLabel).join(', ');
  const dealerTotal = active ? '' : ` (${handValue(state.dealerCards)})`;
  const playerCards = state.playerCards.map(cardLabel).join(', ');
  let description = `**Your hand:** ${playerCards} (${handValue(state.playerCards)})\n**Dealer:** ${dealerCards}${dealerTotal}\n**Wager:** ${formatCurrency(result.bet, settings.currencyName)}`;
  if (!active) {
    const outcome = result.status === 'won' ? 'You won.' : result.status === 'push' ? 'Push. Your wager was returned.' : result.status === 'expired' ? 'The game expired; the wager was forfeited.' : 'The dealer won.';
    description += `\n\n${outcome}\n**Payout:** ${formatCurrency(result.payout ?? 0, settings.currencyName)}`;
  }
  return makeEmbed(result.status === 'lost' ? config.EMBED_COLORS.error : settings.panelColor, '🃏 Blackjack', description);
}

function chickenEmbed(result, settings) {
  const state = result.state;
  const active = result.active === true || (result.started && !result.status);
  const description = active
    ? `Steps: **${state.steps}** • Cash-out multiplier: **${state.multiplier}x**\nWager: ${formatCurrency(result.bet, settings.currencyName)}\nCash out now or risk another step.`
    : `${result.status === 'won' ? `You cashed out after ${state.steps} steps.` : result.status === 'expired' ? 'The road expired; your wager was forfeited.' : `The road ended at step ${state.crashedAtStep ?? state.steps + 1}.`}\n**Payout:** ${formatCurrency(result.payout ?? 0, settings.currencyName)}`;
  return makeEmbed(result.status === 'lost' ? config.EMBED_COLORS.error : settings.panelColor, '🐔 Chicken Road', description);
}

function gameStartFailure(result) {
  return result.reason === 'funds' ? 'You do not have enough wallet balance for that wager.' : 'Finish your active economy game before starting another.';
}

async function startBlackjackInteraction(interaction, ctx, bet) {
  const settings = getEconomySettings(ctx.db);
  let result;
  try { result = beginBlackjack(ctx.db, interaction.user.id, bet, new Date()); } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (!result.started) return interaction.reply({ content: gameStartFailure(result), ephemeral: true });
  const active = !result.status;
  return interaction.reply({ embeds: [blackjackEmbed(result, settings)], components: active ? blackjackComponents(result.gameId) : [], ephemeral: true });
}

async function startChickenInteraction(interaction, ctx, bet) {
  const settings = getEconomySettings(ctx.db);
  let result;
  try { result = startChickenRoad(ctx.db, interaction.user.id, bet, new Date()); } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (!result.started) return interaction.reply({ content: gameStartFailure(result), ephemeral: true });
  return interaction.reply({ embeds: [chickenEmbed(result, settings)], components: chickenComponents(result.gameId), ephemeral: true });
}

async function startQuickGame(interaction, ctx, gameType, bet, choice) {
  const settings = getEconomySettings(ctx.db);
  let result;
  try {
    result = gameType === 'coinflip'
      ? playCoinFlip(ctx.db, interaction.user.id, bet, choice)
      : playRoulette(ctx.db, interaction.user.id, bet, choice);
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (!result.started) return interaction.reply({ content: gameStartFailure(result), ephemeral: true });
  const won = result.status === 'won';
  const detail = gameType === 'coinflip'
    ? `You chose **${result.state.choice}**. The coin landed on **${result.state.result}**.`
    : `The wheel landed on **${result.state.pocket} (${result.state.result})**. You chose **${result.state.choice}**.`;
  return interaction.reply({
    embeds: [makeEmbed(won ? settings.panelColor : config.EMBED_COLORS.error, gameType === 'coinflip' ? '🪙 Coin Flip' : '🎡 Roulette', `${detail}\n**Wager:** ${formatCurrency(bet, settings.currencyName)}\n**Payout:** ${formatCurrency(result.payout, settings.currencyName)}${result.walletAfter === null ? '' : `\n**Wallet:** ${formatCurrency(result.walletAfter, settings.currencyName)}`}`)],
    ephemeral: true,
  });
}

async function handleGameButton(interaction, ctx) {
  const blackjack = interaction.customId.match(/^gv:economy:game:blackjack:([a-f0-9-]{36}):(hit|stand)$/);
  const chicken = interaction.customId.match(/^gv:economy:game:chicken:([a-f0-9-]{36}):(step|cashout)$/);
  if (!blackjack && !chicken) return null;
  const settings = getEconomySettings(ctx.db);
  let result;
  try {
    result = blackjack
      ? resolveBlackjackAction(ctx.db, interaction.user.id, blackjack[1], blackjack[2])
      : resolveChickenAction(ctx.db, interaction.user.id, chicken[1], chicken[2]);
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
  if (result.reason) {
    const messages = { owner: 'Only the player who started this game can use these controls.', missing: 'This game no longer exists.', resolved: 'This game has already been settled.', expired: 'This game expired and the wager was forfeited.', 'no-steps': 'Take at least one safe step before cashing out.' };
    return interaction.reply({ content: messages[result.reason] ?? 'That game action is unavailable.', ephemeral: true });
  }
  const isBlackjack = Boolean(blackjack);
  return interaction.update({
    embeds: [isBlackjack ? blackjackEmbed(result, settings) : chickenEmbed(result, settings)],
    components: result.active ? (isBlackjack ? blackjackComponents(blackjack[1]) : chickenComponents(chicken[1])) : [],
  });
}

async function showBankPanel(interaction, ctx) {
  const account = getWallet(ctx.db, interaction.user.id);
  const settings = getEconomySettings(ctx.db);
  return interaction.reply({
    embeds: [makeEmbed(settings.panelColor, '🏦 GV GR Bank', `**Wallet:** ${formatCurrency(account.wallet_balance, settings.currencyName)}\n**Bank:** ${formatCurrency(account.bank_balance, settings.currencyName)}\n\nChoose a bank action below.`)],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:economy:bank:deposit').setLabel('Deposit').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:economy:bank:withdraw').setLabel('Withdraw').setStyle(ButtonStyle.Primary),
    )],
    ephemeral: true,
  });
}

async function handleShopCommand(interaction, ctx) {
  const action = interaction.options.getSubcommand();
  if (action === 'shop' || action === 'list') {
    return interaction.reply(shopPagePayload(ctx.db));
  }
  if (action === 'item-add') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const name = interaction.options.getString('name', true);
    const description = interaction.options.getString('description') || '';
    const price = interaction.options.getInteger('price', true);
    const stock = interaction.options.getInteger('stock', true);
    const category = interaction.options.getString('category') || 'General';
    const image = interaction.options.getString('image') || null;
    const enabled = interaction.options.getBoolean('enabled') ?? true;
    const purchaseLimit = interaction.options.getInteger('purchase-limit');
    const itemId = createShopItem(ctx.db, { name, description, price, stock, category, imageUrl: image, enabled, purchaseLimit }, interaction.user.id);
    return interaction.reply({ content: `Added shop item **${name}** (ID: \`${itemId}\`) for ${formatCurrency(price, getEconomySettings(ctx.db).currencyName)}.`, ephemeral: true });
  }
  if (action === 'item-edit') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const itemId = interaction.options.getString('item-id', true);
    const changes = {
      name: interaction.options.getString('name'),
      description: interaction.options.getString('description'),
      price: interaction.options.getInteger('price'),
      stock: interaction.options.getInteger('stock'),
      category: interaction.options.getString('category'),
      imageUrl: interaction.options.getString('image'),
      purchaseLimit: interaction.options.getInteger('purchase-limit'),
    };
    const result = editShopItem(ctx.db, itemId, changes, interaction.user.id);
    return interaction.reply({ content: result.updated ? `Updated **${result.item.name}** (\`${itemId}\`).` : 'Shop item not found or no editable fields were provided.', ephemeral: true });
  }
  if (action === 'item-remove') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const result = removeShopItem(ctx.db, interaction.options.getString('item-id', true), interaction.user.id);
    return interaction.reply({ content: result.removed ? 'Shop item removed from the active catalog. Existing purchase records are preserved.' : 'Shop item not found.', ephemeral: true });
  }
  if (action === 'item-toggle') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const itemId = interaction.options.getString('item-id', true);
    const enabled = interaction.options.getBoolean('enabled', true);
    const result = editShopItem(ctx.db, itemId, { enabled }, interaction.user.id);
    return interaction.reply({ content: result.updated ? `**${result.item.name}** is now ${enabled ? 'enabled' : 'disabled'}.` : 'Shop item not found.', ephemeral: true });
  }
  if (action === 'manage') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const settings = getEconomySettings(ctx.db);
    const items = listShopItems(ctx.db, true);
    const description = `**Automatic cash drops:** ${settings.cashDropsEnabled ? 'Enabled' : 'Disabled'} • every ${settings.cashDropIntervalMinutes} minutes • ${formatCurrency(settings.cashDropAmount, settings.currencyName)} each • ${settings.cashDropMaxClaims} claims\n**Panel color:** #${settings.panelColor.toString(16).padStart(6, '0').toUpperCase()} • **Shop color:** #${settings.shopColor.toString(16).padStart(6, '0').toUpperCase()}\n**Products:** ${items.length} active or disabled\n\nUse \/salary to manage Town Jobs pay, \/economy configure for rewards/drop settings, and \/economy item-add, item-edit, item-toggle, or item-remove for products.`;
    return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.management, 'Economy Management', description)], ephemeral: true });
  }
  if (action === 'inventory') {
    const inventory = getPlayerInventory(ctx.db, interaction.user.id);
    const description = inventory.length
      ? inventory.map((entry) => `**${entry.item_name}** • Qty: ${entry.quantity}\n${entry.description || 'No description'}`).join('\n\n')
      : 'You do not own any shop items yet.';
    return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, '🎒 Inventory', description.slice(0, 4000))], ephemeral: true });
  }
  if (action === 'history') {
    const history = getPlayerPurchaseHistory(ctx.db, interaction.user.id, 20);
    const description = history.length
      ? history.map((entry) => `**${entry.item_name}** • ${entry.quantity}x • ${formatCurrency(entry.total_cost, getEconomySettings(ctx.db).currencyName)} • <t:${Math.floor(new Date(entry.created_at).getTime() / 1000)}:d>`).join('\n')
      : 'You have not purchased any items yet.';
    return interaction.reply({ embeds: [makeEmbed(config.EMBED_COLORS.info, '🧾 Purchase History', description.slice(0, 4000))], ephemeral: true });
  }
  if (action === 'purchase') {
    const productQuery = interaction.options.getString('product', true).trim();
    const item = ctx.db.prepare('SELECT id, name FROM economy_shop_items WHERE deleted = 0 AND (id = ? OR lower(name) = lower(?)) LIMIT 1')
      .get(productQuery, productQuery);
    if (!item) return interaction.reply({ content: 'That shop product could not be found. Browse `/economy shop` for available product names.', ephemeral: true });
    const quantity = interaction.options.getInteger('quantity') ?? 1;
    let prepared;
    try {
      prepared = prepareShopPurchase(ctx.db, interaction.user.id, item.id, quantity);
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    if (!prepared.prepared) {
      const reasons = { missing: 'That item does not exist.', disabled: 'That item is disabled.', stock: 'There is not enough stock available.', funds: 'You do not have enough money to purchase this item.', limit: 'You have reached the purchase limit for this item.', pending: 'You already have a pending confirmation for this item.' };
      return interaction.reply({ content: reasons[prepared.reason] || 'That purchase could not be started.', ephemeral: true });
    }
    return interaction.reply(shopPurchaseConfirmationPayload(prepared));
  }
  return interaction.reply({ content: 'This shop action is not available yet.', ephemeral: true });
}

function economyStaffComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:economy:staff:settings').setLabel('Rewards & Colors').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gv:economy:staff:products').setLabel('Products').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:staff:salaries').setLabel('Salaries').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:staff:audit').setLabel('Economy Audit').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:staff:balance').setLabel('Adjust Balance').setStyle(ButtonStyle.Danger),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:economy:staff:toggle-drops').setLabel('Toggle Cash Drops').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:economy:staff:work-rewards').setLabel('Work & Daily Rewards').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('gv:economy:staff:manual-drop').setLabel('Manual Cash Drop').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:economy:staff:drop-history').setLabel('Drop History').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:staff:purchases').setLabel('Purchase Review').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:economy:staff:transactions').setLabel('Transaction Review').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('gv:economy:staff:game-settings').setLabel('Delivery Rush Settings').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('mgmt:overview').setLabel('Back to Management').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function economyStaffEmbed(db) {
  const settings = getEconomySettings(db);
  const nextDrop = getConfigValue(db, 'ECONOMY_CASH_DROP_NEXT_AT');
  return makeEmbed(config.EMBED_COLORS.management, 'GV GR Economy Management',
    `**Work:** ${formatCurrency(settings.minimumReward, settings.currencyName)}–${formatCurrency(settings.maximumReward, settings.currencyName)} every ${settings.cooldownMinutes} minutes\n`
    + `**Town Jobs salaries:** ${getConfigValue(db, 'TOWN_JOBS_SALARIES_ENABLED') === false ? 'Paused' : 'Running'} • manage with \/salary\n`
    + `**Cash drops:** ${settings.cashDropsEnabled ? 'Enabled' : 'Disabled'} • every ${settings.cashDropIntervalMinutes}m • ${settings.cashDropMaxClaims} players × ${formatCurrency(settings.cashDropAmount, settings.currencyName)}${nextDrop ? `\n**Next drop:** <t:${Math.floor(new Date(nextDrop).getTime() / 1000)}:R>` : ''}\n`
    + `**HEX colors:** Panel #${settings.panelColor.toString(16).padStart(6, '0').toUpperCase()} • Shop #${settings.shopColor.toString(16).padStart(6, '0').toUpperCase()}\n\nUse product commands \/economy item-add, item-edit, item-toggle, and item-remove to manage the catalog.`);
}

function economyStaffSettingsModal() {
  const modal = new ModalBuilder().setCustomId('gv:economy:modal:staff-settings').setTitle('Cash Drops & HEX Colors');
  const fields = [
    ['drop-amount', 'Cash drop amount per player'],
    ['drop-interval', 'Cash drop interval in minutes'],
    ['drop-claims', 'Maximum cash drop claims'],
    ['panel-color', 'Panel HEX color (#RRGGBB)'],
    ['shop-color', 'Shop HEX color (#RRGGBB)'],
  ];
  for (const [id, label] of fields) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12),
    ));
  }
  return modal;
}

function economyWorkRewardsModal() {
  const modal = new ModalBuilder().setCustomId('gv:economy:modal:staff-work-rewards').setTitle('Work & Daily Rewards');
  for (const [id, label] of [
    ['work-min', 'Minimum Work reward'],
    ['work-max', 'Maximum Work reward'],
    ['daily-amount', 'Daily reward amount'],
    ['daily-cooldown', 'Daily cooldown hours'],
  ]) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12),
    ));
  }
  return modal;
}

function economyDeliverySettingsModal(db) {
  const settings = getEconomySettings(db);
  const modal = new ModalBuilder().setCustomId('gv:economy:modal:staff-delivery-settings').setTitle('Game & Delivery Rush Settings');
  for (const [id, label, value] of [
    ['game-max-bet', 'Maximum game wager', settings.maximumBet],
    ['delivery-min', 'Minimum delivery reward', settings.deliveryMinimumReward],
    ['delivery-max', 'Maximum delivery reward', settings.deliveryMaximumReward],
    ['delivery-cooldown', 'Cooldown in minutes', settings.deliveryCooldownMinutes],
  ]) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(12).setValue(String(value)),
    ));
  }
  return modal;
}

function economyManualDropModal(db) {
  const settings = getEconomySettings(db);
  return new ModalBuilder().setCustomId('gv:economy:modal:staff-drop').setTitle('Create Manual Cash Drop')
    .addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel('Cash per player').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12).setValue(String(settings.cashDropAmount))),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('claims').setLabel('Maximum number of claimants').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(3).setValue(String(settings.cashDropMaxClaims))),
    );
}

function economyProductModal(mode, item = null) {
  const modal = new ModalBuilder()
    .setCustomId(mode === 'add' ? 'gv:economy:modal:staff-product:add' : `gv:economy:modal:staff-product:edit:${item.id}`)
    .setTitle(mode === 'add' ? 'Add Economy Product' : 'Edit Economy Product');
  const fields = [
    ['name', 'Product name', item?.name ?? ''],
    ['price', 'Price in dollars', String(item?.price ?? '')],
    ['stock', 'Available stock', String(item?.stock ?? '')],
    ['description', 'Product description', item?.description ?? ''],
    ['category', 'Category', item?.category ?? 'General'],
  ];
  for (const [id, label, value] of fields) {
    const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(id === 'description' ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(id !== 'description').setMaxLength(id === 'description' ? 500 : 100);
    if (value) input.setValue(value);
    modal.addComponents(new ActionRowBuilder().addComponents(
      input,
    ));
  }
  return modal;
}

function economyProductImageModal(item) {
  return new ModalBuilder().setCustomId(`gv:economy:modal:staff-product-image:${item.id}`).setTitle('Set Product Image')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('image').setLabel('HTTPS image URL (blank removes image)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500).setValue(item.image_url ?? ''),
    ));
}

function economyProductsPayload(db) {
  const items = listShopItems(db, true);
  const embedDescription = items.length
    ? items.slice(0, 25).map((item) => `**${item.name}** • ${formatCurrency(item.price, getEconomySettings(db).currencyName)} • stock ${item.stock} • ${item.enabled ? 'enabled' : 'disabled'}`).join('\n\n')
    : 'No products exist yet. Use Add Product to create the first item.';
  const components = [];
  if (items.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('gv:economy:staff:product-select').setPlaceholder('Select a product to manage')
        .addOptions(items.slice(0, 25).map((item) => ({
          label: item.name.slice(0, 100),
          value: item.id,
          description: `${item.enabled ? 'Enabled' : 'Disabled'} • stock ${item.stock}`.slice(0, 100),
        }))),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gv:economy:staff:add-product').setLabel('Add Product').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('gv:economy:staff:back').setLabel('Back to Economy').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [makeEmbed(config.EMBED_COLORS.management, 'Economy Products', embedDescription.slice(0, 3900))], components };
}

function economyBalanceModal() {
  const modal = new ModalBuilder().setCustomId('gv:economy:modal:staff-balance').setTitle('Adjust Player Wallet');
  for (const [id, label, maxLength] of [
    ['user-id', 'Player Discord ID', 20],
    ['amount', 'Signed amount (+credit / -debit)', 12],
    ['reason', 'Required audit reason', 500],
  ]) {
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(id === 'reason' ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(true).setMaxLength(maxLength),
    ));
  }
  return modal;
}

async function handleEconomyManagementButton(interaction, ctx) {
  if (interaction.customId !== 'mgmt:economy' && !interaction.customId.startsWith('gv:economy:staff:')) return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  if (interaction.customId === 'mgmt:economy') {
    return interaction.update({ embeds: [economyStaffEmbed(ctx.db)], components: economyStaffComponents() });
  }
  const productAction = interaction.customId.match(/^gv:economy:staff:product:(edit|toggle|remove|image):([a-f0-9-]{36})$/);
  if (productAction) {
    const [, action, itemId] = productAction;
    const item = ctx.db.prepare('SELECT * FROM economy_shop_items WHERE id = ? AND deleted = 0').get(itemId);
    if (!item) return interaction.reply({ content: 'That economy product is no longer available.', ephemeral: true });
    if (action === 'edit') return interaction.showModal(economyProductModal('edit', item));
    if (action === 'image') return interaction.showModal(economyProductImageModal(item));
    if (action === 'remove') {
      removeShopItem(ctx.db, itemId, interaction.user.id);
      return interaction.update(economyProductsPayload(ctx.db));
    }
    editShopItem(ctx.db, itemId, { enabled: !item.enabled }, interaction.user.id);
    return interaction.update(economyProductsPayload(ctx.db));
  }
  const action = interaction.customId.split(':').at(-1);
  if (action === 'settings') return interaction.showModal(economyStaffSettingsModal());
  if (action === 'work-rewards') return interaction.showModal(economyWorkRewardsModal());
  if (action === 'game-settings') return interaction.showModal(economyDeliverySettingsModal(ctx.db));
  if (action === 'manual-drop') return interaction.showModal(economyManualDropModal(ctx.db));
  if (action === 'balance') return interaction.showModal(economyBalanceModal());
  if (action === 'add-product') return interaction.showModal(economyProductModal('add'));
  if (action === 'back') return interaction.update({ embeds: [economyStaffEmbed(ctx.db)], components: economyStaffComponents() });
  if (action === 'toggle-drops') {
    const enabled = !getEconomySettings(ctx.db).cashDropsEnabled;
    setConfigValue(ctx.db, 'ECONOMY_CASH_DROPS_ENABLED', enabled);
    recordEconomyAudit(ctx.db, { actorId: interaction.user.id, action: 'cash_drops_toggled', newValue: String(enabled) });
    return interaction.update({ embeds: [economyStaffEmbed(ctx.db)], components: economyStaffComponents() });
  }
  if (action === 'products') {
    return interaction.update(economyProductsPayload(ctx.db));
  }
  if (action === 'salaries') {
    const rows = ctx.db.prepare('SELECT role_id, salary, enabled FROM economy_job_salaries ORDER BY role_id').all();
    const description = rows.length
      ? rows.map((row) => `<@&${row.role_id}> • ${formatCurrency(row.salary, getEconomySettings(ctx.db).currencyName)} / 30m • ${row.enabled ? 'enabled' : 'disabled'}`).join('\n')
      : 'No Town Jobs salaries are configured.';
    return interaction.update({ embeds: [makeEmbed(config.EMBED_COLORS.info, 'Town Jobs Salaries', `${description}\n\nUse \/salary add, set, remove, toggle, policy, pause, or resume to manage payroll.`.slice(0, 4000))], components: economyStaffComponents() });
  }
  if (action === 'audit') {
    const rows = ctx.db.prepare("SELECT action, target_id, actor_id, reason, previous_value, new_value, created_at FROM staff_audit_logs WHERE substr(action, 1, 8) = 'economy_' ORDER BY id DESC LIMIT 15").all();
    const description = rows.length
      ? rows.map((row) => `**${row.action.replace('economy_', '').replaceAll('_', ' ')}** • <@${row.actor_id}> → ${row.target_id === 'economy' ? 'economy settings' : `<@${row.target_id}>`}\n${row.reason || ''}${row.previous_value || row.new_value ? ` • ${row.previous_value ?? '—'} → ${row.new_value ?? '—'}` : ''} • <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`).join('\n\n')
      : 'No economy staff actions have been audited yet.';
    return interaction.update({ embeds: [makeEmbed(config.EMBED_COLORS.info, 'Economy Staff Audit', description.slice(0, 4000))], components: economyStaffComponents() });
  }
  if (action === 'drop-history') {
    const rows = ctx.db.prepare('SELECT * FROM economy_cash_drops ORDER BY created_at DESC LIMIT 15').all();
    const description = rows.length
      ? rows.map((row) => `**${formatCurrency(row.amount, getEconomySettings(ctx.db).currencyName)}** • ${row.claim_count}/${row.max_claims} claimed • **${row.status}**\n<#${row.channel_id}> • <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`).join('\n\n')
      : 'No cash drops have been recorded.';
    return interaction.update({ embeds: [makeEmbed(config.EMBED_COLORS.info, 'Recent Economy Cash Drops', description.slice(0, 4000))], components: economyStaffComponents() });
  }
  if (action === 'purchases') {
    const rows = ctx.db.prepare('SELECT * FROM economy_purchase_history ORDER BY created_at DESC LIMIT 15').all();
    const description = rows.length
      ? rows.map((row) => `**${row.item_name}** • ${row.quantity}x • ${formatCurrency(row.total_cost, getEconomySettings(ctx.db).currencyName)}\n<@${row.user_id}> • <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`).join('\n\n')
      : 'No shop purchases have been recorded.';
    return interaction.update({ embeds: [makeEmbed(config.EMBED_COLORS.info, 'Recent Shop Purchases', description.slice(0, 4000))], components: economyStaffComponents() });
  }
  if (action === 'transactions') {
    const rows = getEconomyTransactions(ctx.db, null, 15);
    const description = rows.length
      ? rows.map((row) => {
        let note = '';
        try { note = JSON.parse(row.metadata_json).description || ''; } catch {}
        return `**${row.type.replaceAll('_', ' ')}** • ${formatCurrency(row.amount, getEconomySettings(ctx.db).currencyName)}\n<@${row.user_id}>${note ? ` • ${note}` : ''} • <t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`;
      }).join('\n\n')
      : 'No economy transactions have been recorded.';
    return interaction.update({ embeds: [makeEmbed(config.EMBED_COLORS.info, 'Recent Economy Transactions', description.slice(0, 4000))], components: economyStaffComponents() });
  }
  return interaction.reply({ content: 'Unknown economy management action.', ephemeral: true });
}

async function handleEconomyManagementSelect(interaction, ctx) {
  if (interaction.customId !== 'gv:economy:staff:product-select') return null;
  if (!await ensureManagement(interaction, ctx.db)) return;
  const itemId = interaction.values[0];
  const item = ctx.db.prepare('SELECT * FROM economy_shop_items WHERE id = ? AND deleted = 0').get(itemId);
  if (!item) return interaction.reply({ content: 'That economy product is no longer available.', ephemeral: true });
  const settings = getEconomySettings(ctx.db);
  return interaction.update({
    embeds: [makeEmbed(config.EMBED_COLORS.management, item.name,
      `${item.description || 'No description'}\n\n**Price:** ${formatCurrency(item.price, settings.currencyName)}\n**Stock:** ${item.stock}\n**Category:** ${item.category}\n**Status:** ${item.enabled ? 'Enabled' : 'Disabled'}`)],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gv:economy:staff:product:edit:${item.id}`).setLabel('Edit').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`gv:economy:staff:product:toggle:${item.id}`).setLabel(item.enabled ? 'Disable' : 'Enable').setStyle(item.enabled ? ButtonStyle.Secondary : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`gv:economy:staff:product:remove:${item.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`gv:economy:staff:product:image:${item.id}`).setLabel('Image').setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('gv:economy:staff:products').setLabel('Back to Products').setStyle(ButtonStyle.Secondary)),
    ],
  });
}

async function handleEconomyLeaderboard(interaction, ctx, ranking = 'wealth') {
  const rows = getEconomyLeaderboard(ctx.db, 10, ranking);
  const currency = getEconomySettings(ctx.db).currencyName;
  const labels = { wealth: 'Total', wallet: 'Wallet balance', bank: 'Bank balance', earnings: 'Lifetime earnings' };
  const metric = { wealth: (row) => row.wallet_balance + row.bank_balance, wallet: (row) => row.wallet_balance, bank: (row) => row.bank_balance, earnings: (row) => row.lifetime_earnings }[ranking];
  const description = rows.length
    ? rows.map((row, index) => `${index + 1}. <@${row.user_id}> • ${labels[ranking]} ${formatCurrency(metric(row), currency)}${ranking === 'wealth' ? ` (wallet ${formatCurrency(row.wallet_balance, currency)} • bank ${formatCurrency(row.bank_balance, currency)})` : ''}`).join('\n')
    : 'No economy accounts have been created yet.';
  return interaction.reply({ embeds: [makeEmbed(getEconomySettings(ctx.db).panelColor, `🏆 Economy Leaderboard • ${labels[ranking]}`, description.slice(0, 4000))], ephemeral: true });
}

async function handleEconomyAdmin(interaction, ctx) {
  if (!await ensureManagement(interaction, ctx.db)) return;
  const target = interaction.options.getUser('member', true);
  const amount = interaction.options.getInteger('amount', true);
  const reason = interaction.options.getString('reason', true);
  const result = adjustPlayerBalance(ctx.db, interaction.user.id, target.id, amount, reason);
  return interaction.reply({ content: `Updated <@${target.id}> balance by ${formatCurrency(Math.abs(result.amount), getEconomySettings(ctx.db).currencyName)}. New wallet: ${formatCurrency(result.walletAfter, getEconomySettings(ctx.db).currencyName)}.`, ephemeral: true });
}

async function handleEconomyTransactions(interaction, ctx) {
  const requestedUser = interaction.options.getUser('member');
  let userId = interaction.user.id;
  if (requestedUser && requestedUser.id !== userId) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    userId = requestedUser.id;
  }
  return interaction.reply({ embeds: [economyTransactionsEmbed(ctx.db, userId, requestedUser ? `${requestedUser.username}'s Transactions` : 'Your Transactions')], ephemeral: true });
}

async function handleEconomyCommand(interaction, ctx) {
  if (interaction.commandName !== 'economy') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'access-role') return configureEconomyAccessRole(interaction, ctx);
  if (action === 'wallet') return showWallet(interaction, ctx);
  if (action === 'work') return work(interaction, ctx);
  if (action === 'configure') return configureEconomy(interaction, ctx);
  if (action === 'panel') return publishEconomyPanel(interaction, ctx);
  if (action === 'daily') return handleDailyRewardCommand(interaction, ctx);
  if (action === 'deposit' || action === 'withdraw' || action === 'transfer') return handleBankCommand(interaction, ctx);
  if (action === 'shop' || action === 'inventory' || action === 'history' || action === 'purchase'
    || action.startsWith('item-') || action === 'manage') return handleShopCommand(interaction, ctx);
  if (action === 'leaderboard') return handleEconomyLeaderboard(interaction, ctx, interaction.options.getString?.('ranking') ?? 'wealth');
  if (action === 'transactions') return handleEconomyTransactions(interaction, ctx);
  if (action === 'admin') return handleEconomyAdmin(interaction, ctx);
  if (action === 'blackjack') return startBlackjackInteraction(interaction, ctx, interaction.options.getInteger('bet', true));
  if (action === 'coinflip' || action === 'roulette') {
    return startQuickGame(interaction, ctx, action, interaction.options.getInteger('bet', true), interaction.options.getString('choice', true));
  }
  if (action === 'chicken') return startChickenInteraction(interaction, ctx, interaction.options.getInteger('bet', true));
  return interaction.reply({ content: 'That economy command is not available yet.', ephemeral: true });
}

async function handleEconomyModal(interaction, ctx) {
  if (interaction.customId === 'gv:economy:modal:staff-drop') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const settings = getEconomySettings(ctx.db);
    if (!validId(settings.cashDropChannelId)) {
      return interaction.reply({ content: 'Configure the cash drop channel with `/economy configure drop-channel:<channel>` first.', ephemeral: true });
    }
    const amount = Number(interaction.fields.getTextInputValue('amount').trim());
    const maxClaims = Number(interaction.fields.getTextInputValue('claims').trim());
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000_000
      || !Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 100) {
      return interaction.reply({ content: 'Amount must be 1–1,000,000,000 and claimants must be 1–100.', ephemeral: true });
    }
    const drop = createManualEconomyCashDrop(ctx.db, {
      channelId: settings.cashDropChannelId,
      amount,
      maxClaims,
      lifetimeMinutes: settings.cashDropLifetimeMinutes,
      actorId: interaction.user.id,
    });
    const posted = await postPendingCashDrop(interaction.client, ctx.db, drop, new Date());
    return interaction.reply({
      content: posted.posted
        ? `Manual cash drop posted in <#${drop.channel_id}> for ${formatCurrency(amount, settings.currencyName)} per player (${maxClaims} claimants).`
        : `Manual cash drop saved as pending. It will be retried by the scheduled worker; check the channel and bot permissions.`,
      ephemeral: true,
    });
  }
  const imageModal = interaction.customId.match(/^gv:economy:modal:staff-product-image:([a-f0-9-]{36})$/);
  if (imageModal) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const imageUrl = interaction.fields.getTextInputValue('image').trim();
    try {
      const result = editShopItem(ctx.db, imageModal[1], { imageUrl: imageUrl || null }, interaction.user.id);
      return interaction.reply({ content: result.updated ? `Image ${imageUrl ? 'saved' : 'removed'} for **${result.item.name}**.` : 'That product no longer exists.', ephemeral: true });
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
  }
  if (interaction.customId === 'gv:economy:modal:staff-delivery-settings') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const current = getEconomySettings(ctx.db);
    const fields = [
      ['game-max-bet', 'ECONOMY_GAME_MAX_BET', 'maximumBet', current.maximumBet],
      ['delivery-min', 'ECONOMY_DELIVERY_MIN_REWARD', 'deliveryMinimumReward', current.deliveryMinimumReward],
      ['delivery-max', 'ECONOMY_DELIVERY_MAX_REWARD', 'deliveryMaximumReward', current.deliveryMaximumReward],
      ['delivery-cooldown', 'ECONOMY_DELIVERY_COOLDOWN_MINUTES', 'deliveryCooldownMinutes', current.deliveryCooldownMinutes],
    ];
    const next = { ...current };
    const changes = [];
    for (const [field, key, setting, fallback] of fields) {
      const raw = String(interaction.fields.getTextInputValue(field) ?? '').trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) return interaction.reply({ content: `${field} must be a whole number.`, ephemeral: true });
      next[setting] = value;
      if (value !== fallback) changes.push([key, value]);
    }
    const invalid = validateDeliverySettings(next);
    if (invalid) return interaction.reply({ content: invalid, ephemeral: true });
    if (!Number.isSafeInteger(next.maximumBet) || next.maximumBet < 1 || next.maximumBet > 1_000_000_000) {
      return interaction.reply({ content: 'Maximum game wager must be from 1 to 1,000,000,000.', ephemeral: true });
    }
    if (!changes.length) return interaction.reply({ content: 'No game settings were changed.', ephemeral: true });
    ctx.db.transaction(() => {
      for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
      recordEconomyAudit(ctx.db, { actorId: interaction.user.id, action: 'delivery_settings_updated', newValue: JSON.stringify(Object.fromEntries(changes)) });
    })();
    return interaction.reply({ content: 'Game wager and Delivery Rush settings were saved.', ephemeral: true });
  }
  if (interaction.customId === 'gv:economy:modal:staff-work-rewards') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const current = getEconomySettings(ctx.db);
    const values = [
      ['work-min', 'ECONOMY_WORK_MIN_REWARD', current.minimumReward],
      ['work-max', 'ECONOMY_WORK_MAX_REWARD', current.maximumReward],
      ['daily-amount', 'ECONOMY_DAILY_REWARD_AMOUNT', current.dailyReward],
      ['daily-cooldown', 'ECONOMY_DAILY_REWARD_COOLDOWN_HOURS', current.dailyRewardCooldownHours],
    ];
    const changes = [];
    const next = { minimumReward: current.minimumReward, maximumReward: current.maximumReward, cooldownMinutes: current.cooldownMinutes, dailyReward: current.dailyReward, dailyRewardCooldownHours: current.dailyRewardCooldownHours };
    for (const [field, key, fallback] of values) {
      const raw = interaction.fields.getTextInputValue(field).trim();
      if (!raw) continue;
      const value = Number(raw);
      if (!Number.isSafeInteger(value)) return interaction.reply({ content: `${field} must be a whole number.`, ephemeral: true });
      changes.push([key, value]);
      if (field === 'work-min') next.minimumReward = value;
      if (field === 'work-max') next.maximumReward = value;
      if (field === 'daily-amount') next.dailyReward = value;
      if (field === 'daily-cooldown') next.dailyRewardCooldownHours = value;
      if (fallback === value) changes.pop();
    }
    const workError = validateWorkSettings(next);
    if (workError) return interaction.reply({ content: workError, ephemeral: true });
    if (!Number.isSafeInteger(next.dailyReward) || next.dailyReward < 1 || next.dailyReward > 1_000_000_000
      || !Number.isSafeInteger(next.dailyRewardCooldownHours) || next.dailyRewardCooldownHours < 1 || next.dailyRewardCooldownHours > 168) {
      return interaction.reply({ content: 'Daily reward amount must be 1–1,000,000,000 and cooldown must be 1–168 hours.', ephemeral: true });
    }
    if (!changes.length) return interaction.reply({ content: 'No reward settings were changed.', ephemeral: true });
    ctx.db.transaction(() => {
      for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
      recordEconomyAudit(ctx.db, { actorId: interaction.user.id, action: 'rewards_updated', newValue: JSON.stringify(Object.fromEntries(changes)) });
    })();
    return interaction.reply({ content: 'Work and daily reward settings were saved.', ephemeral: true });
  }
  const productModal = interaction.customId.match(/^gv:economy:modal:staff-product:(add|edit)(?::([a-f0-9-]{36}))?$/);
  if (productModal) {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const name = interaction.fields.getTextInputValue('name').trim();
    const price = Number(interaction.fields.getTextInputValue('price').trim());
    const stock = Number(interaction.fields.getTextInputValue('stock').trim());
    const description = interaction.fields.getTextInputValue('description').trim();
    const category = interaction.fields.getTextInputValue('category').trim() || 'General';
    if (!name || !Number.isSafeInteger(price) || price < 1 || price > 1_000_000_000
      || !Number.isSafeInteger(stock) || stock < 0 || stock > 1_000_000) {
      return interaction.reply({ content: 'Provide a product name, price from 1 to 1,000,000,000, and stock from 0 to 1,000,000.', ephemeral: true });
    }
    if (productModal[1] === 'add') {
      const itemId = createShopItem(ctx.db, { name, price, stock, description, category }, interaction.user.id);
      return interaction.reply({ content: `Created **${name}** (\`${itemId}\`).`, ephemeral: true });
    }
    const result = editShopItem(ctx.db, productModal[2], { name, price, stock, description, category }, interaction.user.id);
    return interaction.reply({ content: result.updated ? `Updated **${name}**.` : 'That product no longer exists.', ephemeral: true });
  }
  if (interaction.customId === 'gv:economy:modal:staff-settings') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const settings = getEconomySettings(ctx.db);
    const fields = {
      'drop-amount': ['ECONOMY_CASH_DROP_AMOUNT', settings.cashDropAmount, 1, 1_000_000_000],
      'drop-interval': ['ECONOMY_CASH_DROP_INTERVAL_MINUTES', settings.cashDropIntervalMinutes, 1, 1440],
      'drop-claims': ['ECONOMY_CASH_DROP_MAX_CLAIMS', settings.cashDropMaxClaims, 1, 100],
    };
    const changes = [];
    for (const [field, [key, , minimum, maximum]] of Object.entries(fields)) {
      const value = interaction.fields.getTextInputValue(field).trim();
      if (!value) continue;
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        return interaction.reply({ content: `${field} must be a whole number between ${minimum} and ${maximum}.`, ephemeral: true });
      }
      changes.push([key, number]);
    }
    for (const [field, key] of [['panel-color', 'ECONOMY_PANEL_COLOR'], ['shop-color', 'ECONOMY_SHOP_COLOR']]) {
      const value = interaction.fields.getTextInputValue(field).trim();
      if (!value) continue;
      if (!/^#?[0-9a-f]{6}$/i.test(value)) return interaction.reply({ content: 'Colors must be six-digit HEX values such as #1F7AE0.', ephemeral: true });
      changes.push([key, Number.parseInt(value.replace(/^#/, ''), 16)]);
    }
    if (!changes.length) return interaction.reply({ content: 'No economy settings were changed.', ephemeral: true });
    ctx.db.transaction(() => {
      for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
      recordEconomyAudit(ctx.db, { actorId: interaction.user.id, action: 'settings_updated', reason: 'Economy management panel settings', newValue: JSON.stringify(Object.fromEntries(changes)) });
    })();
    return interaction.reply({ content: 'Economy drop and HEX color settings were saved.', ephemeral: true });
  }
  if (interaction.customId === 'gv:economy:modal:staff-balance') {
    if (!await ensureManagement(interaction, ctx.db)) return;
    const userId = interaction.fields.getTextInputValue('user-id').trim();
    const amount = Number(interaction.fields.getTextInputValue('amount').trim());
    const reason = interaction.fields.getTextInputValue('reason').trim();
    if (!validId(userId) || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > 1_000_000_000 || !reason) {
      return interaction.reply({ content: 'Provide a valid Discord user ID, nonzero signed whole amount (up to 1,000,000,000), and audit reason.', ephemeral: true });
    }
    try {
      const result = adjustPlayerBalance(ctx.db, interaction.user.id, userId, amount, reason);
      return interaction.reply({ content: `Adjusted <@${userId}> by ${formatCurrency(Math.abs(amount), getEconomySettings(ctx.db).currencyName)}. New wallet: ${formatCurrency(result.walletAfter, getEconomySettings(ctx.db).currencyName)}.`, ephemeral: true });
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
  }
  const gameMatch = interaction.customId.match(/^gv:economy:modal:game:(blackjack|coinflip|roulette|chicken)$/);
  if (gameMatch) {
    const bet = Number(interaction.fields.getTextInputValue('bet'));
    const maximumBet = getEconomySettings(ctx.db).maximumBet;
    if (!Number.isSafeInteger(bet) || bet < 1 || bet > maximumBet) {
      return interaction.reply({ content: `Enter a whole-number wager from 1 to ${maximumBet.toLocaleString('en-US')}.`, ephemeral: true });
    }
    if (gameMatch[1] === 'blackjack') return startBlackjackInteraction(interaction, ctx, bet);
    if (gameMatch[1] === 'chicken') return startChickenInteraction(interaction, ctx, bet);
    const choice = interaction.fields.getTextInputValue('choice').trim().toLowerCase();
    return startQuickGame(interaction, ctx, gameMatch[1], bet, choice);
  }
  const match = interaction.customId.match(/^gv:economy:modal:bank:(deposit|withdraw)$/);
  if (!match) return null;
  const amount = Number(interaction.fields.getTextInputValue('amount'));
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return interaction.reply({ content: 'Enter a positive whole-number amount.', ephemeral: true });
  }
  try {
    const result = match[1] === 'deposit'
      ? depositToBank(ctx.db, interaction.user.id, amount)
      : withdrawFromBank(ctx.db, interaction.user.id, amount);
    const currency = getEconomySettings(ctx.db).currencyName;
    return interaction.reply({ content: `${match[1] === 'deposit' ? 'Deposited' : 'Withdrew'} ${formatCurrency(amount, currency)}. Wallet: ${formatCurrency(result.walletAfter, currency)} • Bank: ${formatCurrency(result.bankAfter, currency)}.`, ephemeral: true });
  } catch (error) {
    return interaction.reply({ content: error.message, ephemeral: true });
  }
}

async function handleEconomyButton(interaction, ctx) {
  const managementResult = await handleEconomyManagementButton(interaction, ctx);
  if (managementResult) return managementResult;
  const gameAction = await handleGameButton(interaction, ctx);
  if (gameAction) return gameAction;
  if (interaction.customId === 'gv:economy:wallet') return showWallet(interaction, ctx);
  if (interaction.customId === 'gv:economy:work') return work(interaction, ctx);
  if (interaction.customId === 'gv:economy:bank') return showBankPanel(interaction, ctx);
  if (interaction.customId === 'gv:economy:bank:deposit' || interaction.customId === 'gv:economy:bank:withdraw') {
    const action = interaction.customId.endsWith('deposit') ? 'deposit' : 'withdraw';
    return interaction.showModal(amountModal(`gv:economy:modal:bank:${action}`, `Bank ${action}`));
  }
  if (interaction.customId === 'gv:economy:shop') return interaction.reply(shopPagePayload(ctx.db));
  if (interaction.customId === 'gv:economy:leaderboard') return handleEconomyLeaderboard(interaction, ctx);
  if (interaction.customId === 'gv:economy:daily') return handleDailyRewardCommand(interaction, ctx);
  if (interaction.customId === 'gv:economy:inventory') {
    const inventory = getPlayerInventory(ctx.db, interaction.user.id);
    const description = inventory.length
      ? inventory.map((entry) => `**${entry.item_name}** • Qty: ${entry.quantity}\n${entry.description || 'No description'}`).join('\n\n')
      : 'You do not own any shop items yet.';
    return interaction.reply({ embeds: [makeEmbed(getEconomySettings(ctx.db).panelColor, '🎒 Inventory', description.slice(0, 4000))], ephemeral: true });
  }
  if (interaction.customId === 'gv:economy:transactions') {
    return interaction.reply({ embeds: [economyTransactionsEmbed(ctx.db, interaction.user.id)], ephemeral: true });
  }
  if (['blackjack', 'coinflip', 'roulette', 'chicken'].some((game) => interaction.customId === `gv:economy:${game}`)) {
    const game = interaction.customId.split(':').at(-1);
    return interaction.showModal(gameBetModal(game));
  }
  const shopPage = interaction.customId.match(/^gv:economy:shop:page:(\d+)$/);
  if (shopPage) {
    const payload = shopPagePayload(ctx.db, Number(shopPage[1]));
    delete payload.ephemeral;
    return interaction.update(payload);
  }
  const purchaseConfirmation = interaction.customId.match(/^gv:economy:shop:(confirm|cancel):([a-f0-9]{32})$/);
  if (purchaseConfirmation) {
    const [, action, confirmationId] = purchaseConfirmation;
    if (action === 'cancel') {
      const cancelled = cancelShopPurchase(ctx.db, confirmationId, interaction.user.id);
      return interaction.update({ content: cancelled ? 'Purchase cancelled. No money was charged.' : 'This purchase confirmation is no longer available.', embeds: [], components: [] });
    }
    let result;
    try {
      result = completeShopPurchase(ctx.db, confirmationId, interaction.user.id, interaction.id);
    } catch (error) {
      return interaction.update({ content: `Purchase could not be completed: ${error.message}`, embeds: [], components: [] });
    }
    if (!result.purchased) {
      const reasons = {
        owner: 'This purchase confirmation belongs to another player.',
        duplicate: 'This purchase confirmation was already used.',
        expired: 'This purchase confirmation expired. Start a new purchase from the shop.',
        stock: 'There is not enough stock available to complete this purchase.',
        'price-changed': 'The item price changed. Review the current price and confirm a new purchase.',
        funds: 'You do not have enough money to complete this purchase.',
        limit: 'You have reached the purchase limit for this item.',
        missing: 'That item is no longer available.',
        disabled: 'That item is disabled.',
      };
      return interaction.update({ content: reasons[result.reason] ?? 'Purchase could not be completed.', embeds: [], components: [] });
    }
    return interaction.update({
      content: `Purchase complete. **${formatCurrency(result.totalCost)}** was charged.`,
      embeds: [],
      components: [],
    });
  }
  const shopBuy = interaction.customId.match(/^gv:economy:shop:buy:([a-f0-9-]{36})$/);
  if (shopBuy) {
    let prepared;
    try {
      prepared = prepareShopPurchase(ctx.db, interaction.user.id, shopBuy[1]);
    } catch (error) {
      return interaction.reply({ content: error.message, ephemeral: true });
    }
    if (!prepared.prepared) {
      const reasons = { missing: 'That item is no longer available.', disabled: 'That item is disabled.', stock: 'There is not enough stock available.', funds: 'You do not have enough money to purchase this item.', limit: 'You have reached the purchase limit for this item.', pending: 'You already have a pending confirmation for this item. Finish or cancel it first.' };
      return interaction.reply({ content: reasons[prepared.reason] ?? 'Purchase could not be started.', ephemeral: true });
    }
    return interaction.reply(shopPurchaseConfirmationPayload(prepared));
  }
  if (interaction.customId === 'gv:economy:delivery:start') return startDeliveryRush(interaction, ctx);
  const cashDropMatch = interaction.customId.match(/^gv:economy:drop:claim:([a-f0-9-]{36})$/);
  if (cashDropMatch) {
    const result = claimEconomyCashDrop(ctx.db, cashDropMatch[1], interaction.user.id);
    const messages = {
      missing: 'That cash drop could not be found.',
      closed: 'That cash drop has already been fully claimed.',
      expired: 'That cash drop has expired.',
      duplicate: 'You have already claimed this cash drop.',
    };
    if (!result.claimed) return interaction.reply({ content: messages[result.reason] ?? 'That cash drop is unavailable.', ephemeral: true });
    const drop = ctx.db.prepare('SELECT * FROM economy_cash_drops WHERE drop_id = ?').get(result.dropId);
    await updateClaimedCashDropMessage(interaction.client, ctx.db, drop);
    return interaction.reply({ content: `Cash drop claimed: **${formatCurrency(result.amount)}** added to your wallet.`, ephemeral: true });
  }
  const match = interaction.customId.match(/^gv:economy:delivery:choose:([a-f0-9-]{36}):(fast|safe|shortcut)$/);
  if (match) return chooseDeliveryRoute(interaction, ctx, match[1], match[2]);
  return interaction.reply({ content: 'This Economy Panel action is not available yet.', ephemeral: true });
}

module.exports = {
  adjustPlayerBalance,
  claimDailyReward,
  claimEconomyCashDrop,
  claimWorkReward,
  createShopItem,
  depositToBank,
  deliveryRoutes,
  editShopItem,
  economyPanelComponents,
  economyPanelEmbed,
  ensureEconomyAccount,
  getEconomyLeaderboard,
  getEconomySettings,
  ensureEconomyManagement: ensureManagement,
  getEconomyTransactions,
  getPlayerInventory,
  getPlayerPurchaseHistory,
  getWallet,
  handleEconomyButton,
  handleEconomyCommand,
  handleEconomyModal,
  handleEconomyManagementButton,
  handleEconomyManagementSelect,
  listShopItems,
  makeDeliveryGameComponents,
  processEconomyCashDrops,
  prepareShopPurchase,
  completeShopPurchase,
  cancelShopPurchase,
  reconcileClaimedCashDropMessages,
  createManualEconomyCashDrop,
  recordEconomyAudit,
  purchaseShopItem,
  removeShopItem,
  resolveDeliveryGame,
  resolveDeliveryOutcome,
  rewardForDeliveryOutcome,
  startDeliveryGame,
  transferToPlayer,
  validateDeliverySettings,
  validateWorkSettings,
  walletEmbed,
  withdrawFromBank,
};