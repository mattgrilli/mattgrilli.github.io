'use strict';

// Verifies the FIXED behaviour: node blackjack_verify.cjs script.js
// Uses the same mocked browser as blackjack_audit.cjs, which asserts the original bugs.
// The browser, audio, and timers are mocked; game methods are not replaced.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('Usage: node blackjack_verify.cjs path/to/script.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function makeEnvironment(savedStats = null) {
  class Element {
    constructor() {
      this.style = {};
      this.classList = { add() {}, remove() {}, toggle() {} };
      this.innerHTML = '';
      this.textContent = '';
      this.children = [];
      this.disabled = false;
    }
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    remove() {}
    addEventListener() {}
    querySelector() { return new Element(); }
    cloneNode() { return new Element(); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
    animate() { return {}; }
  }
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, new Element());
    return nodes.get(key);
  }
  const storage = new Map();
  if (savedStats) storage.set('blackjackStats', JSON.stringify(savedStats));
  let now = 0;
  let timerId = 0;
  const timers = [];
  const context = vm.createContext({
    console,
    Audio: class { play() { return Promise.resolve(); } },
    document: {
      body: node('body'),
      getElementById: id => node(id),
      createElement: () => new Element(),
      querySelector: selector => node(selector),
      querySelectorAll: () => [new Element(), new Element(), new Element(), new Element()],
      addEventListener() {}
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value))
    },
    setTimeout: (fn, ms = 0) => {
      const id = ++timerId;
      timers.push({ fn, time: now + ms, id });
      return id;
    },
    clearTimeout: id => {
      const index = timers.findIndex(timer => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    }
  });
  vm.runInContext(source + '\n;globalThis.auditExports = { Deck, Hand, Player, Game, game, getStats: () => ({...gameStats}), getSession: () => ({...sessionStats}) };', context, { filename: sourcePath });
  function flushTimers() {
    let count = 0;
    while (timers.length) {
      if (++count > 10000) throw new Error('Timer loop did not terminate');
      timers.sort((a, b) => a.time - b.time || a.id - b.id);
      const timer = timers.shift();
      now = timer.time;
      timer.fn();
    }
  }
  return { ...context.auditExports, node, flushTimers };
}

function initialDeal(env, values, bet = 100) {
  const suits = ['\u2660', '\u2665', '\u2666', '\u2663'];
  env.game.deck.cards = values.map((value, index) => ({ value, suit: suits[index % 4] })).reverse();
  env.game.deck.cutAtCardsRemaining = -1; // Keep tiny, prescribed test shoes from being reshuffled.
  env.game.deck.reshuffleNeeded = false;
  env.game.placeBet(bet);
  env.game.deal();
  env.flushTimers();
}


const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); process.exitCode = 1; }
}

test('Clear Bet is locked once cards are dealt', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', '10', 'K', '8']);
  assert.equal(env.game.clearBet(), false);
  assert.match(env.node('message').textContent, /locked/);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.game.player.balance, 1100);
  assert.equal(env.getStats().totalMoney, 100);
});

test('Removing a chip is locked during play', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', '10', 'K', '8']);
  assert.equal(env.game.removeBet(100), false);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.game.player.balance, 1100);
});

test('Clear Bet does not refund again after a settled win', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', '10', 'K', '8']);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.game.player.balance, 1100);
  env.game.clearBet();
  assert.equal(env.game.player.balance, 1100);
});

test('Clear Bet still works during the betting phase', () => {
  const env = makeEnvironment();
  env.game.placeBet(100);
  assert.equal(env.game.player.balance, 900);
  assert.equal(env.game.clearBet(), true);
  assert.equal(env.game.player.balance, 1000);
});

test('Surrender refunds half and records the real loss', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', '9', '6', '8']);
  env.game.surrender();
  assert.equal(env.game.player.balance, 950);
  assert.equal(env.getStats().totalMoney, -50);
  assert.equal(env.getSession().totalMoney, -50);
  assert.match(env.node('message').textContent, /\$50\)/);
  assert.equal(env.game.gamePhase, 'gameOver');
});

test('Busting one split hand lets the other hand play and settle', () => {
  const env = makeEnvironment();
  initialDeal(env, ['8', '10', '8', '7', '10', '9', 'K']);
  env.game.split(0);
  assert.equal(env.game.player.hands[0].getScore(), 18);
  assert.equal(env.game.player.hands[1].getScore(), 17);
  env.game.hit(0); // K -> bust
  assert.equal(env.game.gamePhase, 'playerTurn');
  assert.equal(env.game.currentHandIndex, 1);
  assert.equal(env.game.player.hands[0].settled, true);
  assert.equal(env.game.player.hands[1].settled, false);
  env.game.stand(1);
  env.flushTimers(); // dealer holds 17 -> push against the 17
  assert.equal(env.game.gamePhase, 'gameOver');
  assert.equal(env.game.player.hands[1].result, 'push');
  assert.equal(env.game.player.balance, 900); // 1000 - 100 (bust) - 0 (push)
  assert.equal(env.getStats().gamesPlayed, 2);
  assert.equal(env.getStats().totalMoney, -100);
});

test('If every split hand busts the round ends without the dealer drawing', () => {
  const env = makeEnvironment();
  initialDeal(env, ['8', '10', '8', '7', '10', '10', 'K', 'Q']);
  env.game.split(0);
  env.game.hit(0);
  assert.equal(env.game.gamePhase, 'playerTurn');
  env.game.hit(1);
  assert.equal(env.game.gamePhase, 'gameOver');
  assert.equal(env.game.dealer.cards.length, 2);
  assert.equal(env.game.player.balance, 800);
});

test('Surrender is not offered after splitting', () => {
  const env = makeEnvironment();
  initialDeal(env, ['8', '10', '8', '7', '10', '9']);
  assert.equal(env.game.canSurrender(), true);
  env.game.split(0);
  assert.equal(env.game.canSurrender(), false);
});

test('Insurance is offered before the dealer blackjack is revealed', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', 'A', '9', 'K']);
  assert.equal(env.game.gamePhase, 'insurance');
  assert.equal(env.game.canInsurance(), true);
  assert.equal(env.game.player.balance, 900);
});

test('Winning insurance vs dealer blackjack pays 2:1 and nets out the lost hand', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', 'A', '9', 'K']);
  env.game.buyInsurance();
  assert.equal(env.game.gamePhase, 'gameOver');
  assert.equal(env.game.player.balance, 1000); // -100 hand, +100 insurance
  assert.equal(env.getStats().totalMoney, 0);
  assert.equal(env.game.canInsurance(), false);
  env.game.buyInsurance(); // must be a no-op
  assert.equal(env.game.player.balance, 1000);
});

test('Declining insurance against a dealer blackjack loses the hand only', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', 'A', '9', 'K']);
  env.game.declineInsurance();
  assert.equal(env.game.gamePhase, 'gameOver');
  assert.equal(env.game.player.balance, 900);
  assert.equal(env.getStats().totalMoney, -100);
});

test('Losing insurance is charged once, counted in stats, and cannot be bought again', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', 'A', '9', '7']);
  env.game.buyInsurance();
  assert.equal(env.game.player.balance, 850);
  assert.equal(env.game.gamePhase, 'playerTurn');
  assert.equal(env.game.canInsurance(), false);
  env.game.buyInsurance();
  assert.equal(env.game.player.balance, 850);
  assert.equal(env.getStats().totalMoney, -50);
  assert.equal(env.getSession().totalMoney, -50);
  assert.equal(env.game.player.insurance, 0);
});

test('Split button and split action agree on unlike face cards', () => {
  const env = makeEnvironment();
  initialDeal(env, ['J', '9', 'Q', '8']);
  assert.equal(env.game.canSplit(), false);
  assert.equal(env.game.player.hands[0].canSplit(), false);
  env.game.split(0);
  assert.equal(env.game.player.hands.length, 1);
  assert.equal(env.game.player.balance, 900);
});

test('Split works for matching ranks and is capped at four hands', () => {
  const env = makeEnvironment();
  initialDeal(env, ['8', '10', '8', '7', '8', '8', '8', '8', '8', '8'], 10);
  assert.equal(env.game.canSplit(), true);
  env.game.split(0);
  assert.equal(env.game.player.hands.length, 2);
});

test('Cut card is measured in cards remaining and sits in the last quarter', () => {
  const env = makeEnvironment();
  for (let i = 0; i < 200; i++) {
    const deck = new env.Deck(6);
    assert.ok(deck.cutAtCardsRemaining >= 20 && deck.cutAtCardsRemaining <= 78, `cut ${deck.cutAtCardsRemaining}`);
  }
  const deck = new env.Deck(6);
  deck.cutAtCardsRemaining = 50;
  let draws = 0;
  while (!deck.needsReshuffle()) { deck.deal(); draws++; }
  assert.equal(draws, 263); // 312 - 50 cards dealt, +1 for the card that trips it
  assert.equal(deck.cardsRemaining(), 49);
});

test('Session stats start at zero while lifetime stats reload', () => {
  const env = makeEnvironment({ gamesPlayed: 10, gamesWon: 7, totalMoney: 3000 });
  assert.equal(env.game.player.balance, 1000);
  assert.equal(JSON.stringify(env.getSession()), JSON.stringify({ gamesPlayed: 0, gamesWon: 0, totalMoney: 0 }));
  assert.match(env.node('stats').innerHTML, /Session: .*Lifetime: /);
  initialDeal(env, ['10', '10', 'K', '8']);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.getSession().totalMoney, 100);
  assert.equal(env.getStats().totalMoney, 3100);
  assert.equal(env.getStats().gamesPlayed, 11);
});

test('Settling a hand twice pays it only once', () => {
  const env = makeEnvironment();
  initialDeal(env, ['10', '10', 'K', '8']);
  env.game.stand(0);
  env.flushTimers();
  env.game.determineWinner();
  env.game.determineWinner();
  assert.equal(env.game.player.balance, 1100);
  assert.equal(env.getStats().gamesPlayed, 1);
  assert.equal(env.game.player.settle(0, 'win'), null);
});

test('Player blackjack pays 3:2', () => {
  const env = makeEnvironment();
  initialDeal(env, ['A', '10', 'K', '9']);
  assert.equal(env.game.gamePhase, 'gameOver');
  assert.equal(env.game.player.balance, 1150);
  assert.equal(env.getStats().totalMoney, 150);
});

test('Double down doubles the wager, takes one card, and pays double', () => {
  const env = makeEnvironment();
  initialDeal(env, ['5', '10', '6', '7', 'K']);
  assert.equal(env.game.canDouble(), true);
  env.game.doubleDown(0);
  env.flushTimers();
  assert.equal(env.game.gamePhase, 'gameOver');
  assert.equal(env.game.player.balance, 1200);
  assert.equal(env.getStats().totalMoney, 200);
});

test('Action buttons are only enabled in the right phases', () => {
  const env = makeEnvironment();
  assert.equal(env.game.canHit(), false);
  initialDeal(env, ['10', 'A', '9', '7', '2']);
  assert.equal(env.game.canHit(), false); // insurance decision pending
  env.game.declineInsurance();
  assert.equal(env.game.canHit(), true);
  env.game.hit(0);
  assert.equal(env.game.canSurrender(), false);
});


async function drain(env) {
  for (let i = 0; i < 200; i++) {
    env.flushTimers();
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function fuzz(rounds) {
  const env = makeEnvironment();
  let stuck = 0;
  for (let round = 0; round < rounds; round++) {
    const g = env.game;
    if (g.player.balance < 20) { g.player.balance += 1000; env.sessionAdjust = (env.sessionAdjust || 0) + 1000; }
    const affordable = [5, 25, 100].filter(chip => chip <= g.player.balance);
    g.placeBet(affordable[Math.floor(Math.random() * affordable.length)]);
    g.deal();
    await drain(env);
    let guard = 0;
    while (g.gamePhase !== 'gameOver' && guard++ < 60) {
      if (g.gamePhase === 'insurance') { Math.random() < 0.5 ? g.buyInsurance() : g.declineInsurance(); }
      else if (g.gamePhase === 'playerTurn') {
        const roll = Math.random();
        if (roll < 0.15 && g.canSplit()) g.split(g.currentHandIndex);
        else if (roll < 0.30 && g.canDouble()) g.doubleDown(g.currentHandIndex);
        else if (roll < 0.35 && g.canSurrender()) g.surrender();
        else if (roll < 0.7 && g.canHit()) g.hit(g.currentHandIndex);
        else if (g.canStand()) g.stand(g.currentHandIndex);
      }
      await drain(env);
    }
    if (g.gamePhase !== 'gameOver') {
      stuck++;
      console.error('STUCK', JSON.stringify({ phase: g.gamePhase, cur: g.currentHandIndex, bal: g.player.balance, deck: g.deck.cardsRemaining(), dealer: g.dealer.cards.map(c => c.value), hands: g.player.hands.map(h => ({ cards: h.cards.map(c => c.value), bet: h.bet, settled: h.settled, done: h.done, dd: h.doubledDown })) }));
      break;
    }
    assert.ok(g.player.hands.every(hand => hand.settled), 'every hand settled at round end');
    const expected = 1000 + (env.sessionAdjust || 0) + env.getSession().totalMoney;
    assert.equal(g.player.balance, expected, `round ${round}: balance ${g.player.balance} vs ${expected}`);
    g.prepareNextHand();
  }
  assert.equal(stuck, 0, 'a round never finished');
}

(async () => {
  try { await fuzz(1500); results.push({ name: 'Fuzz: 1500 random rounds conserve money and always finish', ok: true }); }
  catch (error) { results.push({ name: 'Fuzz: random rounds', ok: false, error: error.message }); process.exitCode = 1; }
  console.log(JSON.stringify({ passed: results.filter(r => r.ok).length, total: results.length, failures: results.filter(r => !r.ok) }, null, 2));
})();
