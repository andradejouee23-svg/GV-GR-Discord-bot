const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createDatabase } = require('../src/database');
const { getWallet } = require('../src/commands/economy');
const { setConfigValue } = require('../src/utils/discord');
const {
  beginBlackjack,
  playDiceDuel,
  playCoinFlip,
  playRoulette,
  playScratchCard,
  playSlots,
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

test('Dice Duel, Scratch Card, and Slots settle through the shared wallet and transaction engine', (t) => {
  const store = makeStore(t);
  setWallet(store.db, 'new-games-player', 10_000);
  const now = new Date('2026-11-09T13:00:00.000Z');

  const diceWin = playDiceDuel(store.db, 'new-games-player', 100, 'high', now, () => 6);
  assert.equal(diceWin.status, 'won');
  assert.equal(diceWin.payout, 200);
  const diceLoss = playDiceDuel(store.db, 'new-games-player', 100, 'low', now, () => 6);
  assert.equal(diceLoss.status, 'lost');
  assert.equal(diceLoss.payout, 0);

  const scratchJackpot = playScratchCard(store.db, 'new-games-player', 100, now, () => 4);
  assert.equal(scratchJackpot.state.result, 'jackpot');
  assert.equal(scratchJackpot.payout, 800);
  const scratchMiss = playScratchCard(store.db, 'new-games-player', 100, now, () => 99);
  assert.equal(scratchMiss.state.result, 'no-match');
  assert.equal(scratchMiss.payout, 0);

  const slotTriple = playSlots(store.db, 'new-games-player', 100, now, () => 1);
  assert.equal(slotTriple.state.result, 'triple');
  assert.equal(slotTriple.payout, 1000);
  const slotMiss = playSlots(store.db, 'new-games-player', 100, now, () => 99);
  assert.equal(slotMiss.state.result, 'miss');
  assert.equal(slotMiss.payout, 0);

  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_games').get().count, 6);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_transactions WHERE type IN (?, ?, ?)').get('dice_bet', 'scratch_bet', 'slots_bet').count, 6);
  assert.equal(getWallet(store.db, 'new-games-player').wallet_balance, 11_400);
});

test('configured maximum wager is enforced before game funds are moved', (t) => {
  const store = makeStore(t);
  setWallet(store.db, 'limited-player', 1000);
  setConfigValue(store.db, 'ECONOMY_GAME_MAX_BET', 50);
  assert.throws(() => beginBlackjack(store.db, 'limited-player', 51), /whole number from 1 to 50/);
  assert.equal(getWallet(store.db, 'limited-player').wallet_balance, 1000);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_games').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM economy_transactions').get().count, 0);
});

test('new game types migrate old economy game records without losing them', (t) => {
  const store = makeStore(t);
  setWallet(store.db, 'legacy-game-player', 1000);
  store.db.exec(`
    DROP INDEX one_active_economy_game_per_player;
    DROP INDEX economy_games_user_created;
    ALTER TABLE economy_games RENAME TO economy_games_before_update;
    CREATE TABLE economy_games (
      game_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES economy_accounts(user_id),
      game_type TEXT NOT NULL CHECK(game_type IN ('blackjack', 'coinflip', 'roulette', 'chicken')),
      bet INTEGER NOT NULL CHECK(bet > 0),
      status TEXT NOT NULL CHECK(status IN ('active', 'won', 'lost', 'push', 'expired')),
      state_json TEXT NOT NULL DEFAULT '{}',
      payout INTEGER NOT NULL DEFAULT 0 CHECK(payout >= 0),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      resolved_at TEXT
    );
    INSERT INTO economy_games SELECT * FROM economy_games_before_update;
    INSERT INTO economy_games (game_id, user_id, game_type, bet, status, state_json, payout, created_at, expires_at, resolved_at)
    VALUES ('legacy-blackjack', 'legacy-game-player', 'blackjack', 50, 'won', '{}', 100,
      '2026-11-09T12:00:00.000Z', '2026-11-09T12:05:00.000Z', '2026-11-09T12:01:00.000Z');
    DROP TABLE economy_games_before_update;
    CREATE UNIQUE INDEX one_active_economy_game_per_player ON economy_games(user_id) WHERE status = 'active';
    CREATE INDEX economy_games_user_created ON economy_games(user_id, created_at DESC);
  `);

  const reopened = store.reopen();
  assert.equal(reopened.prepare('SELECT game_type FROM economy_games WHERE game_id = ?').get('legacy-blackjack').game_type, 'blackjack');
  assert.deepEqual(reopened.pragma('foreign_key_check'), []);
  const dice = playDiceDuel(reopened, 'legacy-game-player', 20, 'high', new Date('2026-11-09T13:00:00.000Z'), () => 6);
  assert.equal(dice.status, 'won');
  assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM economy_games WHERE game_type = 'dice'").get().count, 1);
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
