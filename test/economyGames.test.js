const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDatabase } = require('../src/database');
const { getWallet } = require('../src/commands/economy');
const {
  beginBlackjack,
  playCoinFlip,
  playRoulette,
  resolveBlackjackAction,
  resolveChickenAction,
  startChickenRoad,
} = require('../src/services/economyGames');

function makeStore(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'gv-gr-games-'));
  const filename = path.join(directory, 'games.sqlite');
  let db = createDatabase(filename);
  t.after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get db() { return db; },
    reopen() { db.close(); db = createDatabase(filename); return db; },
  };
}

function setWallet(db, userId, balance) {
  getWallet(db, userId, '2026-11-01T10:00:00.000Z');
  db.prepare('UPDATE economy_accounts SET wallet_balance = ? WHERE user_id = ?').run(balance, userId);
}

test('blackjack wager and session survive restart and settle exactly once', (t) => {
  const store = makeStore(t);
  setWallet(store.db, 'blackjack-player', 1000);
  const now = new Date('2026-11-01T12:00:00.000Z');
  const cards = [10, 8, 6, 9];
  const started = beginBlackjack(store.db, 'blackjack-player', 100, now, () => cards.shift());
  assert.equal(started.started, true);
  assert.equal(getWallet(store.db, 'blackjack-player').wallet_balance, 900);
  assert.equal(beginBlackjack(store.db, 'blackjack-player', 50, now, () => 2).reason, 'active');

  const db = store.reopen();
  const result = resolveBlackjackAction(db, 'blackjack-player', started.gameId, 'stand', new Date(now.getTime() + 1000), () => 10);
  assert.equal(result.completed, true);
  assert.equal(result.status, 'won');
  assert.equal(result.payout, 200);
  assert.equal(getWallet(db, 'blackjack-player').wallet_balance, 1100);
  assert.equal(resolveBlackjackAction(db, 'blackjack-player', started.gameId, 'stand').reason, 'resolved');
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM economy_transactions WHERE type = 'blackjack_payout'").get().count, 1);
});

test('coin flip and roulette apply their documented payouts and standard wheel colors', (t) => {
  const store = makeStore(t);
  setWallet(store.db, 'casino-player', 1000);
  const now = new Date('2026-11-01T13:00:00.000Z');
  const coin = playCoinFlip(store.db, 'casino-player', 100, 'heads', now, () => 0);
  assert.equal(coin.status, 'won');
  assert.equal(coin.payout, 200);
  const red = playRoulette(store.db, 'casino-player', 100, 'red', now, () => 3);
  assert.equal(red.state.result, 'red');
  assert.equal(red.payout, 200);
  const green = playRoulette(store.db, 'casino-player', 100, 'green', now, () => 0);
  assert.equal(green.payout, 3600);
  assert.equal(getWallet(store.db, 'casino-player').wallet_balance, 4700);
});

test('Chicken Road supports progressive cashout, rejects repeat settlement, and expires old sessions', (t) => {
  const store = makeStore(t);
  setWallet(store.db, 'chicken-player', 1000);
  const start = new Date('2026-11-01T14:00:00.000Z');
  const game = startChickenRoad(store.db, 'chicken-player', 100, start);
  const step = resolveChickenAction(store.db, 'chicken-player', game.gameId, 'step', new Date(start.getTime() + 1000), () => 99);
  assert.equal(step.active, true);
  assert.equal(step.state.multiplier, 1.3);
  const payout = resolveChickenAction(store.db, 'chicken-player', game.gameId, 'cashout', new Date(start.getTime() + 2000));
  assert.equal(payout.payout, 130);
  assert.equal(getWallet(store.db, 'chicken-player').wallet_balance, 1030);
  assert.equal(resolveChickenAction(store.db, 'chicken-player', game.gameId, 'cashout').reason, 'resolved');

  const abandoned = startChickenRoad(store.db, 'chicken-player', 100, new Date(start.getTime() + 3000));
  assert.equal(abandoned.started, true);
  const recovered = startChickenRoad(store.db, 'chicken-player', 100, new Date(start.getTime() + 6 * 60_000));
  assert.equal(recovered.started, true);
  assert.equal(store.db.prepare('SELECT status FROM economy_games WHERE game_id = ?').get(abandoned.gameId).status, 'expired');
});
