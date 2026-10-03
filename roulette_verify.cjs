'use strict';

// Checks for Matt's Roulette. Run with:  node roulette_verify.cjs
//
// Part 1 tests the engine (roulette-engine.js) directly in plain Node, with no browser,
// including that every bet type's house edge matches the real, published 5.26% American
// roulette edge. Part 2 loads the engine and the page (roulette.js) into a mocked browser
// to check the page wiring.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const enginePath = path.join(dir, 'roulette-engine.js');
const scriptPath = path.join(dir, 'roulette.js');
const { RouletteEngine, colorOf, computeOddsTable, POCKETS, BET_TYPES } = require(enginePath);

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

// =====================================================================
// Part 1: the wheel and the odds
// =====================================================================

test('Engine: the wheel has 38 pockets - 0, 00, and 1-36, each exactly once', () => {
  assert.equal(POCKETS.length, 38);
  assert.equal(new Set(POCKETS).size, 38);
  assert.ok(POCKETS.includes('0'));
  assert.ok(POCKETS.includes('00'));
  for (let n = 1; n <= 36; n++) assert.ok(POCKETS.includes(String(n)), `missing ${n}`);
});

test('Engine: 18 red, 18 black, 2 green (0 and 00)', () => {
  const colors = POCKETS.map(colorOf);
  assert.equal(colors.filter(c => c === 'red').length, 18);
  assert.equal(colors.filter(c => c === 'black').length, 18);
  assert.equal(colors.filter(c => c === 'green').length, 2);
  assert.equal(colorOf('0'), 'green');
  assert.equal(colorOf('00'), 'green');
});

test('Engine: every offered bet type has exactly the real 5.26% American house edge', () => {
  const table = computeOddsTable();
  assert.equal(table.length, Object.keys(BET_TYPES).length);
  for (const tier of table) {
    assert.ok(Math.abs(tier.houseEdgePct - 5.2631578947) < 1e-9, `${tier.key}: ${tier.houseEdgePct}`);
  }
});

test('Engine: each bet type pays correctly: payout * probability of winning + loss * probability of losing = -5.26%', () => {
  // Re-derive the house edge independently of computeOddsTable, straight from the bet
  // menu's own `wins` predicates, as a cross-check that the table isn't just echoing
  // itself.
  for (const [key, def] of Object.entries(BET_TYPES)) {
    const winners = POCKETS.filter(p => def.wins(p, key === 'straight' ? '17' : null));
    const expectedOutcomes = key === 'straight' ? 1 : def.outcomes;
    assert.equal(winners.length, expectedOutcomes, `${key}: wrong winner count`);
    const p = winners.length / POCKETS.length;
    const ev = p * def.payout - (1 - p);
    assert.ok(Math.abs(ev + 2 / 38) < 1e-9, `${key}: ev ${ev}`);
  }
});

test('Engine: red and black partition the non-zero numbers with no overlap', () => {
  const reds = POCKETS.filter(p => colorOf(p) === 'red');
  const blacks = POCKETS.filter(p => colorOf(p) === 'black');
  assert.equal(new Set([...reds, ...blacks]).size, 36);
  reds.forEach(r => assert.ok(!blacks.includes(r)));
});

test('Engine: dozens and columns each partition 1-36 into three disjoint sets of 12', () => {
  const dozens = ['dozen1', 'dozen2', 'dozen3'].map(key => POCKETS.filter(p => BET_TYPES[key].wins(p)));
  const columns = ['column1', 'column2', 'column3'].map(key => POCKETS.filter(p => BET_TYPES[key].wins(p)));
  for (const group of [dozens, columns]) {
    group.forEach(set => assert.equal(set.length, 12));
    const all = group.flat();
    assert.equal(new Set(all).size, 36); // no overlaps
    assert.equal(all.every(n => n !== '0' && n !== '00'), true);
  }
});

// =====================================================================
// Part 2: placing bets and spinning
// =====================================================================

test('Engine: placing a bet deducts the stake immediately', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  const events = record(e);
  assert.equal(e.placeBet('red', null, 10).ok, true);
  assert.equal(e.balance, 90);
  assert.equal(e.bets.length, 1);
  assert.equal(events.find(ev => ev.type === 'betPlaced') !== undefined, true);
});

test('Engine: multiple simultaneous bets in one spin are all tracked', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  e.placeBet('red', null, 10);
  e.placeBet('straight', '17', 5);
  e.placeBet('dozen1', null, 8);
  assert.equal(e.bets.length, 3);
  assert.equal(e.balance, 100 - 10 - 5 - 8);
  assert.equal(e.totalWagered(), 23);
});

test('Engine: straight-up bets require a valid pocket selection', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  assert.equal(e.placeBet('straight', '37', 5).reason, 'invalid');
  assert.equal(e.placeBet('straight', 'red', 5).reason, 'invalid');
  assert.equal(e.placeBet('straight', '0', 5).ok, true);
  assert.equal(e.placeBet('straight', '00', 5).ok, true);
});

test('Engine: cannot bet an invalid amount, more than you have, or an unknown type', () => {
  const e = new RouletteEngine({ startingBalance: 10 });
  assert.equal(e.placeBet('red', null, 0).reason, 'invalid');
  assert.equal(e.placeBet('red', null, -5).reason, 'invalid');
  assert.equal(e.placeBet('red', null, 2.5).reason, 'invalid');
  assert.equal(e.placeBet('red', null, 20).reason, 'insufficient');
  assert.equal(e.placeBet('nonsense', null, 1).reason, 'invalid');
  assert.equal(e.placeBet('red', null, 10).ok, true);
});

test('Engine: betting is capped per spin, and refuses once locked', () => {
  const e = new RouletteEngine({ startingBalance: RouletteEngine.MAX_BETS_PER_SPIN + 50 });
  for (let i = 0; i < RouletteEngine.MAX_BETS_PER_SPIN; i++) {
    assert.equal(e.placeBet('red', null, 1).ok, true);
  }
  assert.equal(e.placeBet('red', null, 1).reason, 'toomany');
  e.spin();
  assert.equal(e.placeBet('red', null, 1).reason, 'locked');
});

test('Engine: clearing bets refunds them, but only before the spin', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  e.placeBet('red', null, 10);
  e.placeBet('straight', '7', 5);
  assert.equal(e.clearBets().ok, true);
  assert.equal(e.balance, 100);
  assert.equal(e.bets.length, 0);
  assert.equal(e.clearBets().reason, 'nothing');
  e.placeBet('red', null, 10);
  e.spin();
  assert.equal(e.clearBets().reason, 'nothing'); // wrong phase, not just empty
});

test('Engine: cannot spin with no bets placed, and spinning locks further bets', () => {
  const e = new RouletteEngine();
  assert.equal(e.spin().reason, 'nobets');
  e.placeBet('red', null, 10);
  e.spin();
  assert.equal(e.phase, 'results');
  assert.equal(e.spin().reason, 'locked');
});

test('Engine: red pays 1:1, and 0 loses every outside bet', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  e.placeBet('red', null, 10);
  const { spin } = e.spin('1'); // 1 is red
  assert.equal(spin.pocket, '1');
  assert.equal(spin.color, 'red');
  assert.equal(spin.results[0].won, true);
  assert.equal(spin.results[0].payout, 20); // stake back + 1:1 profit
  assert.equal(e.balance, 100 - 10 + 20);

  const e2 = new RouletteEngine({ startingBalance: 100 });
  ['red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'column1'].forEach(type => e2.placeBet(type, null, 1));
  const { spin: spin2 } = e2.spin('0');
  assert.equal(spin2.totalWon, 0); // 0 loses every outside bet
  assert.equal(e2.balance, 100 - 8);
});

test('Engine: straight-up pays 35:1 only on an exact match', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  e.placeBet('straight', '17', 10);
  const hit = e.spin('17');
  assert.equal(hit.spin.results[0].payout, 360); // stake back + 35:1 profit
  assert.equal(e.balance, 100 - 10 + 360);

  const e2 = new RouletteEngine({ startingBalance: 100 });
  e2.placeBet('straight', '17', 10);
  const miss = e2.spin('18');
  assert.equal(miss.spin.results[0].payout, 0);
  assert.equal(e2.balance, 90);
});

test('Engine: dozens and columns pay 2:1 on the right third', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  e.placeBet('dozen1', null, 10);
  e.placeBet('column2', null, 10);
  const { spin } = e.spin('5'); // in dozen1 (1-12) and column2 (2,5,8,...)
  assert.equal(spin.results[0].payout, 30); // dozen1: stake back + 2:1
  assert.equal(spin.results[1].payout, 30); // column2: stake back + 2:1
  assert.equal(e.balance, 100 - 20 + 60);
});

test('Engine: a single spin settles every placed bet independently', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  e.placeBet('red', null, 10);   // 17 is black -> loses
  e.placeBet('odd', null, 10);   // 17 is odd -> wins
  e.placeBet('straight', '17', 5); // exact match -> wins big
  const { spin } = e.spin('17');
  assert.deepEqual(spin.results.map(r => r.won), [false, true, true]);
  assert.equal(spin.totalWon, 0 + 20 + 180);
  assert.equal(e.balance, 100 - 25 + 200);
});

test('Engine: statistics track wagering and winnings across spins', () => {
  const e = new RouletteEngine({ startingBalance: 1000 });
  e.placeBet('red', null, 10);
  e.placeBet('black', null, 5);
  e.spin('1'); // red wins, black loses
  assert.equal(e.stats.spinsPlayed, 1);
  assert.equal(e.stats.betsPlaced, 2);
  assert.equal(e.stats.totalWagered, 15);
  assert.equal(e.stats.totalWon, 20);
  assert.equal(e.stats.biggestWin, 20);
  e.nextRound();
  e.placeBet('straight', '1', 2);
  e.spin('1');
  assert.equal(e.stats.spinsPlayed, 2);
  assert.equal(e.stats.biggestWin, 72); // 2 * 36
});

test('Engine: nextRound clears bets and returns to betting, only after a spin', () => {
  const e = new RouletteEngine();
  assert.equal(e.nextRound(), false);
  e.placeBet('red', null, 10);
  assert.equal(e.nextRound(), false); // still betting, no spin yet
  e.spin();
  assert.equal(e.nextRound(), true);
  assert.equal(e.phase, 'betting');
  assert.equal(e.bets.length, 0);
  assert.equal(e.lastSpin, null);
});

test('Engine: the player can set their own starting balance before betting', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  assert.equal(e.setBalance(5000).ok, true);
  assert.equal(e.balance, 5000);
  assert.equal(e.startingBalance, 5000);
  assert.equal(e.setBalance(1.5).reason, 'invalid');
  assert.equal(e.setBalance(-10).reason, 'invalid');
  e.placeBet('red', null, 1);
  assert.equal(e.setBalance(999).reason, 'locked');
});

test('Engine: isBroke stays false mid-spin-placement at $0, true once settled', () => {
  const e = new RouletteEngine({ startingBalance: 1 });
  e.placeBet('straight', '1', 1); // guaranteed loser vs the forced pocket below
  assert.equal(e.balance, 0);
  assert.equal(e.isBroke(), false); // a bet is placed and can still be spun
  e.spin('2');
  assert.equal(e.phase, 'results');
  assert.equal(e.isBroke(), true);
});

test('Engine: going broke offers a restart that preserves the chosen bankroll', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  e.setBalance(4);
  e.placeBet('straight', '1', 4);
  e.spin('2'); // guaranteed loss
  e.nextRound();
  assert.equal(e.balance, 0);
  assert.equal(e.isBroke(), true);
  assert.equal(e.restart(), true);
  assert.equal(e.balance, 4); // the chosen $4, not the original $100
  assert.equal(e.stats.spinsPlayed, 0);
});

test('Engine: restart refuses while you still have money', () => {
  const e = new RouletteEngine({ startingBalance: 100 });
  assert.equal(e.restart(), false);
});

test('Engine: a fixed rng makes a spin fully deterministic', () => {
  const values = [0.5];
  let i = 0;
  const rng = () => values[i++ % values.length];
  const e1 = new RouletteEngine({ rng });
  e1.placeBet('red', null, 1);
  const p1 = e1.spin().spin.pocket;
  const e2 = new RouletteEngine({ rng });
  e2.placeBet('red', null, 1);
  const p2 = e2.spin().spin.pocket;
  assert.equal(p1, p2);
});

test('Engine: fuzz - 4000 random spins with varied bets never create or lose money', () => {
  const e = new RouletteEngine({ startingBalance: 1000 });
  let adjust = 0;
  const types = Object.keys(BET_TYPES);
  for (let round = 0; round < 4000; round++) {
    if (e.balance < 20) { e.balance += 1000; adjust += 1000; }
    const numBets = 1 + Math.floor(Math.random() * 5);
    for (let i = 0; i < numBets && e.balance >= 1; i++) {
      const type = types[Math.floor(Math.random() * types.length)];
      const selection = type === 'straight' ? POCKETS[Math.floor(Math.random() * POCKETS.length)] : null;
      const amount = 1 + Math.floor(Math.random() * Math.min(5, e.balance));
      e.placeBet(type, selection, amount);
    }
    if (e.bets.length === 0) { e.placeBet('red', null, 1); }
    const result = e.spin();
    assert.equal(result.ok, true, `round ${round}`);
    assert.ok(Number.isInteger(e.balance), `non-integer balance at round ${round}`);
    assert.equal(e.balance, 1000 + adjust - e.stats.totalWagered + e.stats.totalWon, `round ${round}: money accounting is wrong`);
    e.nextRound();
  }
});

// =====================================================================
// Part 3: the page (roulette.js) in a mocked browser
// =====================================================================

function makeEnvironment(savedStats = null, { storageThrows = false, presets = {} } = {}) {
  // A minimal DOM: enough tree operations for the page's keyed rendering, so tests can
  // check which elements are kept, replaced or removed. Mirrors the one used for the
  // blackjack and lottery projects' own page tests.
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
      this.tabIndex = 0;
      this._listeners = {};
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
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    querySelector() { return new Element(); }
    querySelectorAll() { return []; }
    cloneNode() { return new Element(); }
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 100 }; }
    animate() { return {}; }
  }
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, new Element());
    return nodes.get(key);
  }
  // querySelectorAll('.bet-spot') and the type/selection-specific variants used by
  // spotsFor() need to actually find the spots built onto the real grid containers, so
  // route those through the three containers that hold them.
  const betSpotContainers = ['zero-row', 'numbers-grid', 'outside-bets'].map(node);
  function allBetSpots() {
    return betSpotContainers.flatMap(c => c.children);
  }
  const storage = new Map();
  if (savedStats) storage.set('rouletteStats', typeof savedStats === 'string' ? savedStats : JSON.stringify(savedStats));
  for (const [key, value] of Object.entries(presets)) storage.set(key, value);
  const playLog = [];
  const bodyEl = node('body');
  let now = 0;
  let timerId = 0;
  const timers = [];
  const context = vm.createContext({
    console,
    Audio: class { constructor(src) { this.src = src; } play() { playLog.push(this.src); return Promise.resolve(); } },
    document: {
      body: bodyEl,
      getElementById: id => node(id),
      createElement: () => new Element(),
      querySelector: () => new Element(),
      querySelectorAll: selector => {
        if (selector === '.bet-spot') return allBetSpots();
        const m = selector.match(/^\.bet-spot\[data-type="([^"]+)"\](?::not\(\[data-selection\]\)|\[data-selection="([^"]+)"\])$/);
        if (m) {
          const [, type, selection] = m;
          return allBetSpots().filter(spot => spot.dataset.type === type && (selection === undefined ? spot.dataset.selection === undefined : spot.dataset.selection === selection));
        }
        return [];
      },
      addEventListener() {}
    },
    localStorage: {
      getItem: key => { if (storageThrows) throw new Error('storage blocked'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (storageThrows) throw new Error('storage blocked'); storage.set(key, String(value)); }
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
  vm.runInContext(source + '\n;globalThis.pageExports = { engine, table, getStats: () => ({...gameStats}), getSession: () => ({...sessionStats}), toggleMute, isMuted: () => soundMuted };', context, { filename: 'roulette-engine.js+roulette.js' });
  return { ...context.pageExports, node, body: bodyEl, allBetSpots, flushTimers, stepTimers, playLog, storage };
}

function spot(env, type, selection) {
  return env.allBetSpots().find(s => s.dataset.type === type && (selection === undefined ? s.dataset.selection === undefined : s.dataset.selection === String(selection)));
}

function forcedSpin(env, pocket) {
  return env.engine.spin(pocket);
}

test('Page: the table has 38 bet spots for straight numbers plus 12 outside bets', () => {
  const env = makeEnvironment();
  const straights = env.allBetSpots().filter(s => s.dataset.type === 'straight');
  assert.equal(straights.length, 38);
  const outside = env.allBetSpots().filter(s => s.dataset.type !== 'straight');
  assert.equal(outside.length, 12);
});

test('Page: clicking a chip selects it, and clicking a bet spot places that amount', () => {
  const env = makeEnvironment();
  env.table.selectAmount(10);
  assert.equal(env.table.selectedAmount, 10);
  spot(env, 'red').onclick();
  assert.equal(env.engine.bets.length, 1);
  // not assert.deepEqual: the bet object was created inside the vm context (a
  // different realm), so its prototype differs from a plain object literal here even
  // with identical fields - compare the fields directly instead.
  assert.equal(env.engine.bets[0].type, 'red');
  assert.equal(env.engine.bets[0].selection, null);
  assert.equal(env.engine.bets[0].amount, 10);
  assert.equal(env.engine.balance, RouletteEngine.STARTING_BALANCE - 10);
});

test('Page: a straight-up bet spot carries its own number as the selection', () => {
  const env = makeEnvironment();
  spot(env, 'straight', '17').onclick();
  assert.equal(env.engine.bets[0].type, 'straight');
  assert.equal(env.engine.bets[0].selection, '17');
  const zero = spot(env, 'straight', '0');
  zero.onclick();
  assert.equal(env.engine.bets[1].selection, '0');
});

test('Page: bet spot badges show the cumulative amount wagered on that exact spot', () => {
  const env = makeEnvironment();
  env.table.selectAmount(5);
  spot(env, 'red').onclick();
  spot(env, 'red').onclick();
  assert.equal(spot(env, 'red').parts.badge.textContent, '$10');
  assert.equal(spot(env, 'black').parts.badge.textContent, '');
  assert.equal(spot(env, 'red').classList.contains('has-bet'), true);
});

test('Page: Clear Bets refunds everything and clears the badges', () => {
  const env = makeEnvironment();
  spot(env, 'red').onclick();
  spot(env, 'straight', '7').onclick();
  const before = env.engine.balance;
  env.table.clearBets();
  assert.equal(env.engine.balance, RouletteEngine.STARTING_BALANCE);
  assert.equal(env.engine.bets.length, 0);
  assert.equal(spot(env, 'red').parts.badge.textContent, '');
  void before;
});

test('Page: spinning settles every placed bet and renders the result ball', () => {
  const env = makeEnvironment();
  spot(env, 'red').onclick();   // 17 is black -> loses
  spot(env, 'odd').onclick();   // 17 is odd -> wins
  forcedSpin(env, '17');
  env.table.updateUI();
  assert.equal(env.node('game-container').dataset.phase, 'results');
  const ball = env.node('result-pocket').children[0];
  assert.equal(ball.textContent, '17');
  assert.equal(ball.classList.contains('black'), true);
  assert.equal(spot(env, 'red').classList.contains('bet-lost'), true);
  assert.equal(spot(env, 'odd').classList.contains('bet-won'), true);
});

test('Page: Play Again clears the table for the next spin', () => {
  const env = makeEnvironment();
  spot(env, 'red').onclick();
  forcedSpin(env, '1');
  env.table.updateUI();
  env.table.nextRound();
  assert.equal(env.node('game-container').dataset.phase, 'betting');
  assert.equal(env.node('result-pocket').children.length, 0);
  assert.equal(spot(env, 'red').parts.badge.textContent, '');
});

test('Page: setting the starting balance updates the balance and the restart amount', () => {
  const env = makeEnvironment();
  assert.equal(env.table.setBankroll(5000), true);
  assert.equal(env.engine.balance, 5000);
  assert.match(env.node('balance').textContent, /\$5,000/);
  spot(env, 'red').onclick();
  assert.equal(env.table.setBankroll(100), false);
  assert.match(env.node('message').textContent, /before placing bets/);
});

test('Page: going broke shows New Game, which restores the chosen bankroll', () => {
  const env = makeEnvironment();
  env.table.setBankroll(4);
  env.table.selectAmount(4);
  spot(env, 'straight', '1').onclick();
  forcedSpin(env, '2'); // guaranteed loss
  env.table.updateUI();
  assert.equal(env.engine.balance, 0);
  assert.equal(env.node('restart').style.display, 'inline-block');
  env.table.restart();
  assert.equal(env.engine.balance, 4);
  assert.equal(env.node('restart').style.display, 'none');
});

test('Page: statistics track wagering and winnings', () => {
  const env = makeEnvironment({ spinsPlayed: 2, betsPlaced: 2, totalWagered: 20, totalWon: 15, biggestWin: 10 });
  assert.equal(env.getSession().spinsPlayed, 0);
  assert.equal(env.getStats().spinsPlayed, 2);
  spot(env, 'red').onclick();
  forcedSpin(env, '1');
  env.table.updateUI();
  assert.equal(env.getSession().spinsPlayed, 1);
  assert.equal(env.getStats().spinsPlayed, 3);
  assert.match(env.node('stats').textContent, /Session: .*Lifetime: /);
});

test('Page: mute silences sounds and is remembered across a reload', () => {
  const env = makeEnvironment();
  env.toggleMute();
  assert.equal(env.isMuted(), true);
  assert.equal(env.storage.get('rouletteMuted'), '1');
  spot(env, 'red').onclick();
  assert.equal(env.playLog.length, 0);
  const restored = makeEnvironment(null, { presets: { rouletteMuted: '1' } });
  assert.equal(restored.isMuted(), true);
  assert.equal(restored.node('mute').textContent, 'Sound: Off');
});

test('Page: the paytable lists every bet with its real odds and the uniform house edge', () => {
  const env = makeEnvironment();
  assert.equal(env.node('paytable').hidden, true);
  env.table.togglePaytable();
  assert.equal(env.node('paytable').hidden, false);
  const rows = env.node('paytable-body').children;
  assert.equal(rows.length, Object.keys(RouletteEngine.BET_TYPES).length);
  rows.forEach(row => assert.equal(row.parts[3].textContent, '5.26%'));
});

test('Page: corrupt saved stats fall back to a fresh start', () => {
  for (const bad of ['{not json', '[]', 'null', '{"spinsPlayed":"x"}']) {
    const env = makeEnvironment(bad);
    assert.equal(env.getStats().spinsPlayed, 0, bad);
  }
});

test('Page: the game works when localStorage is blocked', () => {
  const env = makeEnvironment(null, { storageThrows: true });
  spot(env, 'red').onclick(); // default chip amount is $5; pocket 1 is red, pays 1:1
  forcedSpin(env, '1');
  env.table.updateUI();
  assert.equal(env.engine.balance, RouletteEngine.STARTING_BALANCE - 5 + 10);
  env.toggleMute();
  assert.equal(env.isMuted(), true);
});

// ---- Fast-forward ----

test('Page: fast-forward replays the currently placed bets as a repeating pattern', () => {
  const env = makeEnvironment();
  env.engine.balance = 1_000_000;
  env.table.selectAmount(3);
  spot(env, 'red').onclick();
  spot(env, 'straight', '7').onclick();
  assert.equal(env.table.canFastForward(), true);
  env.table.runFastForward(50);
  assert.equal(env.node('game-container').dataset.fastforward, 'true');
  assert.equal(env.node('fast-forward-button').disabled, true);
  env.flushTimers();
  assert.equal(env.node('game-container').dataset.fastforward, 'false');
  assert.equal(env.engine.phase, 'betting');
  assert.equal(env.engine.bets.length, 0);
  assert.equal(env.getSession().spinsPlayed, 50);
  assert.equal(env.getSession().betsPlaced, 100);
  assert.equal(env.getSession().totalWagered, 300);
  const net = env.getSession().totalWon - 300;
  assert.equal(env.engine.balance, 1_000_000 + net);
  assert.equal(env.node('fastforward-summary').hidden, false);
  assert.match(env.node('fastforward-summary').children[0].textContent, /Simulation complete/);
  assert.match(env.node('fastforward-summary').children[1].innerHTML, /Spins run: 50/);
});

test('Page: fast-forward requires a bet pattern to replay first', () => {
  const env = makeEnvironment();
  assert.equal(env.table.canFastForward(), false);
  env.table.runFastForward(50);
  assert.equal(env.node('game-container').dataset.fastforward, 'false');
});

test('Page: normal betting and spinning are disabled while fast-forwarding', () => {
  const env = makeEnvironment();
  env.engine.balance = 1_000_000;
  spot(env, 'red').onclick();
  env.table.runFastForward(1000);
  assert.equal(env.table.placeBet('black', null), false);
  assert.equal(env.node('custom-amount').disabled, true);
  assert.equal(env.node('bankroll-amount').disabled, true);
  env.flushTimers();
});

test('Page: stopping immediately runs zero spins and reports it', () => {
  const env = makeEnvironment();
  env.engine.balance = 1_000_000;
  spot(env, 'red').onclick();
  env.table.runFastForward(1000);
  env.table.stopFastForward();
  env.flushTimers();
  assert.equal(env.getSession().spinsPlayed, 0);
  assert.match(env.node('fastforward-summary').children[0].textContent, /Stopped early/);
});

test('Page: stopping between chunks halts the run partway through', () => {
  const env = makeEnvironment();
  env.engine.balance = 100_000_000;
  spot(env, 'red').onclick();
  env.table.runFastForward(100_000);
  const ranOneChunk = env.stepTimers(1);
  assert.equal(ranOneChunk, 1);
  assert.equal(env.node('game-container').dataset.fastforward, 'true');
  const spinsSoFar = env.table.ff.spinsRun;
  assert.ok(spinsSoFar > 0, 'expected at least one spin in the first chunk');
  assert.ok(spinsSoFar < 100_000, 'expected the first chunk not to finish the whole run');

  env.table.stopFastForward();
  env.flushTimers();
  assert.equal(env.node('game-container').dataset.fastforward, 'false');
  assert.equal(env.getSession().spinsPlayed, spinsSoFar);
});

test('Page: running out of money stops the simulation and reports why', () => {
  const env = makeEnvironment();
  spot(env, 'red').onclick();
  let callsLeft = 4;
  env.engine.placeBet = (() => {
    const real = env.engine.placeBet.bind(env.engine);
    return (type, selection, amount) => (callsLeft-- > 0 ? real(type, selection, amount) : { ok: false, reason: 'insufficient' });
  })();
  env.table.runFastForward(1000);
  env.flushTimers();
  assert.equal(env.getSession().spinsPlayed, 4);
  assert.match(env.node('fastforward-summary').children[0].textContent, /Ran out of money/);
});

test('Page: fast-forward records the biggest SINGLE spin win, not the sum across the run', () => {
  const env = makeEnvironment();
  env.engine.rng = () => 0; // deterministic: same pocket drawn every spin
  const pocket = env.engine.drawPocket();
  env.table.selectAmount(10);
  spot(env, 'straight', pocket).onclick(); // guaranteed to hit every single spin
  env.table.runFastForward(3);
  env.flushTimers();
  const perSpinWin = 10 * 36; // stake back + 35:1
  assert.equal(env.getSession().totalWon, perSpinWin * 3);
  assert.equal(env.getStats().biggestWin, perSpinWin); // not the sum
});

test('Page: fuzz - 300 random rounds keep the page and the engine in agreement', () => {
  const env = makeEnvironment();
  const { engine: e, table: t } = env;
  let adjust = 0;
  const types = Object.keys(RouletteEngine.BET_TYPES);
  for (let round = 0; round < 300; round++) {
    if (e.balance < 20) { e.balance += 500; adjust += 500; }
    const numBets = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < numBets; i++) {
      const type = types[Math.floor(Math.random() * types.length)];
      if (type === 'straight') {
        const pocket = RouletteEngine.POCKETS[Math.floor(Math.random() * RouletteEngine.POCKETS.length)];
        t.selectAmount(1);
        spot(env, 'straight', pocket).onclick();
      } else {
        t.selectAmount(1);
        spot(env, type).onclick();
      }
    }
    if (e.bets.length === 0) spot(env, 'red').onclick();
    t.spin();
    assert.equal(e.phase, 'results', `round ${round}`);
    const expectedBalance = 500 + adjust - e.stats.totalWagered + e.stats.totalWon;
    assert.equal(e.balance, expectedBalance, `round ${round}: balance vs stats disagree`);
    t.nextRound();
  }
});

const failures = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.length - failures.length, total: results.length, failures }, null, 2));
