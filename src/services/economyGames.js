const { randomInt, randomUUID } = require('node:crypto');
const config = require('../../config');
const { getConfigValue } = require('../utils/discord');

const gameExpiryMs = 5 * 60_000;

function ensureAccount(db, userId, now) {
  db.prepare('INSERT INTO economy_accounts (user_id, wallet_balance, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING')
    .run(userId, Number(getConfigValue(db, 'ECONOMY_STARTING_BALANCE') ?? config.ECONOMY_STARTING_BALANCE ?? 0), now);
  return db.prepare('SELECT * FROM economy_accounts WHERE user_id = ?').get(userId);
}

function recordTransaction(db, userId, type, amount, account, description, now) {
  db.prepare(`
    INSERT INTO economy_transactions (id, user_id, type, amount, wallet_after, bank_after, created_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), userId, type, amount, account.wallet_balance, account.bank_balance, now, JSON.stringify({ description }));
}

function validBet(db, bet) {
  const maximumBet = Number(getConfigValue(db, 'ECONOMY_GAME_MAX_BET') ?? config.ECONOMY_GAME_MAX_BET ?? 1_000_000_000);
  if (!Number.isSafeInteger(maximumBet) || maximumBet < 1 || maximumBet > 1_000_000_000) {
    throw new Error('Economy game wager settings are invalid. Contact management.');
  }
  if (!Number.isSafeInteger(bet) || bet < 1 || bet > maximumBet) {
    throw new Error(`Your bet must be a whole number from 1 to ${maximumBet.toLocaleString('en-US')}.`);
  }
}

function beginGame(db, userId, gameType, bet, state, nowDate) {
  validBet(db, bet);
  const now = nowDate.toISOString();
  return db.transaction(() => {
    db.prepare("UPDATE economy_games SET status = 'expired', resolved_at = ? WHERE user_id = ? AND status = 'active' AND expires_at <= ?")
      .run(now, userId, now);
    const account = ensureAccount(db, userId, now);
    if (account.wallet_balance < bet) return { started: false, reason: 'funds' };
    const walletAfter = account.wallet_balance - bet;
    db.prepare('UPDATE economy_accounts SET wallet_balance = ? WHERE user_id = ?').run(walletAfter, userId);
    recordTransaction(db, userId, `${gameType}_bet`, bet, { ...account, wallet_balance: walletAfter }, `Bet for ${gameType}`, now);
    const gameId = randomUUID();
    db.prepare(`
      INSERT INTO economy_games (game_id, user_id, game_type, bet, status, state_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(gameId, userId, gameType, bet, JSON.stringify(state), now, new Date(nowDate.getTime() + gameExpiryMs).toISOString());
    return { started: true, gameId, gameType, bet, state };
  })();
}

function settleGame(db, game, status, payout, state, now) {
  const resolved = db.prepare(`
    UPDATE economy_games SET status = ?, payout = ?, state_json = ?, resolved_at = ?
    WHERE game_id = ? AND user_id = ? AND status = 'active'
  `).run(status, payout, JSON.stringify(state), now, game.game_id, game.user_id);
  if (!resolved.changes) return { completed: false, reason: 'resolved' };
  let walletAfter = null;
  if (payout > 0) {
    const account = ensureAccount(db, game.user_id, now);
    walletAfter = account.wallet_balance + payout;
    const lifetime = account.lifetime_earnings + payout;
    if (!Number.isSafeInteger(walletAfter) || !Number.isSafeInteger(lifetime)) throw new Error('Game payout would exceed the safe account balance limit.');
    db.prepare('UPDATE economy_accounts SET wallet_balance = ?, lifetime_earnings = ? WHERE user_id = ?').run(walletAfter, lifetime, game.user_id);
    recordTransaction(db, game.user_id, `${game.game_type}_payout`, payout, { ...account, wallet_balance: walletAfter }, `${game.game_type} payout`, now);
  }
  return { completed: true, status, payout, walletAfter, bet: game.bet, state };
}

function drawCard(cardPicker = () => randomInt(1, 14)) {
  const value = cardPicker();
  if (!Number.isInteger(value) || value < 1 || value > 13) throw new Error('Card generator returned an invalid card.');
  return value;
}

function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    total += card === 1 ? 11 : Math.min(card, 10);
    if (card === 1) aces += 1;
  }
  while (total > 21 && aces) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

function cardLabel(card) {
  return ({ 1: 'A', 11: 'J', 12: 'Q', 13: 'K' })[card] ?? String(card);
}

function beginBlackjack(db, userId, bet, now = new Date(), cardPicker = drawCard) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Game start time is invalid.');
  const state = { playerCards: [drawCard(cardPicker), drawCard(cardPicker)], dealerCards: [drawCard(cardPicker), drawCard(cardPicker)] };
  try {
    const result = beginGame(db, userId, 'blackjack', bet, state, nowDate);
    if (!result.started) return result;
    const playerNatural = handValue(state.playerCards) === 21;
    const dealerNatural = handValue(state.dealerCards) === 21;
    if (playerNatural || dealerNatural) {
      return db.transaction(() => {
        const game = db.prepare('SELECT * FROM economy_games WHERE game_id = ?').get(result.gameId);
        const status = playerNatural && dealerNatural ? 'push' : playerNatural ? 'won' : 'lost';
        const payout = status === 'push' ? bet : status === 'won' ? Math.floor(bet * 2.5) : 0;
        return { ...result, ...settleGame(db, game, status, payout, state, nowDate.toISOString()), blackjack: playerNatural };
      })();
    }
    return result;
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { started: false, reason: 'active' };
    throw error;
  }
}

function resolveBlackjackAction(db, userId, gameId, action, now = new Date(), cardPicker = drawCard) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Game action time is invalid.');
  const nowIso = nowDate.toISOString();
  return db.transaction(() => {
    const game = db.prepare('SELECT * FROM economy_games WHERE game_id = ?').get(gameId);
    if (!game) return { completed: false, reason: 'missing' };
    if (game.user_id !== userId) return { completed: false, reason: 'owner' };
    if (game.game_type !== 'blackjack') return { completed: false, reason: 'type' };
    if (game.status !== 'active') return { completed: false, reason: 'resolved' };
    if (game.expires_at <= nowIso) {
      db.prepare("UPDATE economy_games SET status = 'expired', resolved_at = ? WHERE game_id = ? AND status = 'active'").run(nowIso, gameId);
      return { completed: false, reason: 'expired' };
    }
    const state = JSON.parse(game.state_json);
    if (action === 'hit') {
      state.playerCards.push(drawCard(cardPicker));
      if (handValue(state.playerCards) > 21) return settleGame(db, game, 'lost', 0, state, nowIso);
      db.prepare("UPDATE economy_games SET state_json = ? WHERE game_id = ? AND status = 'active'").run(JSON.stringify(state), gameId);
      return { completed: false, active: true, state, bet: game.bet };
    }
    if (action !== 'stand') return { completed: false, reason: 'action' };
    while (handValue(state.dealerCards) < 17) state.dealerCards.push(drawCard(cardPicker));
    const playerScore = handValue(state.playerCards);
    const dealerScore = handValue(state.dealerCards);
    const status = dealerScore > 21 || playerScore > dealerScore ? 'won' : playerScore === dealerScore ? 'push' : 'lost';
    const payout = status === 'won' ? game.bet * 2 : status === 'push' ? game.bet : 0;
    return settleGame(db, game, status, payout, state, nowIso);
  })();
}

function playCoinFlip(db, userId, bet, choice, now = new Date(), roll = () => randomInt(2)) {
  if (!['heads', 'tails'].includes(choice)) throw new Error('Choose heads or tails.');
  const nowDate = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(nowDate.getTime())) throw new Error('Cash drop claim time is invalid.');
  const result = roll() === 0 ? 'heads' : 'tails';
  try {
    const game = beginGame(db, userId, 'coinflip', bet, { choice, result }, nowDate);
    if (!game.started) return game;
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM economy_games WHERE game_id = ?').get(game.gameId);
      return { ...game, ...settleGame(db, row, result === choice ? 'won' : 'lost', result === choice ? bet * 2 : 0, { choice, result }, nowDate.toISOString()) };
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { started: false, reason: 'active' };
    throw error;
  }
}

function playRoulette(db, userId, bet, choice, now = new Date(), roll = () => randomInt(37)) {
  if (!['red', 'black', 'green'].includes(choice)) throw new Error('Choose red, black, or green.');
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Game time is invalid.');
  const pocket = roll();
  if (!Number.isInteger(pocket) || pocket < 0 || pocket > 36) throw new Error('Roulette result is invalid.');
  const redPockets = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  const result = pocket === 0 ? 'green' : redPockets.has(pocket) ? 'red' : 'black';
  try {
    const state = { choice, pocket, result };
    const game = beginGame(db, userId, 'roulette', bet, state, nowDate);
    if (!game.started) return game;
    const multiplier = choice === 'green' ? 36 : 2;
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM economy_games WHERE game_id = ?').get(game.gameId);
      return { ...game, ...settleGame(db, row, result === choice ? 'won' : 'lost', result === choice ? bet * multiplier : 0, state, nowDate.toISOString()) };
    })();
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { started: false, reason: 'active' };
    throw error;
  }
}

function startChickenRoad(db, userId, bet, now = new Date()) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Game start time is invalid.');
  try {
    return beginGame(db, userId, 'chicken', bet, { steps: 0, multiplier: 1 }, nowDate);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return { started: false, reason: 'active' };
    throw error;
  }
}

function resolveChickenAction(db, userId, gameId, action, now = new Date(), roll = () => randomInt(100)) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(nowDate.getTime())) throw new Error('Game action time is invalid.');
  const nowIso = nowDate.toISOString();
  return db.transaction(() => {
    const game = db.prepare('SELECT * FROM economy_games WHERE game_id = ?').get(gameId);
    if (!game) return { completed: false, reason: 'missing' };
    if (game.user_id !== userId) return { completed: false, reason: 'owner' };
    if (game.game_type !== 'chicken') return { completed: false, reason: 'type' };
    if (game.status !== 'active') return { completed: false, reason: 'resolved' };
    if (game.expires_at <= nowIso) {
      db.prepare("UPDATE economy_games SET status = 'expired', resolved_at = ? WHERE game_id = ? AND status = 'active'").run(nowIso, gameId);
      return { completed: false, reason: 'expired' };
    }
    const state = JSON.parse(game.state_json);
    if (action === 'cashout') {
      if (state.steps < 1) return { completed: false, reason: 'no-steps' };
      return settleGame(db, game, 'won', Math.floor(game.bet * state.multiplier), state, nowIso);
    }
    if (action !== 'step') return { completed: false, reason: 'action' };
    const crashChance = Math.min(75, 15 + state.steps * 8);
    const outcome = roll();
    if (!Number.isInteger(outcome) || outcome < 0 || outcome > 99) throw new Error('Chicken Road outcome is invalid.');
    if (outcome < crashChance) return settleGame(db, game, 'lost', 0, { ...state, crashedAtStep: state.steps + 1 }, nowIso);
    state.steps += 1;
    state.multiplier = Number((1.3 ** state.steps).toFixed(4));
    if (state.steps >= 8) return settleGame(db, game, 'won', Math.floor(game.bet * state.multiplier), state, nowIso);
    db.prepare("UPDATE economy_games SET state_json = ? WHERE game_id = ? AND status = 'active'").run(JSON.stringify(state), gameId);
    return { completed: false, active: true, state, bet: game.bet };
  })();
}

module.exports = {
  beginBlackjack,
  cardLabel,
  handValue,
  playCoinFlip,
  playRoulette,
  resolveBlackjackAction,
  resolveChickenAction,
  startChickenRoad,
};
