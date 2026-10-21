'use strict';

// Checks for Matt's Baccarat. Run with:  node baccarat_verify.cjs
//
// Part 1 tests the engine (baccarat-engine.js) directly in plain Node: the exact odds
// against the published 8-deck figures, the third-card rules case by case, settlement,
// and a seeded simulation of the real shoe-and-dealing code converging to those odds.
// Part 2 loads the engine and the page (baccarat.js) into a mocked browser.
//
// All money in the engine is integer cents.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const enginePath = path.join(dir, 'baccarat-engine.js');
const scriptPath = path.join(dir, 'baccarat.js');
const {
  BaccaratEngine, Shoe, cardPoints, handTotal, playerDraws, bankerDraws, playCoup,
  computeExactOdds, computeOddsTable
} = require(enginePath);

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); process.exitCode = 1; }
}

function record(engine) {
  const events = [];
  engine.subscribe(event => events.push(event));
  return events;
}

// A small seeded PRNG (mulberry32) so the statistical test is fully deterministic: the
// same numbers every run, never an intermittent failure.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cards for a stacked deal. Suits don't matter to baccarat; ranks are given as strings.
const cards = (...ranks) => ranks.map((rank, i) => ({ rank, suit: ['♠', '♥', '♦', '♣'][i % 4] }));

// =====================================================================
// Part 1: card values, the tableau, and the exact odds
// =====================================================================

test('Engine: card points - A is 1, 2-9 face value, 10/J/Q/K are 0', () => {
  assert.equal(cardPoints('A'), 1);
  for (let n = 2; n <= 9; n++) assert.equal(cardPoints(String(n)), n);
  ['10', 'J', 'Q', 'K'].forEach(r => assert.equal(cardPoints(r), 0));
});

test('Engine: a hand total is the last digit of its points', () => {
  assert.equal(handTotal(cards('7', '8')), 5);
  assert.equal(handTotal(cards('K', '9')), 9);
  assert.equal(handTotal(cards('5', '5')), 0);
  assert.equal(handTotal(cards('9', '9', '9')), 7);
});

test('Engine: Player draws on 0-5 and stands on 6-7', () => {
  for (let t = 0; t <= 5; t++) assert.equal(playerDraws(t), true, `total ${t}`);
  assert.equal(playerDraws(6), false);
  assert.equal(playerDraws(7), false);
});

test('Engine: Banker draws on 0-5 and stands on 6-7 when the Player stood', () => {
  for (let t = 0; t <= 5; t++) assert.equal(bankerDraws(t, null), true, `total ${t}`);
  assert.equal(bankerDraws(6, null), false);
  assert.equal(bankerDraws(7, null), false);
});

test('Engine: the full Banker tableau when the Player drew a third card', () => {
  // [bankerTotal]: the Player third-card values (0-9) on which the Banker DRAWS.
  const drawsOn = {
    0: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    1: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    2: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    3: [0, 1, 2, 3, 4, 5, 6, 7, 9],
    4: [2, 3, 4, 5, 6, 7],
    5: [4, 5, 6, 7],
    6: [6, 7],
    7: []
  };
  for (const [bt, list] of Object.entries(drawsOn)) {
    for (let p3 = 0; p3 <= 9; p3++) {
      assert.equal(bankerDraws(Number(bt), p3), list.includes(p3), `banker ${bt}, player third ${p3}`);
    }
  }
});

test('Engine: a natural 8 or 9 ends the hand - nobody draws', () => {
  const coup = playCoup((() => { const s = cards('9', '2', 'K', '3', '5', '5'); return () => s.shift(); })());
  assert.equal(coup.natural, true);
  assert.equal(coup.player.length, 2);
  assert.equal(coup.banker.length, 2); // banker 5 would otherwise draw
  assert.equal(coup.winner, 'player');
  assert.equal(coup.playerTotal, 9);
});

test('Engine: Player draws on 5, then Banker applies the tableau to that third card', () => {
  // Player 2+3 = 5 draws a 4 -> 9. Banker 2+3 = 5, Player's third is 4 -> Banker draws.
  const coup = playCoup((() => { const s = cards('2', '2', '3', '3', '4', 'K'); return () => s.shift(); })());
  assert.equal(coup.player.length, 3);
  assert.equal(coup.banker.length, 3);
  assert.equal(coup.playerTotal, 9);
  assert.equal(coup.bankerTotal, 5);
  assert.equal(coup.winner, 'player');
  assert.deepEqual(coup.order.map(o => o.side), ['player', 'banker', 'player', 'banker', 'player', 'banker']);
});

test('Engine: Banker 6 stands against a Player third card of 5, draws against a 6', () => {
  const stands = playCoup((() => { const s = cards('2', '3', '2', '3', '5', 'K'); return () => s.shift(); })());
  assert.equal(stands.banker.length, 2); // banker 6, player third 5 -> stand
  const draws = playCoup((() => { const s = cards('2', '3', '2', '3', '6', 'K'); return () => s.shift(); })());
  assert.equal(draws.banker.length, 3); // banker 6, player third 6 -> draw
});

test('Engine: exact odds match the published 8-deck figures', () => {
  const p = computeExactOdds(8);
  assert.ok(Math.abs(p.banker - 0.458597) < 5e-7, `banker ${p.banker}`);
  assert.ok(Math.abs(p.player - 0.446247) < 5e-7, `player ${p.player}`);
  assert.ok(Math.abs(p.tie - 0.095156) < 5e-7, `tie ${p.tie}`);
  assert.ok(Math.abs(p.banker + p.player + p.tie - 1) < 1e-12, 'probabilities must sum to 1');
});

test('Engine: house edges match the published figures (Banker 1.06%, Player 1.24%, Tie 14.36%)', () => {
  const table = Object.fromEntries(computeOddsTable(8).map(r => [r.key, r.houseEdgePct]));
  assert.ok(Math.abs(table.banker - 1.0579) < 0.0005, `banker ${table.banker}`);
  assert.ok(Math.abs(table.player - 1.2351) < 0.0005, `player ${table.player}`);
  assert.ok(Math.abs(table.tie - 14.3596) < 0.0005, `tie ${table.tie}`);
});

test('Engine: the shoe has 8 full decks and the cut card is 14-30 cards from the end', () => {
  for (let i = 0; i < 50; i++) {
    const shoe = new Shoe(8, Math.random);
    assert.equal(shoe.cards.length, 416);
    assert.ok(shoe.cutAtCardsRemaining >= 14 && shoe.cutAtCardsRemaining <= 30);
  }
  const shoe = new Shoe(8, Math.random);
  const counts = {};
  shoe.cards.forEach(c => { counts[c.rank] = (counts[c.rank] || 0) + 1; });
  Object.values(counts).forEach(n => assert.equal(n, 32));
});

// =====================================================================
// Part 2: betting, dealing and settlement
// =====================================================================

test('Engine: placing bets deducts stakes, and several spots can be bet at once', () => {
  const e = new BaccaratEngine({ startingBalance: 10_000 });
  const events = record(e);
  assert.equal(e.placeBet('banker', 2_000).ok, true);
  assert.equal(e.placeBet('tie', 500).ok, true);
  assert.equal(e.placeBet('banker', 1_000).ok, true); // stacks onto the same spot
  assert.equal(e.balance, 10_000 - 3_500);
  assert.equal(e.bets.banker, 3_000);
  assert.equal(e.bets.tie, 500);
  assert.equal(e.totalWagered(), 3_500);
  assert.equal(events.filter(ev => ev.type === 'betPlaced').length, 3);
});

test('Engine: invalid bets are refused', () => {
  const e = new BaccaratEngine({ startingBalance: 1_000 });
  assert.equal(e.placeBet('dragon', 100).reason, 'invalid');
  assert.equal(e.placeBet('player', 50).reason, 'invalid'); // below the $1 minimum
  assert.equal(e.placeBet('player', 150.5).reason, 'invalid');
  assert.equal(e.placeBet('player', 2_000).reason, 'insufficient');
  assert.equal(e.balance, 1_000);
});

test('Engine: clearing bets refunds them, only before the deal', () => {
  const e = new BaccaratEngine({ startingBalance: 1_000 });
  e.placeBet('player', 300);
  e.placeBet('tie', 100);
  assert.equal(e.clearBets().ok, true);
  assert.equal(e.balance, 1_000);
  assert.equal(e.clearBets().reason, 'nothing');
  e.placeBet('player', 100);
  e.deal();
  assert.equal(e.clearBets().reason, 'nothing');
});

test('Engine: cannot deal without a bet, and dealing locks the table', () => {
  const e = new BaccaratEngine();
  assert.equal(e.deal().reason, 'nobets');
  e.placeBet('player', 100);
  e.deal();
  assert.equal(e.phase, 'results');
  assert.equal(e.deal().reason, 'locked');
  assert.equal(e.placeBet('player', 100).reason, 'locked');
});

test('Engine: a Player win pays 1:1', () => {
  const e = new BaccaratEngine({ startingBalance: 10_000 });
  e.placeBet('player', 1_000);
  const { coup } = e.deal(cards('9', '2', 'K', '3')); // player natural 9 vs banker 5
  assert.equal(coup.winner, 'player');
  assert.equal(coup.results[0].payout, 2_000);
  assert.equal(e.balance, 11_000);
});

test('Engine: a Banker win pays 1:1 less a 5% commission', () => {
  const e = new BaccaratEngine({ startingBalance: 10_000 });
  e.placeBet('banker', 1_000);
  const { coup } = e.deal(cards('2', '9', '3', 'K')); // player 5 vs banker natural 9
  assert.equal(coup.winner, 'banker');
  assert.equal(coup.results[0].payout, 1_950); // $10 back + $9.50
  assert.equal(e.balance, 10_950);
});

test('Engine: a tie pays the Tie bet 8:1 and pushes Player and Banker', () => {
  const t = new BaccaratEngine({ startingBalance: 10_000 });
  t.placeBet('player', 1_000);
  t.placeBet('banker', 1_000);
  t.placeBet('tie', 100);
  const { coup: tie } = t.deal(cards('8', '8', 'K', 'Q')); // natural 8 vs natural 8
  assert.equal(tie.winner, 'tie');
  const byspot = Object.fromEntries(tie.results.map(r => [r.spot, r]));
  assert.equal(byspot.player.outcome, 'push');
  assert.equal(byspot.player.payout, 1_000);
  assert.equal(byspot.banker.outcome, 'push');
  assert.equal(byspot.banker.payout, 1_000);
  assert.equal(byspot.tie.outcome, 'won');
  assert.equal(byspot.tie.payout, 900);
  assert.equal(t.balance, 10_000 - 2_100 + 2_900);
});

test('Engine: commission on an odd stake rounds up to the cent', () => {
  const e = new BaccaratEngine({ startingBalance: 10_000 });
  e.placeBet('banker', 130); // 5% of $1.30 is 6.5 cents
  const { coup } = e.deal(cards('2', '9', '3', 'K'));
  assert.equal(coup.results[0].payout, 130 * 2 - 7);
  assert.ok(Number.isInteger(e.balance));
});

test('Engine: statistics and the bead-road history track every hand', () => {
  const e = new BaccaratEngine({ startingBalance: 100_000 });
  e.placeBet('player', 100);
  e.deal(cards('9', '2', 'K', '3'));
  e.nextRound();
  e.placeBet('player', 100);
  e.deal(cards('2', '9', '3', 'K'));
  e.nextRound();
  e.placeBet('tie', 100);
  e.deal(cards('8', '8', 'K', 'Q'));
  assert.deepEqual(e.history, ['player', 'banker', 'tie']);
  assert.equal(e.stats.handsPlayed, 3);
  assert.equal(e.stats.playerWins, 1);
  assert.equal(e.stats.bankerWins, 1);
  assert.equal(e.stats.ties, 1);
  assert.equal(e.stats.totalWagered, 300);
  assert.equal(e.stats.biggestWin, 900);
});

test('Engine: the history keeps only the most recent hands', () => {
  const e = new BaccaratEngine({ startingBalance: 10_000_000, rng: seeded(7) });
  for (let i = 0; i < BaccaratEngine.HISTORY_LENGTH + 25; i++) {
    e.placeBet('player', 100);
    e.deal();
    e.nextRound();
  }
  assert.equal(e.history.length, BaccaratEngine.HISTORY_LENGTH);
});

test('Engine: the shoe reshuffles at the cut card, before a hand, never during one', () => {
  const e = new BaccaratEngine({ startingBalance: 10_000_000, rng: seeded(3) });
  const events = record(e);
  let shuffles = 0;
  for (let i = 0; i < 300; i++) {
    const before = e.shoe.cards.length;
    e.placeBet('player', 100);
    const { coup } = e.deal();
    const used = coup.player.length + coup.banker.length;
    const shuffled = events.filter(ev => ev.type === 'shuffled').length > shuffles;
    if (shuffled) {
      shuffles++;
      assert.equal(e.shoe.cards.length, 416 - used);
    } else {
      assert.equal(e.shoe.cards.length, before - used);
    }
    e.nextRound();
  }
  assert.ok(shuffles >= 2, `expected several shuffles across 300 hands, got ${shuffles}`);
});

test('Engine: nextRound clears bets and returns to betting, only after a hand', () => {
  const e = new BaccaratEngine();
  assert.equal(e.nextRound(), false);
  e.placeBet('player', 100);
  assert.equal(e.nextRound(), false);
  e.deal();
  assert.equal(e.nextRound(), true);
  assert.equal(e.totalWagered(), 0);
  assert.equal(e.lastCoup, null);
});

test('Engine: the player can set their own starting balance before betting', () => {
  const e = new BaccaratEngine();
  assert.equal(e.setBalance(500_000).ok, true);
  assert.equal(e.balance, 500_000);
  assert.equal(e.startingBalance, 500_000);
  assert.equal(e.setBalance(50).reason, 'invalid');
  e.placeBet('player', 100);
  assert.equal(e.setBalance(100_000).reason, 'locked');
});

test('Engine: going broke offers a restart to the chosen bankroll', () => {
  const e = new BaccaratEngine();
  e.setBalance(100);
  e.placeBet('player', 100);
  assert.equal(e.isBroke(), false); // a bet is on the table
  e.deal(cards('2', '9', '3', 'K')); // banker wins
  assert.equal(e.balance, 0);
  assert.equal(e.isBroke(), true);
  assert.equal(e.restart(), true);
  assert.equal(e.balance, 100);
  assert.equal(e.history.length, 0);
});

test('Engine: restart refuses while there is still money', () => {
  assert.equal(new BaccaratEngine().restart(), false);
});

test('Engine: 500,000 seeded hands through the real shoe converge to the exact odds', () => {
  const e = new BaccaratEngine({ startingBalance: 1e12, rng: seeded(20261021) });
  const n = 500_000;
  for (let i = 0; i < n; i++) {
    e.placeBet('player', 100);
    e.placeBet('banker', 100);
    e.placeBet('tie', 100);
    e.deal();
    e.nextRound();
  }
  const exact = computeExactOdds(8);
  const freq = { player: e.stats.playerWins / n, banker: e.stats.bankerWins / n, tie: e.stats.ties / n };
  // Standard error is about 0.07 percentage points at this sample size; allow 0.4.
  for (const side of ['player', 'banker', 'tie']) {
    assert.ok(Math.abs(freq[side] - exact[side]) < 0.004, `${side}: simulated ${freq[side]} vs exact ${exact[side]}`);
  }
});

test('Engine: fuzz - random hands and bets never create or lose a cent', () => {
  const e = new BaccaratEngine({ startingBalance: 100_000 });
  let adjust = 0;
  for (let round = 0; round < 5000; round++) {
    if (e.balance < 2_000) { e.balance += 100_000; adjust += 100_000; }
    for (const spot of ['player', 'banker', 'tie']) {
      if (Math.random() < 0.6) e.placeBet(spot, 100 * (1 + Math.floor(Math.random() * 5)) + (Math.random() < 0.3 ? 37 : 0));
    }
    if (e.totalWagered() === 0) e.placeBet('banker', 100);
    assert.equal(e.deal().ok, true);
    assert.ok(Number.isInteger(e.balance), `non-integer balance at round ${round}`);
    assert.equal(e.balance, 100_000 + adjust - e.stats.totalWagered + e.stats.totalWon, `round ${round}`);
    e.nextRound();
  }
});


// =====================================================================
// Part 3: the page (baccarat.js) in a mocked browser
// =====================================================================

function makeEnvironment(savedStats = null, { storageThrows = false, presets = {} } = {}) {
  // A minimal DOM, the same as the other games' page tests use.
  class Element {
    constructor() {
      this.style = {};
      this.dataset = {};
      this.attributes = {};
      this._classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(name => this._classes.add(name)),
        remove: (...names) => names.forEach(name => this._classes.delete(name)),
        toggle: (name, force) => {
          const on = force === undefined ? !this._classes.has(name) : force;
          if (on) this._classes.add(name); else this._classes.delete(name);
          return on;
        },
        contains: name => this._classes.has(name)
      };
      this._text = '';
      this.children = [];
      this.parentNode = null;
      this.disabled = false;
      this.hidden = false;
    }
    get className() { return [...this._classes].join(' '); }
    set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
    replaceChild(next, old) {
      const index = this.children.indexOf(old);
      if (index === -1) throw new Error('replaceChild: not a child');
      next.remove();
      this.children[index] = next;
      next.parentNode = this;
      old.parentNode = null;
      return old;
    }
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index === -1) throw new Error('removeChild: not a child');
      this.children.splice(index, 1);
      child.parentNode = null;
      return child;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener() {}
  }
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, new Element());
    return nodes.get(key);
  };
  const storage = new Map();
  if (savedStats) storage.set('baccaratStats', typeof savedStats === 'string' ? savedStats : JSON.stringify(savedStats));
  for (const [key, value] of Object.entries(presets)) storage.set(key, value);
  const playLog = [];
  let now = 0;
  let timerId = 0;
  const timers = [];
  const documentListeners = [];
  const context = vm.createContext({
    console,
    Audio: class { constructor(src) { this.src = src; } play() { playLog.push(this.src); return Promise.resolve(); } },
    document: {
      body: node('body'),
      getElementById: id => node(id),
      createElement: () => new Element(),
      addEventListener: (type, fn) => documentListeners.push({ type, fn })
    },
    localStorage: {
      getItem: key => { if (storageThrows) throw new Error('storage blocked'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageThrows) throw new Error('storage blocked'); storage.set(key, String(value)); }
    },
    setTimeout: (fn, ms = 0) => { const id = ++timerId; timers.push({ fn, time: now + ms, id }); return id; },
    clearTimeout: id => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); }
  });
  function flushTimers() {
    let count = 0;
    while (timers.length) {
      if (++count > 20000) throw new Error('Timer loop did not terminate');
      timers.sort((a, b) => a.time - b.time || a.id - b.id);
      const timer = timers.shift();
      now = timer.time;
      timer.fn();
    }
  }
  function stepTimers(n = 1) {
    let ran = 0;
    while (ran < n && timers.length) {
      timers.sort((a, b) => a.time - b.time || a.id - b.id);
      const timer = timers.shift();
      now = timer.time;
      timer.fn();
      ran++;
    }
    return ran;
  }
  const source = fs.readFileSync(enginePath, 'utf8') + '\n' + fs.readFileSync(scriptPath, 'utf8');
  vm.runInContext(source + '\n;globalThis.pageExports = { engine, table, getStats: () => ({...gameStats}), getSession: () => ({...sessionStats}), toggleMute, isMuted: () => soundMuted, formatMoney };', context, { filename: 'baccarat-engine.js+baccarat.js' });
  // Dispatches a key press to the page's document-level handlers, as if pressed while
  // `target` had focus.
  function pressKey(key, target = { tagName: 'BODY', getAttribute: () => null }) {
    const event = { key, target, ctrlKey: false, metaKey: false, preventDefault() {} };
    documentListeners.filter(l => l.type === 'keydown').forEach(l => l.fn(event));
  }
  return { ...context.pageExports, node, flushTimers, stepTimers, playLog, storage, pressKey };
}

// Deals a hand through the page with stacked cards: the engine call the page makes, but
// with known cards, then the same re-render the page does after a real deal.
function stackedDeal(env, ...ranks) {
  const result = env.engine.deal(cards(...ranks));
  env.table.updateUI();
  return result;
}

test('Page: the engine and page scripts declare no top-level name twice', () => {
  // Both files load as plain <script> tags sharing one global scope. A repeated `const`
  // would throw, but a repeated `function` silently replaces the first one - which is
  // exactly how the page's own stats helper once overwrote the engine's.
  const decl = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm;
  const names = file => new Set([...fs.readFileSync(file, 'utf8').matchAll(decl)].map(m => m[1] || m[2]));
  const engineNames = names(enginePath);
  const shared = [...names(scriptPath)].filter(n => engineNames.has(n));
  assert.deepEqual(shared, []);
});

test('Page: three betting spots - Player, Tie, Banker', () => {
  const env = makeEnvironment();
  assert.deepEqual(Object.keys(env.table.spots), ['player', 'tie', 'banker']);
  assert.equal(env.node('bet-spots').children.length, 3);
});

test('Page: selecting a chip and clicking a spot bets that many dollars', () => {
  const env = makeEnvironment();
  env.table.selectAmount(25);
  env.table.spots.banker.onclick();
  env.table.spots.banker.onclick();
  assert.equal(env.engine.bets.banker, 5_000); // two $25 bets, in cents
  assert.equal(env.table.spots.banker.parts.badge.textContent, '$50');
  assert.equal(env.table.spots.banker.classList.contains('has-bet'), true);
  assert.equal(env.node('wagered').textContent, 'Wagered: $50');
  assert.equal(env.node('balance').textContent, 'Balance: $950');
});

test('Page: Enter deals from the page, but not when pressed on a focused button or chip', () => {
  const env = makeEnvironment();
  env.table.spots.player.onclick();
  env.pressKey('Enter', { tagName: 'BUTTON', getAttribute: () => null }); // e.g. a focused bet spot
  env.pressKey('Enter', { tagName: 'DIV', getAttribute: name => (name === 'role' ? 'button' : null) }); // a chip
  env.pressKey('Enter', { tagName: 'INPUT', getAttribute: () => null });
  assert.equal(env.engine.phase, 'betting');
  env.pressKey('Enter');
  assert.equal(env.engine.phase, 'results');
});

test('Page: money shows cents only when there are some', () => {
  const env = makeEnvironment();
  assert.equal(env.formatMoney(100_000), '$1,000');
  assert.equal(env.formatMoney(1_950), '$19.50');
  assert.equal(env.formatMoney(-705), '-$7.05');
});

test('Page: dealing shows both hands, their totals, and highlights the winner', () => {
  const env = makeEnvironment();
  env.table.spots.player.onclick();
  stackedDeal(env, '9', '2', 'K', '3'); // player natural 9 vs banker 5
  assert.equal(env.node('game-container').dataset.phase, 'results');
  assert.equal(env.node('player-cards').children.length, 2);
  assert.equal(env.node('banker-cards').children.length, 2);
  assert.equal(env.node('player-score').textContent, '9');
  assert.equal(env.node('banker-score').textContent, '5');
  assert.equal(env.node('player-panel').classList.contains('winner'), true);
  assert.equal(env.node('banker-panel').classList.contains('winner'), false);
  assert.equal(env.table.spots.player.classList.contains('bet-won'), true);
});

test('Page: cards animate in at their place in the real dealing order', () => {
  const env = makeEnvironment();
  env.table.spots.player.onclick();
  stackedDeal(env, '2', '2', '3', '3', '4', 'K'); // six cards: P B P B P B
  const delays = side => env.node(`${side}-cards`).children.map(c => c.style.animationDelay);
  assert.deepEqual(delays('player'), ['0ms', '360ms', '720ms']);
  assert.deepEqual(delays('banker'), ['180ms', '540ms', '900ms']);
});

test('Page: a Banker win reports the commission-adjusted winnings in dollars and cents', () => {
  const env = makeEnvironment();
  env.table.selectAmount(10);
  env.table.spots.banker.onclick();
  stackedDeal(env, '2', '9', '3', 'K');
  assert.match(env.node('message').textContent, /Banker wins with a natural, 9 to 5\. You won \$9\.50\./);
  assert.equal(env.node('balance').textContent, 'Balance: $1,009.50');
});

test('Page: a tie pushes Player/Banker bets and says so', () => {
  const env = makeEnvironment();
  env.table.spots.player.onclick();
  stackedDeal(env, '8', '8', 'K', 'Q');
  assert.match(env.node('message').textContent, /Tie at 8\. Your bets came back even\./);
  assert.equal(env.table.spots.player.classList.contains('bet-push'), true);
  assert.equal(env.playLog.includes('sounds/draw.wav'), true);
});

test('Page: winning a Tie bet plays the big-win sound', () => {
  const env = makeEnvironment();
  env.table.spots.tie.onclick();
  stackedDeal(env, '8', '8', 'K', 'Q');
  assert.equal(env.playLog.includes('sounds/blackjack.mp3'), true);
  assert.equal(env.table.spots.tie.classList.contains('bet-won'), true);
});

test('Page: the bead road records each result and keeps existing beads', () => {
  const env = makeEnvironment();
  env.table.spots.player.onclick();
  stackedDeal(env, '9', '2', 'K', '3');
  const first = env.node('bead-road').children[0];
  env.table.nextRound();
  env.table.spots.player.onclick();
  stackedDeal(env, '2', '9', '3', 'K');
  const beads = env.node('bead-road').children;
  assert.deepEqual(beads.map(b => b.textContent), ['P', 'B']);
  assert.equal(beads[0], first); // not rebuilt
  assert.match(env.node('scoreboard-counts').textContent, /Since you sat down: Banker 1 · Player 1 · Tie 0/);
});

test('Page: Next Hand clears the table but keeps the scoreboard', () => {
  const env = makeEnvironment();
  env.table.spots.player.onclick();
  stackedDeal(env, '9', '2', 'K', '3');
  env.table.nextRound();
  assert.equal(env.node('game-container').dataset.phase, 'betting');
  assert.equal(env.node('player-cards').children.length, 0);
  assert.equal(env.node('player-score').hidden, true);
  assert.equal(env.table.spots.player.parts.badge.textContent, '');
  assert.equal(env.node('bead-road').children.length, 1);
});

test('Page: Same Bets Again repeats the last hand\'s bets', () => {
  const env = makeEnvironment();
  env.table.selectAmount(5);
  env.table.spots.banker.onclick();
  env.table.selectAmount(1);
  env.table.spots.tie.onclick();
  env.table.deal();
  assert.equal(env.node('rebet').disabled, false);
  assert.equal(env.table.rebet(), true);
  assert.equal(env.engine.phase, 'betting');
  assert.equal(env.engine.bets.banker, 500);
  assert.equal(env.engine.bets.tie, 100);
  assert.equal(env.engine.bets.player, 0);
});

test('Page: Same Bets Again is unavailable when the balance cannot cover them', () => {
  const env = makeEnvironment();
  env.table.setBankroll(10);
  env.table.selectAmount(10);
  env.table.spots.player.onclick();
  stackedDeal(env, '2', '9', '3', 'K'); // lose everything
  env.table.lastBets = { player: 1_000, banker: 0, tie: 0 };
  env.table.updateUI();
  assert.equal(env.node('rebet').disabled, true);
});

test('Page: the shoe indicator shows the cards left', () => {
  const env = makeEnvironment();
  assert.equal(env.node('cards-remaining').textContent, '416 cards');
  env.table.spots.player.onclick();
  env.table.deal();
  const used = env.engine.lastCoup.player.length + env.engine.lastCoup.banker.length;
  assert.equal(env.node('cards-remaining').textContent, `${416 - used} cards`);
});

test('Page: the paytable lists all three bets with their exact edges', () => {
  const env = makeEnvironment();
  assert.equal(env.node('paytable').hidden, true);
  env.table.togglePaytable();
  assert.equal(env.node('paytable').hidden, false);
  const rows = env.node('paytable-body').children;
  assert.deepEqual(rows.map(r => r.parts[0].textContent), ['Player', 'Banker', 'Tie']);
  assert.deepEqual(rows.map(r => r.parts[3].textContent), ['1.24%', '1.06%', '14.36%']);
});

test('Page: setting the starting balance, locked once bets are down', () => {
  const env = makeEnvironment();
  assert.equal(env.table.setBankroll(250), true);
  assert.equal(env.node('balance').textContent, 'Balance: $250');
  assert.equal(env.table.setBankroll(2.5), false);
  env.table.spots.player.onclick();
  assert.equal(env.table.setBankroll(500), false);
  assert.match(env.node('message').textContent, /before placing bets/);
});

test('Page: going broke shows New Game, which restores the chosen bankroll', () => {
  const env = makeEnvironment();
  env.table.setBankroll(5);
  env.table.selectAmount(5);
  env.table.spots.player.onclick();
  stackedDeal(env, '2', '9', '3', 'K');
  assert.equal(env.node('restart').style.display, 'inline-block');
  env.table.restart();
  assert.equal(env.node('balance').textContent, 'Balance: $5');
  assert.equal(env.node('restart').style.display, 'none');
  assert.equal(env.node('bead-road').children.length, 0);
});

test('Page: statistics are recorded in cents and persist across a reload', () => {
  const env = makeEnvironment({ handsPlayed: 4, totalWagered: 2_000, totalWon: 1_500, biggestWin: 1_000 });
  env.table.selectAmount(10);
  env.table.spots.banker.onclick();
  stackedDeal(env, '2', '9', '3', 'K');
  assert.equal(env.getSession().handsPlayed, 1);
  assert.equal(env.getSession().totalWon, 1_950);
  assert.equal(env.getStats().handsPlayed, 5);
  assert.equal(env.getStats().biggestWin, 1_950);
  assert.match(env.node('stats').textContent, /won \$19\.50/);
});

test('Page: mute silences sounds and is remembered', () => {
  const env = makeEnvironment();
  env.toggleMute();
  env.table.spots.player.onclick();
  env.table.deal();
  assert.equal(env.playLog.length, 0);
  assert.equal(env.storage.get('baccaratMuted'), '1');
  const restored = makeEnvironment(null, { presets: { baccaratMuted: '1' } });
  assert.equal(restored.isMuted(), true);
});

test('Page: corrupt saved stats or blocked storage do not break the game', () => {
  for (const bad of ['{nope', '[]', 'null', '{"handsPlayed":"x"}']) {
    assert.equal(makeEnvironment(bad).getStats().handsPlayed, 0, bad);
  }
  const blocked = makeEnvironment(null, { storageThrows: true });
  blocked.table.spots.player.onclick();
  blocked.table.deal();
  assert.equal(blocked.engine.phase, 'results');
});

// ---- Fast-forward ----

test('Page: fast-forward replays the current bets for many real hands', () => {
  const env = makeEnvironment();
  env.engine.balance = 100_000_000;
  env.table.selectAmount(10);
  env.table.spots.banker.onclick();
  env.table.selectAmount(1);
  env.table.spots.tie.onclick();
  env.table.runFastForward(400);
  assert.equal(env.node('game-container').dataset.fastforward, 'true');
  assert.equal(env.node('deal-button').disabled, true);
  env.flushTimers();
  assert.equal(env.node('game-container').dataset.fastforward, 'false');
  assert.equal(env.engine.phase, 'betting');
  assert.equal(env.engine.totalWagered(), 0);
  assert.equal(env.getSession().handsPlayed, 400);
  assert.equal(env.getSession().totalWagered, 400 * 1_100);
  assert.equal(env.engine.balance, 100_000_000 - 400 * 1_100 + env.getSession().totalWon);
  const summary = env.node('fastforward-summary');
  assert.equal(summary.hidden, false);
  assert.match(summary.children[0].textContent, /Simulation complete/);
  assert.match(summary.children[1].innerHTML, /Hands played: 400/);
  assert.match(summary.children[1].innerHTML, /exact: 45\.9%/);
  assert.equal(env.node('bead-road').children.length, BaccaratEngine.HISTORY_LENGTH);
  assert.equal(env.table.lastBets.banker, 1_000); // Same Bets Again uses the simulated pattern
});

test('Page: fast-forward needs bets on the table first', () => {
  const env = makeEnvironment();
  assert.equal(env.table.canFastForward(), false);
  env.table.runFastForward(10);
  assert.equal(env.node('game-container').dataset.fastforward, 'false');
});

test('Page: fast-forward rejects a bad hand count', () => {
  const env = makeEnvironment();
  env.table.spots.player.onclick();
  env.table.runFastForward(0);
  assert.match(env.node('message').textContent, /1 to 100,000/);
  env.table.runFastForward(100_001);
  assert.match(env.node('message').textContent, /1 to 100,000/);
  assert.equal(env.engine.bets.player, 500); // the bet is still there
});

test('Page: normal play is locked out during a fast-forward run', () => {
  const env = makeEnvironment();
  env.engine.balance = 100_000_000;
  env.table.spots.player.onclick();
  env.table.runFastForward(1000);
  assert.equal(env.table.placeBet('banker'), false);
  assert.equal(env.table.rebet(), false);
  assert.equal(env.node('bankroll-amount').disabled, true);
  assert.equal(env.table.spots.player.disabled, true);
  env.flushTimers();
});

test('Page: Stop halts a run between chunks', () => {
  const env = makeEnvironment();
  env.engine.balance = 1e12;
  env.table.spots.player.onclick();
  env.table.runFastForward(100_000);
  assert.equal(env.stepTimers(1), 1);
  const soFar = env.table.ff.handsRun;
  assert.ok(soFar > 0 && soFar < 100_000, `first chunk ran ${soFar}`);
  env.table.stopFastForward();
  env.flushTimers();
  assert.equal(env.getSession().handsPlayed, soFar);
  assert.match(env.node('fastforward-summary').children[0].textContent, /Stopped early/);
});

test('Page: a run stops when the money runs out', () => {
  const env = makeEnvironment();
  env.table.setBankroll(20);
  env.table.selectAmount(10);
  env.table.spots.tie.onclick(); // tie bets lose ~91% of the time
  env.table.runFastForward(100_000);
  env.flushTimers();
  assert.ok(env.engine.balance < 1_000);
  assert.match(env.node('fastforward-summary').children[0].textContent, /Ran out of money/);
});

test('Page: fast-forward records the biggest single hand, not the run total', () => {
  const env = makeEnvironment();
  env.engine.balance = 10_000_000;
  env.table.selectAmount(10);
  env.table.spots.player.onclick();
  env.table.runFastForward(300);
  env.flushTimers();
  assert.equal(env.getStats().biggestWin, 2_000); // a $10 Player win pays $20 back
  assert.ok(env.getSession().totalWon > 2_000);
});

test('Page: fuzz - 300 hands through the page keep balance and statistics in step', () => {
  const env = makeEnvironment();
  const { engine: e, table: t } = env;
  let adjust = 0;
  for (let round = 0; round < 300; round++) {
    if (e.balance < 5_000) { e.balance += 100_000; adjust += 100_000; }
    for (const spot of ['player', 'banker', 'tie']) {
      if (Math.random() < 0.5) {
        t.selectAmount([1, 5, 25][Math.floor(Math.random() * 3)]);
        t.spots[spot].onclick();
      }
    }
    if (e.totalWagered() === 0) t.spots.banker.onclick();
    t.deal();
    assert.equal(e.phase, 'results', `round ${round}`);
    assert.equal(e.balance, 100_000 + adjust - env.getSession().totalWagered + env.getSession().totalWon, `round ${round}`);
    Math.random() < 0.5 ? t.nextRound() : (t.rebet() || t.nextRound());
    if (e.phase === 'betting' && e.totalWagered() > 0) t.clearBets();
  }
});

const failures = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.length - failures.length, total: results.length, failures }, null, 2));
