const { randomInt, randomUUID } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../../config');
const { ensureManagement } = require('./staff');
const {
  getConfigValue,
  makeEmbed,
  setConfigValue,
  validId,
} = require('../utils/discord');

function getEconomySettings(db) {
  return {
    channelId: getConfigValue(db, 'ECONOMY_PANEL_CHANNEL_ID'),
    messageChannelId: getConfigValue(db, 'ECONOMY_PANEL_MESSAGE_CHANNEL_ID'),
    messageId: getConfigValue(db, 'ECONOMY_PANEL_MESSAGE_ID'),
    minimumReward: Number(getConfigValue(db, 'ECONOMY_WORK_MIN_REWARD') ?? config.ECONOMY_WORK_MIN_REWARD),
    maximumReward: Number(getConfigValue(db, 'ECONOMY_WORK_MAX_REWARD') ?? config.ECONOMY_WORK_MAX_REWARD),
    cooldownMinutes: Number(getConfigValue(db, 'ECONOMY_WORK_COOLDOWN_MINUTES') ?? config.ECONOMY_WORK_COOLDOWN_MINUTES),
    deliveryMinimumReward: Number(getConfigValue(db, 'ECONOMY_DELIVERY_MIN_REWARD') ?? config.ECONOMY_DELIVERY_MIN_REWARD),
    deliveryMaximumReward: Number(getConfigValue(db, 'ECONOMY_DELIVERY_MAX_REWARD') ?? config.ECONOMY_DELIVERY_MAX_REWARD),
    deliveryCooldownMinutes: Number(getConfigValue(db, 'ECONOMY_DELIVERY_COOLDOWN_MINUTES') ?? config.ECONOMY_DELIVERY_COOLDOWN_MINUTES),
    currencyName: getConfigValue(db, 'ECONOMY_CURRENCY_NAME') ?? config.ECONOMY_CURRENCY_NAME,
  };
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

function formatCurrency(amount, currencyName) {
  return `${new Intl.NumberFormat('en-US').format(amount)} ${currencyName}`;
}

function ensureEconomyAccount(db, userId, now = new Date().toISOString()) {
  db.prepare('INSERT INTO economy_accounts (user_id, created_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING')
    .run(userId, now);
  return db.prepare('SELECT * FROM economy_accounts WHERE user_id = ?').get(userId);
}

function getWallet(db, userId, now = new Date().toISOString()) {
  return ensureEconomyAccount(db, userId, now);
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
  const embed = makeEmbed(config.EMBED_COLORS.info, `💳 ${username}'s GV GR Wallet`,
    `**Wallet:** ${formatCurrency(account.wallet_balance, settings.currencyName)}\n**Bank:** ${formatCurrency(account.bank_balance, settings.currencyName)}\n**Lifetime earnings:** ${formatCurrency(account.lifetime_earnings, settings.currencyName)}\n**Total spent:** ${formatCurrency(account.total_spent, settings.currencyName)}\n**Total transferred:** ${formatCurrency(account.total_transferred, settings.currencyName)}\n**Account created:** <t:${Math.floor(new Date(account.created_at).getTime() / 1000)}:D>`)
    .setFooter({ text: `Account ID • ${account.user_id}` });
  return embed;
}

function economyPanelEmbed(settings) {
  return makeEmbed(config.EMBED_COLORS.management, '💰 GV GR | ECONOMY',
    'Manage your virtual roleplay money from one place. Your wallet and account history are private to you.\n\n'
    + `**Work:** Earn ${formatCurrency(settings.minimumReward, settings.currencyName)}–${formatCurrency(settings.maximumReward, settings.currencyName)} every ${settings.cooldownMinutes} minutes.\n`
    + `**Delivery Rush:** Deliver for ${formatCurrency(settings.deliveryMinimumReward, settings.currencyName)}–${formatCurrency(settings.deliveryMaximumReward * 2, settings.currencyName)} every ${settings.deliveryCooldownMinutes} minutes.\n`
    + '**My Wallet:** View your private wallet, bank balance, and account totals.\n\n'
    + 'Bank, Shop, Leaderboard, Blackjack, Transactions, and Daily Rewards will unlock in upcoming economy stages.')
    .setFooter({ text: 'GV GR • Virtual currency only' });
}

function economyPanelComponents() {
  return [
    new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gv:economy:wallet').setLabel('My Wallet').setEmoji('💳').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gv:economy:work').setLabel('Work').setEmoji('🧰').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('gv:economy:bank').setLabel('Bank').setEmoji('🏦').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('gv:economy:shop').setLabel('Shop').setEmoji('🛍️').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('gv:economy:leaderboard').setLabel('Leaderboard').setEmoji('🏆').setStyle(ButtonStyle.Secondary).setDisabled(true),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('gv:economy:blackjack').setLabel('Blackjack').setEmoji('🃏').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('gv:economy:transactions').setLabel('Transactions').setEmoji('📜').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('gv:economy:daily').setLabel('Daily Rewards').setEmoji('🎁').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('gv:economy:delivery:start').setLabel('Delivery Rush').setEmoji('🚗').setStyle(ButtonStyle.Success),
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
  const settingsError = validateWorkSettings({ minimumReward, maximumReward, cooldownMinutes });
  if (settingsError) return interaction.reply({ content: settingsError, ephemeral: true });
  const deliveryError = validateDeliverySettings({ deliveryMinimumReward, deliveryMaximumReward, deliveryCooldownMinutes });
  if (deliveryError) return interaction.reply({ content: deliveryError, ephemeral: true });
  const changes = [];
  if (channel) changes.push(['ECONOMY_PANEL_CHANNEL_ID', channel.id]);
  if (options.getInteger('minimum-reward') !== null) changes.push(['ECONOMY_WORK_MIN_REWARD', minimumReward]);
  if (options.getInteger('maximum-reward') !== null) changes.push(['ECONOMY_WORK_MAX_REWARD', maximumReward]);
  if (options.getInteger('cooldown-minutes') !== null) changes.push(['ECONOMY_WORK_COOLDOWN_MINUTES', cooldownMinutes]);
  if (options.getInteger('delivery-minimum') !== null) changes.push(['ECONOMY_DELIVERY_MIN_REWARD', deliveryMinimumReward]);
  if (options.getInteger('delivery-maximum') !== null) changes.push(['ECONOMY_DELIVERY_MAX_REWARD', deliveryMaximumReward]);
  if (options.getInteger('delivery-cooldown-minutes') !== null) changes.push(['ECONOMY_DELIVERY_COOLDOWN_MINUTES', deliveryCooldownMinutes]);
  if (!changes.length) return interaction.reply({ content: 'Provide a panel channel or at least one Work setting to configure.', ephemeral: true });
  ctx.db.transaction(() => {
    for (const [key, value] of changes) setConfigValue(ctx.db, key, value);
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
  const payload = { embeds: [economyPanelEmbed(settings)], components: economyPanelComponents() };
  let message;
  const savedMessageId = settings.messageId;
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

async function handleEconomyCommand(interaction, ctx) {
  if (interaction.commandName !== 'economy') return null;
  const action = interaction.options.getSubcommand();
  if (action === 'wallet') return showWallet(interaction, ctx);
  if (action === 'work') return work(interaction, ctx);
  if (action === 'configure') return configureEconomy(interaction, ctx);
  if (action === 'panel') return publishEconomyPanel(interaction, ctx);
  return interaction.reply({ content: 'That economy command is not available yet.', ephemeral: true });
}

async function handleEconomyButton(interaction, ctx) {
  if (interaction.customId === 'gv:economy:wallet') return showWallet(interaction, ctx);
  if (interaction.customId === 'gv:economy:work') return work(interaction, ctx);
  if (interaction.customId === 'gv:economy:delivery:start') return startDeliveryRush(interaction, ctx);
  const match = interaction.customId.match(/^gv:economy:delivery:choose:([a-f0-9-]{36}):(fast|safe|shortcut)$/);
  if (match) return chooseDeliveryRoute(interaction, ctx, match[1], match[2]);
  return interaction.reply({ content: 'This Economy Panel action is not available yet.', ephemeral: true });
}

module.exports = {
  claimWorkReward,
  deliveryRoutes,
  economyPanelComponents,
  economyPanelEmbed,
  ensureEconomyAccount,
  getEconomySettings,
  getWallet,
  handleEconomyButton,
  handleEconomyCommand,
  makeDeliveryGameComponents,
  resolveDeliveryGame,
  resolveDeliveryOutcome,
  rewardForDeliveryOutcome,
  startDeliveryGame,
  validateDeliverySettings,
  validateWorkSettings,
  walletEmbed,
};