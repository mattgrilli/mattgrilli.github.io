'use strict';

// Checks for Matt's Roulette. Run with:  node roulette_verify.cjs
//
// Part 1 tests the wheel and the bet catalogue: every one of the 158 bets on the table
// covers the right numbers, and its house edge matches the real American-roulette figure
// (5.26%, or 7.89% for the basket), computed two independent ways. Part 2 tests the engine
// (roulette-engine.js) in plain Node. Part 3 loads the engine and the page (roulette.js)
// into a mocked browser to check the table layout and the page wiring.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const enginePath = path.join(dir, 'roulette-engine.js');
const scriptPath = path.join(dir, 'roulette.js');
const { RouletteEngine, colorOf, computeOddsTable, houseEdgePct, POCKETS, WHEEL_ORDER, BETS, BET_LIST } = require(enginePath);

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

// A small seeded generator, so the statistical checks give the same answer every run.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Where a number sits on the real table, worked out independently of the engine:
// column 1-12 along the table, row 0 (1, 4 ... 34) to row 2 (3, 6 ... 36) across it.
const at = n => ({ col: Math.ceil(n / 3), row: (n - 1) % 3 });

// =====================================================================
// Part 1: the wheel and the bets
// =====================================================================

test('Wheel: 38 pockets - 0, 00 and 1-36, each exactly once', () => {
  assert.equal(POCKETS.length, 38);
  assert.equal(new Set(POCKETS).size, 38);
  assert.ok(POCKETS.includes('0') && POCKETS.includes('00'));
  for (let n = 1; n <= 36; n++) assert.ok(POCKETS.includes(String(n)), `missing ${n}`);
});

test('Wheel: 18 red, 18 black, 2 green, with the real red numbers', () => {
  const count = c => POCKETS.filter(p => colorOf(p) === c).length;
  assert.equal(count('red'), 18);
  assert.equal(count('black'), 18);
  assert.deepEqual(POCKETS.filter(p => colorOf(p) === 'green'), ['0', '00']);
  for (const n of [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]) assert.equal(colorOf(String(n)), 'red');
});

test('Wheel: the real American order - every pocket once, colours alternate, 0 opposite 00', () => {
  assert.equal(WHEEL_ORDER.length, 38);
  assert.deepEqual([...WHEEL_ORDER].sort(), [...POCKETS].sort());
  assert.equal(WHEEL_ORDER.indexOf('00') - WHEEL_ORDER.indexOf('0'), 19);
  for (let i = 0; i < 38; i++) {
    const a = colorOf(WHEEL_ORDER[i]);
    const b = colorOf(WHEEL_ORDER[(i + 1) % 38]);
    if (a !== 'green' && b !== 'green') assert.notEqual(a, b, `${WHEEL_ORDER[i]} next to ${WHEEL_ORDER[(i + 1) % 38]}`);
  }
  // Spot checks against the real wheel: 0 sits between 2 and 28, 00 between 1 and 27.
  assert.deepEqual([WHEEL_ORDER[37], WHEEL_ORDER[1]], ['2', '28']);
  assert.deepEqual([WHEEL_ORDER[18], WHEEL_ORDER[20]], ['1', '27']);
});

test('Bets: 158 bets with unique keys - every bet a real table offers', () => {
  assert.equal(BET_LIST.length, 158);
  assert.equal(BETS.size, 158);
  const byKind = {};
  for (const bet of BET_LIST) byKind[bet.kind] = (byKind[bet.kind] || 0) + 1;
  assert.deepEqual(byKind, { straight: 38, split: 60, street: 12, trio: 2, corner: 22, sixline: 11, basket: 1, dozen: 3, column: 3, evenmoney: 6 });
});

test('Bets: every split, corner, street and six line covers numbers that really touch', () => {
  for (const bet of BET_LIST) {
    const nums = bet.numbers.map(Number);
    if (bet.numbers.some(p => p === '0' || p === '00')) continue;
    const cells = nums.map(at);
    const cols = new Set(cells.map(c => c.col));
    const rows = new Set(cells.map(c => c.row));
    if (bet.kind === 'split') {
      const [a, b] = cells;
      assert.equal(Math.abs(a.col - b.col) + Math.abs(a.row - b.row), 1, bet.key);
    } else if (bet.kind === 'corner') {
      assert.equal(cols.size, 2, bet.key); assert.equal(rows.size, 2, bet.key);
      assert.equal(Math.max(...cols) - Math.min(...cols), 1, bet.key);
      assert.equal(Math.max(...rows) - Math.min(...rows), 1, bet.key);
    } else if (bet.kind === 'street') {
      assert.equal(cols.size, 1, bet.key); assert.equal(rows.size, 3, bet.key);
    } else if (bet.kind === 'sixline') {
      assert.equal(cols.size, 2, bet.key); assert.equal(rows.size, 3, bet.key);
      assert.equal(Math.max(...cols) - Math.min(...cols), 1, bet.key);
    }
  }
  // Every adjacent pair on the grid is offered as a split, and every 2x2 block as a corner.
  const splits = BET_LIST.filter(b => b.kind === 'split' && !b.numbers.includes('0') && !b.numbers.includes('00'));
  assert.equal(splits.length, 12 * 2 + 11 * 3); // 24 within columns, 33 across
  assert.equal(BET_LIST.filter(b => b.kind === 'corner').length, 11 * 2);
});

test('Bets: the zero bets cover the right numbers', () => {
  const nums = key => BETS.get(key).numbers.join(',');
  assert.equal(nums('split:0-00'), '0,00');
  assert.equal(nums('split:0-1'), '0,1');
  assert.equal(nums('split:00-3'), '00,3');
  assert.equal(nums('trio:0-1-2'), '0,1,2');
  assert.equal(nums('trio:00-2-3'), '00,2,3');
  assert.equal(nums('basket'), '0,00,1,2,3');
});

test('Bets: outside bets cover the right 12 or 18 numbers, and never 0 or 00', () => {
  const nums = key => BETS.get(key).numbers.map(Number);
  assert.deepEqual(nums('dozen2'), Array.from({ length: 12 }, (_, i) => 13 + i));
  assert.deepEqual(nums('column1'), Array.from({ length: 12 }, (_, i) => 1 + 3 * i));
  assert.deepEqual(nums('column3'), Array.from({ length: 12 }, (_, i) => 3 + 3 * i));
  assert.ok(nums('even').every(n => n % 2 === 0) && nums('even').length === 18);
  assert.ok(nums('high').every(n => n >= 19) && nums('high').length === 18);
  for (const key of ['dozen1', 'dozen2', 'dozen3', 'column1', 'column2', 'column3', 'red', 'black', 'odd', 'even', 'low', 'high']) {
    assert.ok(!BETS.get(key).numbers.includes('0') && !BETS.get(key).numbers.includes('00'), key);
  }
});

test('Odds: every bet costs exactly 2/38 (5.26%) except the basket at 3/38 (7.89%) - two ways', () => {
  for (const bet of BET_LIST) {
    // Way 1: the engine's formula. Way 2: average the actual payback over all 38 pockets.
    let payback = 0;
    for (const pocket of POCKETS) payback += bet.numbers.includes(pocket) ? bet.payout + 1 : 0;
    const enumerated = (1 - payback / 38) * 100;
    const expected = bet.key === 'basket' ? 300 / 38 : 200 / 38;
    assert.ok(Math.abs(houseEdgePct(bet) - expected) < 1e-9, `${bet.key}: formula ${houseEdgePct(bet)}`);
    assert.ok(Math.abs(enumerated - expected) < 1e-9, `${bet.key}: enumerated ${enumerated}`);
  }
});

test('Odds: the paytable lists each kind of bet with its real payout, chance and edge', () => {
  const rows = computeOddsTable();
  assert.deepEqual(rows.map(r => r.payout), [35, 17, 11, 8, 6, 5, 2, 1]);
  assert.deepEqual(rows.map(r => Math.round(r.winProbability * 38)), [1, 2, 3, 4, 5, 6, 12, 18]);
  assert.equal(rows.filter(r => r.houseEdgePct > 6).map(r => r.key).join(), 'basket');
});

test('Odds: a seeded 380,000-spin run hits every pocket about equally', () => {
  const engine = new RouletteEngine({ rng: mulberry32(12345) });
  const counts = new Map(POCKETS.map(p => [p, 0]));
  for (let i = 0; i < 380_000; i++) {
    const pocket = engine.drawPocket();
    counts.set(pocket, counts.get(pocket) + 1);
  }
  for (const [pocket, n] of counts) assert.ok(Math.abs(n - 10_000) < 500, `${pocket} drawn ${n} times`);
});

// =====================================================================
// Part 2: the engine
// =====================================================================

test('Engine: placing chips takes them from the balance and stacks them per spot', () => {
  const engine = new RouletteEngine();
  const events = record(engine);
  assert.equal(engine.placeBet('straight:17', 5).ok, true);
  assert.equal(engine.placeBet('straight:17', 25).ok, true);
  assert.equal(engine.placeBet('red', 10).ok, true);
  assert.deepEqual({ ...engine.bets }, { 'straight:17': 30, red: 10 });
  assert.equal(engine.balance, 460);
  assert.equal(engine.totalWagered(), 40);
  assert.equal(events.filter(e => e.type === 'betPlaced').length, 3);
});

test('Engine: unknown spots, bad amounts and chips you can\'t afford are refused', () => {
  const engine = new RouletteEngine({ startingBalance: 10 });
  assert.deepEqual(engine.placeBet('straight:37', 1), { ok: false, reason: 'invalid' });
  assert.deepEqual(engine.placeBet('split:1-5', 1), { ok: false, reason: 'invalid' });
  assert.deepEqual(engine.placeBet('red', 0), { ok: false, reason: 'invalid' });
  assert.deepEqual(engine.placeBet('red', 2.5), { ok: false, reason: 'invalid' });
  assert.deepEqual(engine.placeBet('red', 11), { ok: false, reason: 'insufficient' });
  assert.equal(engine.balance, 10);
  assert.deepEqual({ ...engine.bets }, {});
});

test('Engine: Undo takes back chips one at a time, most recent first', () => {
  const engine = new RouletteEngine();
  engine.placeBet('red', 5);
  engine.placeBet('straight:7', 1);
  engine.placeBet('red', 25);
  engine.undo();
  assert.deepEqual({ ...engine.bets }, { red: 5, 'straight:7': 1 });
  engine.undo();
  assert.deepEqual({ ...engine.bets }, { red: 5 });
  engine.undo();
  assert.deepEqual({ ...engine.bets }, {});
  assert.equal(engine.balance, 500);
  assert.equal(engine.undo().ok, false);
});

test('Engine: taking back one spot leaves the others, and Undo skips the removed chips', () => {
  const engine = new RouletteEngine();
  engine.placeBet('red', 5);
  engine.placeBet('black', 1);
  engine.placeBet('red', 5);
  assert.equal(engine.removeBet('red').ok, true);
  assert.deepEqual({ ...engine.bets }, { black: 1 });
  assert.equal(engine.balance, 499);
  engine.undo();
  assert.deepEqual({ ...engine.bets }, {});
  assert.equal(engine.removeBet('red').ok, false);
});

test('Engine: Clear refunds the whole table', () => {
  const engine = new RouletteEngine();
  engine.placeBet('red', 5);
  engine.placeBet('corner:1-2-4-5', 20);
  const events = record(engine);
  assert.equal(engine.clearBets().ok, true);
  assert.equal(engine.balance, 500);
  assert.equal(engine.placements.length, 0);
  assert.equal(events[0].refund, 25);
  assert.equal(engine.clearBets().ok, false);
});

test('Engine: Double adds the same again to every spot, only if affordable', () => {
  const engine = new RouletteEngine({ startingBalance: 100 });
  engine.placeBet('red', 10);
  engine.placeBet('straight:00', 20);
  assert.equal(engine.doubleBets().ok, true);
  assert.deepEqual({ ...engine.bets }, { red: 20, 'straight:00': 40 });
  assert.equal(engine.balance, 40);
  assert.equal(engine.canDouble(), false); // would need another $60
  assert.equal(engine.doubleBets().ok, false);
  assert.equal(engine.balance, 40);
});

test('Engine: a spin pays each winning bet its odds plus the stake, and keeps losing stakes', () => {
  const engine = new RouletteEngine();
  engine.placeBet('straight:17', 10);   // 35:1 -> 360 back
  engine.placeBet('split:17-20', 10);   // 17:1 -> 180
  engine.placeBet('corner:13-14-16-17', 10); // 8:1 -> 90
  engine.placeBet('street:16-17-18', 10); // 11:1 -> 120
  engine.placeBet('sixline:13-14-15-16-17-18', 10); // 5:1 -> 60
  engine.placeBet('dozen2', 10);        // 2:1 -> 30
  engine.placeBet('column2', 10);       // 2:1 -> 30
  engine.placeBet('black', 10);         // 1:1 -> 20
  engine.placeBet('odd', 10);           // 1:1 -> 20
  engine.placeBet('low', 10);           // 1:1 -> 20
  engine.placeBet('red', 10);           // loses
  engine.placeBet('straight:0', 10);    // loses
  const { spin } = engine.spin('17');
  assert.equal(spin.pocket, '17');
  assert.equal(spin.color, 'black');
  assert.equal(spin.wagered, 120);
  assert.equal(spin.totalWon, 360 + 180 + 90 + 120 + 60 + 30 + 30 + 20 + 20 + 20);
  assert.equal(engine.balance, 500 - 120 + spin.totalWon);
  assert.deepEqual(spin.results.filter(r => !r.won).map(r => r.key).sort(), ['red', 'straight:0']);
});

test('Engine: every bet wins on exactly its own numbers and pays its own odds', () => {
  for (const bet of BET_LIST) {
    for (const pocket of POCKETS) {
      const engine = new RouletteEngine();
      engine.placeBet(bet.key, 2);
      const { spin } = engine.spin(pocket);
      const wins = bet.numbers.includes(pocket);
      assert.equal(spin.results[0].won, wins, `${bet.key} on ${pocket}`);
      assert.equal(spin.totalWon, wins ? 2 * (bet.payout + 1) : 0, `${bet.key} on ${pocket}`);
    }
  }
});

test('Engine: 0 and 00 lose every outside bet', () => {
  for (const pocket of ['0', '00']) {
    const engine = new RouletteEngine();
    for (const key of ['red', 'black', 'odd', 'even', 'low', 'high', 'dozen1', 'dozen2', 'dozen3', 'column1', 'column2', 'column3']) engine.placeBet(key, 1);
    assert.equal(engine.spin(pocket).spin.totalWon, 0);
  }
});

test('Engine: no spin without a bet, no betting or second spin once the ball has landed', () => {
  const engine = new RouletteEngine();
  assert.deepEqual(engine.spin(), { ok: false, reason: 'nobets' });
  engine.placeBet('red', 5);
  engine.spin('1');
  assert.equal(engine.phase, 'results');
  assert.deepEqual(engine.spin(), { ok: false, reason: 'locked' });
  assert.deepEqual(engine.placeBet('red', 5), { ok: false, reason: 'locked' });
  assert.equal(engine.undo().ok, false);
  assert.equal(engine.nextRound(), true);
  assert.equal(engine.phase, 'betting');
  assert.deepEqual({ ...engine.bets }, {});
  assert.equal(engine.nextRound(), false);
});

test('Engine: Rebet puts last spin\'s bets back - only on an empty table you can afford', () => {
  const engine = new RouletteEngine({ startingBalance: 30 });
  engine.placeBet('red', 10);
  engine.placeBet('split:0-00', 5);
  engine.spin('0'); // red loses, split pays 18 * 5 = 90 -> balance 30 - 15 + 90 = 105
  engine.nextRound();
  assert.equal(engine.canRebet(), true);
  engine.rebet();
  assert.deepEqual({ ...engine.bets }, { red: 10, 'split:0-00': 5 });
  assert.equal(engine.canRebet(), false); // table no longer empty
  engine.clearBets();
  engine.balance = 14;
  assert.equal(engine.canRebet(), false);
  assert.equal(engine.rebet().ok, false);
});

test('Engine: history keeps the last 20 results, oldest first', () => {
  const engine = new RouletteEngine({ startingBalance: 1000 });
  for (let i = 0; i < 25; i++) {
    engine.placeBet('red', 1);
    engine.spin(POCKETS[i % 38]);
    engine.nextRound();
  }
  assert.equal(engine.history.length, 20);
  assert.deepEqual(engine.history, POCKETS.slice(5, 25));
});

test('Engine: stats count spins, bets, money in and out, and the biggest single win', () => {
  const engine = new RouletteEngine();
  engine.placeBet('straight:5', 2);
  engine.placeBet('red', 3);
  engine.spin('5'); // 72 + 6
  engine.nextRound();
  engine.placeBet('black', 4);
  engine.spin('1');
  assert.deepEqual({ ...engine.stats }, { spinsPlayed: 2, betsPlaced: 3, totalWagered: 9, totalWon: 78, biggestWin: 78 });
});

test('Engine: the starting balance can only be set before any chips are down', () => {
  const engine = new RouletteEngine();
  assert.equal(engine.setBalance(2000).ok, true);
  assert.equal(engine.balance, 2000);
  assert.equal(engine.setBalance(0).reason, 'invalid');
  assert.equal(engine.setBalance(12.5).reason, 'invalid');
  engine.placeBet('red', 1);
  assert.equal(engine.setBalance(50).reason, 'locked');
});

test('Engine: broke means a new game at the starting balance', () => {
  const engine = new RouletteEngine({ startingBalance: 5 });
  assert.equal(engine.restart(), false);
  engine.placeBet('red', 5);
  assert.equal(engine.isBroke(), false); // money still on the table
  engine.spin('2'); // black
  assert.equal(engine.isBroke(), true);
  assert.equal(engine.restart(), true);
  assert.equal(engine.balance, 5);
  assert.equal(engine.phase, 'betting');
  assert.deepEqual(engine.history, []);
  assert.equal(engine.canRebet(), false);
});

test('Engine: fuzz - 3,000 random actions never create or lose a dollar', () => {
  const rng = mulberry32(99);
  const engine = new RouletteEngine({ startingBalance: 2000, rng });
  const keys = [...BETS.keys()];
  // Money is conserved: what's in hand plus what's on the table equals the starting
  // balance less everything wagered plus everything paid back. A restart (after going
  // broke) resets the stats, so it resets the baseline too.
  for (let i = 0; i < 3000; i++) {
    const r = rng();
    if (engine.phase === 'results') engine.nextRound();
    else if (r < 0.5) engine.placeBet(keys[Math.floor(rng() * keys.length)], 1 + Math.floor(rng() * 20));
    else if (r < 0.6) engine.undo();
    else if (r < 0.65) engine.removeBet(keys[Math.floor(rng() * keys.length)]);
    else if (r < 0.7) engine.doubleBets();
    else if (r < 0.75) engine.rebet();
    else if (r < 0.78) engine.clearBets();
    else engine.spin();
    const onTable = engine.phase === 'betting' ? engine.totalWagered() : 0;
    assert.equal(engine.balance + onTable, 2000 - engine.stats.totalWagered + engine.stats.totalWon, `step ${i}`);
    assert.ok(engine.balance >= 0);
    assert.equal(engine.placements.reduce((s, p) => s + p.amount, 0), engine.totalWagered(), `step ${i}: placements`);
    if (engine.isBroke()) assert.ok(engine.restart(), 'broke but could not restart');
  }
});

// =====================================================================
// Part 3: the page (roulette.js) in a mocked browser
// =====================================================================

function makeEnvironment(savedStats = null, { storageThrows = false, presets = {}, audioContext = null } = {}) {
  // A minimal DOM: enough tree operations for the page's keyed rendering.
  class Element {
    constructor(tagName = 'DIV') {
      this.tagName = String(tagName).toUpperCase();
      const styleProps = {};
      this.style = { setProperty: (name, value) => { styleProps[name] = String(value); }, getPropertyValue: name => styleProps[name] ?? '' };
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
      this.innerHTML = '';
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
    click() { (this._listeners.click || []).forEach(fn => fn({ target: this })); }
  }
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, new Element());
    return nodes.get(key);
  }
  const storage = new Map();
  if (savedStats) storage.set('rouletteStats', typeof savedStats === 'string' ? savedStats : JSON.stringify(savedStats));
  for (const [key, value] of Object.entries(presets)) storage.set(key, value);
  const playLog = [];
  const documentListeners = [];
  let now = 0;
  let timerId = 0;
  const timers = [];
  const globals = {
    console,
    Audio: class { constructor(src) { this.src = src; } play() { playLog.push(this.src); return Promise.resolve(); } },
    document: {
      body: node('body'),
      getElementById: id => node(id),
      createElement: tag => new Element(tag),
      addEventListener: (type, fn) => documentListeners.push({ type, fn })
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
  };
  if (audioContext) globals.AudioContext = audioContext;
  const context = vm.createContext(globals);
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
  function pressKey(key, { target = { tagName: 'BODY', getAttribute: () => null }, ctrlKey = false } = {}) {
    const event = { key, target, ctrlKey, metaKey: false, preventDefault() {} };
    documentListeners.filter(l => l.type === 'keydown').forEach(l => l.fn(event));
  }
  const source = fs.readFileSync(enginePath, 'utf8') + '\n' + fs.readFileSync(scriptPath, 'utf8');
  vm.runInContext(source + '\n;globalThis.pageExports = { engine, table, getStats: () => ({...gameStats}), getSession: () => ({...sessionStats}), toggleMute, isMuted: () => soundMuted, placementFor, SPIN_MS, POCKET_ANGLE };', context, { filename: 'roulette-engine.js+roulette.js' });
  const env = { ...context.pageExports, node, flushTimers, stepTimers, playLog, storage, pressKey, timers };
  env.spot = key => env.table.locations.get(key);
  env.vars = key => {
    const s = env.spot(key).style;
    return Object.fromEntries(['--dr', '--drs', '--dc', '--dcs', '--mr', '--mrs', '--mc', '--mcs'].map(v => [v.slice(2), Number(s.getPropertyValue(v))]));
  };
  return env;
}

// Places chips through the page the way a player would: pick a chip, click the spot.
function bet(env, key, amount = 5) {
  env.table.selectAmount(amount);
  env.spot(key).onclick();
}

function spinTo(env, pocket) {
  const started = env.table.spin(pocket);
  env.flushTimers();
  return started;
}

test('Page: the engine and page scripts declare no top-level name twice', () => {
  // Both files load as plain <script> tags sharing one global scope. A repeated `const`
  // would throw, but a repeated `function` silently replaces the first one.
  const decl = /^(?:async\s+)?(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm;
  const names = file => new Set([...fs.readFileSync(file, 'utf8').matchAll(decl)].map(m => m[1] || m[2]));
  const engineNames = names(enginePath);
  const shared = [...names(scriptPath)].filter(n => engineNames.has(n));
  assert.deepEqual(shared, []);
});

test('Page: every one of the 158 bets has a spot - 50 boxes, the rest on the lines', () => {
  const env = makeEnvironment();
  const tableEl = env.node('betting-table');
  assert.equal(tableEl.children.length, 158);
  assert.equal(env.table.locations.size, 158);
  const cells = tableEl.children.filter(el => el.classList.contains('cell'));
  const lines = tableEl.children.filter(el => el.classList.contains('line-spot'));
  assert.equal(cells.length, 38 + 3 + 3 + 6);
  assert.equal(lines.length, 108);
  // Line spots come after the boxes, so they sit on top and can be clicked.
  assert.ok(tableEl.children.indexOf(lines[0]) > tableEl.children.indexOf(cells[cells.length - 1]));
  assert.ok(lines.every(el => el.tabIndex === -1));
  assert.equal(env.spot('split:17-20').getAttribute('aria-label'), 'Split 17/20, pays 17 to 1');
});

// The grid area an element covers, in half-row units on the desktop layout.
function area(v) {
  return { r0: v.dr, r1: v.dr + v.drs - 1, c0: v.dc, c1: v.dc + v.dcs - 1 };
}
const overlaps = (a, b) => a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;

test('Page: the boxes tile the table exactly, like a real layout', () => {
  const env = makeEnvironment();
  const cellKeys = BET_LIST.filter(b => ['straight', 'dozen', 'column', 'evenmoney'].includes(b.kind)).map(b => b.key);
  const covered = new Map();
  for (const key of cellKeys) {
    const a = area(env.vars(key));
    for (let r = a.r0; r <= a.r1; r++) {
      for (let c = a.c0; c <= a.c1; c++) {
        assert.ok(!covered.has(`${r},${c}`), `${key} overlaps ${covered.get(`${r},${c}`)} at ${r},${c}`);
        covered.set(`${r},${c}`, key);
      }
    }
  }
  // Numbers, zeros and columns fill rows 1-6 across all 14 columns; dozens and even-money
  // bets fill rows 7-8 under the numbers (columns 2-13).
  for (let r = 1; r <= 6; r++) for (let c = 1; c <= 14; c++) assert.ok(covered.has(`${r},${c}`), `gap at ${r},${c}`);
  for (let r = 7; r <= 8; r++) for (let c = 2; c <= 13; c++) assert.ok(covered.has(`${r},${c}`), `gap at ${r},${c}`);
  // Spot checks: 3 is top-left, 34 bottom-right, 00 above 0.
  assert.deepEqual(area(env.vars('straight:3')), { r0: 1, r1: 2, c0: 2, c1: 2 });
  assert.deepEqual(area(env.vars('straight:34')), { r0: 5, r1: 6, c0: 13, c1: 13 });
  assert.ok(env.vars('straight:00').dr < env.vars('straight:0').dr);
});

test('Page: every split, corner and trio spot sits on the line between exactly its numbers', () => {
  const env = makeEnvironment();
  const numberAreas = POCKETS.map(p => [p, area(env.vars(`straight:${p}`))]);
  for (const bet of BET_LIST.filter(b => ['split', 'corner', 'trio'].includes(b.kind))) {
    const spotArea = area(env.vars(bet.key));
    const touched = numberAreas.filter(([, a]) => overlaps(a, spotArea)).map(([p]) => p).sort();
    assert.deepEqual(touched, [...bet.numbers].sort(), bet.key);
    // And it straddles a line rather than sitting inside one box.
    assert.ok(numberAreas.every(([, a]) => !(a.r0 <= spotArea.r0 && spotArea.r1 <= a.r1 && a.c0 <= spotArea.c0 && spotArea.c1 <= a.c1)), `${bet.key} is inside a box`);
  }
});

test('Page: street, six-line and basket spots sit on the table\'s edge under their numbers', () => {
  const env = makeEnvironment();
  for (const bet of BET_LIST.filter(b => ['street', 'sixline', 'basket'].includes(b.kind))) {
    const v = env.vars(bet.key);
    assert.deepEqual([v.dr, v.drs], [6, 2], bet.key); // straddles the bottom edge of the numbers
    const cols = new Set(bet.numbers.map(p => env.vars(`straight:${p}`).dc));
    assert.equal(v.dc, Math.min(...cols), bet.key);
    assert.equal(v.dc + v.dcs - 1, Math.max(...cols), bet.key);
  }
});

test('Page: phones get the same table turned sideways', () => {
  const env = makeEnvironment();
  for (const bet of BET_LIST) {
    const v = env.vars(bet.key);
    assert.deepEqual([v.mr, v.mrs, v.mc, v.mcs], [v.dc, v.dcs, 9 - (v.dr + v.drs - 1), v.drs], bet.key);
  }
  // 0 and 00 end up across the top, 1-2-3 the first row below them, 1 on the left.
  const m = key => env.vars(key);
  assert.equal(m('straight:0').mr, 1);
  assert.equal(m('straight:1').mr, 2);
  assert.ok(m('straight:1').mc < m('straight:2').mc && m('straight:2').mc < m('straight:3').mc);
});

test('Page: clicking a spot puts the selected chip on it and shows it on the table', () => {
  const env = makeEnvironment();
  bet(env, 'corner:22-23-25-26', 25);
  bet(env, 'corner:22-23-25-26', 100);
  assert.equal(env.engine.bets['corner:22-23-25-26'], 125);
  const spot = env.spot('corner:22-23-25-26');
  assert.equal(spot.parts.chip.textContent, '$125');
  assert.ok(spot.parts.chip.classList.contains('chip-100'));
  assert.ok(spot.classList.contains('has-bet'));
  assert.equal(env.node('balance').textContent, 'Balance: $375');
  assert.equal(env.node('wagered').textContent, 'On the table: $125');
  assert.equal(env.node('message').textContent, 'Corner 22/23/25/26: $125');
  assert.ok(env.playLog.includes('sounds/chip.wav'));
});

test('Page: a chip you can\'t afford is refused with a message', () => {
  const env = makeEnvironment();
  bet(env, 'red', 500);
  bet(env, 'black', 5);
  assert.equal(env.engine.bets.black, undefined);
  assert.match(env.node('message').textContent, /Not enough balance for a \$5 chip/);
});

test('Page: right-clicking a spot takes that bet back', () => {
  const env = makeEnvironment();
  bet(env, 'red', 25);
  bet(env, 'straight:7', 5);
  let prevented = false;
  env.spot('red').oncontextmenu({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'the browser menu should not open');
  assert.deepEqual({ ...env.engine.bets }, { 'straight:7': 5 });
  assert.equal(env.spot('red').parts.chip.textContent, '');
  assert.equal(env.spot('red').classList.contains('has-bet'), false);
});

test('Page: hovering a spot lights up exactly the numbers it covers', () => {
  const env = makeEnvironment();
  const lit = () => [...env.table.numberCells].filter(([, cell]) => cell.classList.contains('covered')).map(([p]) => p).sort();
  env.spot('corner:22-23-25-26').onmouseenter();
  assert.deepEqual(lit(), ['22', '23', '25', '26']);
  env.spot('basket').onmouseenter();
  assert.deepEqual(lit(), ['0', '00', '1', '2', '3']);
  env.spot('basket').onmouseleave();
  assert.deepEqual(lit(), []);
});

test('Page: Undo, Clear, Double and Rebet buttons work and enable only when they can', () => {
  const env = makeEnvironment();
  const btn = id => env.node(id);
  assert.equal(btn('undo-button').disabled, true);
  assert.equal(btn('spin-button').disabled, true);
  bet(env, 'red', 5);
  bet(env, 'split:0-00', 1);
  assert.equal(btn('undo-button').disabled, false);
  assert.equal(btn('rebet-button').disabled, true);
  btn('undo-button').click();
  assert.deepEqual({ ...env.engine.bets }, { red: 5 });
  btn('double-button').click();
  assert.deepEqual({ ...env.engine.bets }, { red: 10 });
  btn('clear-bets').click();
  assert.deepEqual({ ...env.engine.bets }, {});
  assert.equal(btn('clear-bets').disabled, true);
  bet(env, 'odd', 5);
  spinTo(env, '3');
  env.node('next-round').click();
  assert.equal(btn('rebet-button').disabled, false);
  btn('rebet-button').click();
  assert.deepEqual({ ...env.engine.bets }, { odd: 5 });
});

test('Page: while the wheel turns the table is locked and the result stays hidden', () => {
  const env = makeEnvironment();
  bet(env, 'red', 25);
  bet(env, 'straight:17', 5);
  assert.equal(env.table.spin('17'), true);
  assert.equal(env.node('game-container').dataset.phase, 'spinning');
  assert.equal(env.node('message').textContent, 'No more bets.');
  assert.ok(env.node('result-number').classList.contains('spinning'));
  assert.equal(env.node('result-number').textContent, '');
  assert.equal(env.node('history').children.length, 0, 'the history must not give the number away');
  assert.equal(env.spot('straight:17').classList.contains('bet-won'), false);
  assert.equal(env.node('wagered').textContent, 'On the table: $30');
  assert.ok(env.table.locations.get('red').disabled);
  // Nothing can be changed or started mid-spin.
  bet(env, 'black', 5);
  env.spot('red').oncontextmenu({ preventDefault() {} });
  env.table.undo();
  assert.equal(env.table.spin(), false);
  assert.equal(env.table.nextRound(), false);
  assert.deepEqual({ ...env.engine.lastSpin.results.map(r => r.key) }, { 0: 'red', 1: 'straight:17' });
  assert.equal(env.getSession().spinsPlayed, 0, 'stats wait for the ball to land');
});

test('Page: when the ball lands, the result, the winners and the money all show', () => {
  const env = makeEnvironment();
  bet(env, 'straight:17', 5);
  bet(env, 'split:17-20', 5);
  bet(env, 'red', 25);
  spinTo(env, '17');
  assert.equal(env.node('game-container').dataset.phase, 'results');
  assert.equal(env.node('result-number').textContent, '17 Black');
  assert.ok(env.node('result-number').classList.contains('pocket-black'));
  assert.ok(env.table.numberCells.get('17').classList.contains('winning'));
  assert.equal(env.table.numberCells.get('20').classList.contains('winning'), false);
  assert.ok(env.spot('straight:17').classList.contains('bet-won'));
  assert.ok(env.spot('split:17-20').classList.contains('bet-won'));
  assert.ok(env.spot('red').classList.contains('bet-lost'));
  assert.equal(env.spot('red').parts.chip.textContent, '$25', 'settled chips stay on show');
  // 180 + 90 back on 35 bet
  assert.equal(env.node('message').textContent, 'Winning: Straight up 17, Split 17/20. Paid $270, net +$235.');
  assert.equal(env.node('balance').textContent, 'Balance: $735');
  assert.equal(env.node('wagered').textContent, 'Bet this spin: $35');
  assert.equal(env.node('history').children[0].textContent, '17');
  assert.deepEqual({ ...env.getSession() }, { spinsPlayed: 1, betsPlaced: 3, totalWagered: 35, totalWon: 270, biggestWin: 270 });
  assert.equal(env.playLog[env.playLog.length - 1], 'sounds/blackjack.mp3'); // a straight-up hit
});

test('Page: win and lose sounds follow the net result', () => {
  const env = makeEnvironment();
  bet(env, 'red', 5);
  spinTo(env, '1');
  assert.equal(env.playLog[env.playLog.length - 1], 'sounds/win.mp3');
  env.table.nextRound();
  bet(env, 'red', 5);
  bet(env, 'black', 5);
  spinTo(env, '1'); // even money both ways: no net gain
  assert.equal(env.playLog[env.playLog.length - 1], 'sounds/lose.mp3');
  assert.equal(env.node('message').textContent, 'Winning: Red. Paid $10, net $0.');
});

test('Page: the wheel stops with the winning pocket under the pointer, after 5+ full turns', () => {
  const env = makeEnvironment();
  let previous = 0;
  for (const pocket of ['17', '0', '00', '36', '17']) {
    bet(env, 'red', 1);
    spinTo(env, pocket);
    const angle = Number(env.node('wheel-rotor').style.transform.match(/rotate\((-?[\d.]+)deg\)/)[1]);
    assert.ok(angle >= previous + 5 * 360 - env.POCKET_ANGLE, `${pocket}: only ${angle - previous} degrees`);
    // Pocket i is drawn i * POCKET_ANGLE clockwise from the top, so turning the wheel by
    // -i * POCKET_ANGLE (mod 360) brings it to the top.
    const index = WHEEL_ORDER.indexOf(pocket);
    let off = ((angle + index * env.POCKET_ANGLE) % 360 + 360) % 360;
    if (off > 180) off -= 360;
    assert.ok(Math.abs(off) < env.POCKET_ANGLE / 2, `${pocket} landed ${off.toFixed(2)} degrees off`);
    previous = angle;
    env.table.nextRound();
  }
});

test('Page: the ball\'s roll is synthesized to last as long as the spin, and respects mute', () => {
  const starts = [];
  class FakeParam { setValueAtTime() {} exponentialRampToValueAtTime() {} set value(v) {} }
  class FakeNode { constructor() { this.frequency = new FakeParam(); this.Q = new FakeParam(); this.gain = new FakeParam(); } connect(n) { return n; } start(when) { starts.push(when); } stop() {} }
  class FakeContext {
    constructor() { this.currentTime = 10; this.sampleRate = 8000; this.state = 'running'; this.destination = new FakeNode(); }
    createBuffer(channels, length) { const data = new Float32Array(length); return { getChannelData: () => data }; }
    createBufferSource() { return new FakeNode(); }
    createBiquadFilter() { return new FakeNode(); }
    createGain() { return new FakeNode(); }
  }
  const env = makeEnvironment(null, { audioContext: FakeContext });
  bet(env, 'red', 5);
  env.table.spin('1');
  assert.ok(starts.length > 10, `expected a whir plus a rattle of ticks, got ${starts.length} sounds`);
  const last = Math.max(...starts);
  assert.ok(last > 10 + env.SPIN_MS / 1000 - 0.3 && last <= 10 + env.SPIN_MS / 1000, `the final clack at ${last}`);
  assert.ok(!env.playLog.includes('sounds/card.wav'));
  env.flushTimers();
  env.table.nextRound();

  env.toggleMute();
  starts.length = 0;
  bet(env, 'red', 5);
  env.table.spin('1');
  assert.equal(starts.length, 0);
});

test('Page: without Web Audio the spin falls back to a recorded sound', () => {
  const env = makeEnvironment();
  bet(env, 'red', 5);
  env.table.spin('1');
  assert.ok(env.playLog.includes('sounds/card.wav'));
});

test('Page: Same Bets puts last spin\'s chips back; Same Bets & Spin also spins', () => {
  const env = makeEnvironment();
  bet(env, 'straight:5', 5);
  bet(env, 'dozen1', 25);
  spinTo(env, '30');
  assert.equal(env.node('same-bets').disabled, false);
  env.node('same-bets').click();
  assert.equal(env.engine.phase, 'betting');
  assert.deepEqual({ ...env.engine.bets }, { 'straight:5': 5, dozen1: 25 });
  spinTo(env, '30');
  env.node('same-bets-spin').click();
  assert.equal(env.node('game-container').dataset.phase, 'spinning');
  env.flushTimers();
  assert.equal(env.getSession().spinsPlayed, 3);
  assert.equal(env.getSession().totalWagered, 90);
});

test('Page: Same Bets is unavailable when the balance can\'t cover them', () => {
  const env = makeEnvironment();
  env.engine.setBalance(30);
  bet(env, 'red', 25);
  spinTo(env, '2'); // lose: $5 left
  assert.equal(env.node('same-bets').disabled, true);
  assert.equal(env.node('same-bets-spin').disabled, true);
  assert.equal(env.table.sameBetsAndSpin(), false);
  assert.equal(env.engine.phase, 'results', 'a refused Same Bets must not move on to a new round');
});

test('Page: Enter spins and moves on, but not when pressed on a focused control', () => {
  const env = makeEnvironment();
  bet(env, 'red', 5);
  env.pressKey('Enter', { target: { tagName: 'BUTTON', getAttribute: () => null } }); // a focused table spot
  env.pressKey('Enter', { target: { tagName: 'DIV', getAttribute: n => (n === 'role' ? 'button' : null) } }); // a chip
  env.pressKey('Enter', { target: { tagName: 'INPUT', getAttribute: () => null } });
  assert.equal(env.engine.phase, 'betting');
  env.pressKey('Enter');
  assert.equal(env.node('game-container').dataset.phase, 'spinning');
  env.pressKey('Enter'); // mid-spin: ignored
  env.flushTimers();
  assert.equal(env.engine.phase, 'results');
  env.pressKey('Enter');
  assert.equal(env.engine.phase, 'betting');
});

test('Page: Ctrl+Z takes back the last chip', () => {
  const env = makeEnvironment();
  bet(env, 'red', 5);
  bet(env, 'black', 1);
  env.pressKey('z', { ctrlKey: true });
  assert.deepEqual({ ...env.engine.bets }, { red: 5 });
});

test('Page: going broke offers a new game at the chosen starting balance', () => {
  const env = makeEnvironment();
  env.table.setBankroll(10);
  bet(env, 'red', 10);
  assert.equal(env.node('restart').style.display, 'none');
  spinTo(env, '00');
  assert.equal(env.node('restart').style.display, 'inline-block');
  env.node('restart').click();
  assert.equal(env.engine.balance, 10);
  assert.equal(env.engine.phase, 'betting');
  assert.match(env.node('message').textContent, /start again with \$10/);
});

test('Page: the starting balance can only be set with an empty table', () => {
  const env = makeEnvironment();
  assert.equal(env.table.setBankroll(2500), true);
  assert.equal(env.node('balance').textContent, 'Balance: $2,500');
  bet(env, 'red', 5);
  assert.equal(env.node('set-bankroll').disabled, true);
  assert.equal(env.table.setBankroll(100), false);
  assert.equal(env.table.setBankroll(0), false);
});

test('Page: the paytable shows every kind of bet and flags the basket\'s worse edge', () => {
  const env = makeEnvironment();
  const rows = env.node('paytable-body').children;
  assert.equal(rows.length, 8);
  const basket = rows.find(r => r.parts[0].textContent.startsWith('Basket'));
  assert.equal(basket.parts[3].textContent, '7.89%');
  assert.ok(basket.classList.contains('worse-edge'));
  assert.equal(rows.filter(r => r.classList.contains('worse-edge')).length, 1);
  assert.equal(rows[0].parts[1].textContent, '35:1');
  assert.equal(rows[0].parts[3].textContent, '5.26%');
});

test('Page: lifetime stats persist; corrupt or blocked storage starts fresh', () => {
  const saved = { spinsPlayed: 10, betsPlaced: 12, totalWagered: 100, totalWon: 80, biggestWin: 36 };
  const env = makeEnvironment(saved);
  bet(env, 'red', 5);
  spinTo(env, '1');
  assert.deepEqual(JSON.parse(env.storage.get('rouletteStats')), { spinsPlayed: 11, betsPlaced: 13, totalWagered: 105, totalWon: 90, biggestWin: 36 });
  assert.equal(makeEnvironment('{not json').getStats().spinsPlayed, 0);
  assert.equal(makeEnvironment({ spinsPlayed: 'x' }).getStats().spinsPlayed, 0);
  const blocked = makeEnvironment(null, { storageThrows: true });
  bet(blocked, 'red', 5);
  spinTo(blocked, '1');
  assert.equal(blocked.getSession().spinsPlayed, 1);
});

test('Page: fast-forward runs the bets on the table many times and reports the real edge', () => {
  const env = makeEnvironment();
  env.engine.setBalance(100_000);
  env.engine.rng = mulberry32(7);
  bet(env, 'red', 10);
  bet(env, 'basket', 5);
  env.node('ff-spins').value = '2000';
  env.node('fast-forward-button').click();
  assert.equal(env.node('game-container').dataset.fastforward, 'true');
  assert.deepEqual({ ...env.engine.bets }, {}, 'the bets become the pattern, not a stake');
  env.flushTimers();
  assert.equal(env.node('game-container').dataset.fastforward, 'false');
  const session = env.getSession();
  assert.equal(session.spinsPlayed, 2000);
  assert.equal(session.betsPlaced, 4000);
  assert.equal(session.totalWagered, 30_000);
  assert.equal(env.engine.balance, 100_000 - session.totalWagered + session.totalWon);
  const summary = env.node('fastforward-summary');
  assert.equal(summary.hidden, false);
  assert.equal(summary.children[0].textContent, 'Simulation complete');
  // Stake-weighted edge: (10 * 5.263 + 5 * 7.895) / 15 = 6.14%
  assert.match(summary.children[1].innerHTML, /house edge on these bets is 6\.14%/);
  assert.equal(env.engine.phase, 'betting');
  assert.deepEqual({ ...env.engine.bets }, {});
});

test('Page: nothing on the table can be touched while a simulation runs', () => {
  const env = makeEnvironment();
  env.engine.setBalance(1_000_000);
  bet(env, 'red', 1);
  env.table.runFastForward(100_000);
  assert.equal(env.spot('black').disabled, true);
  bet(env, 'black', 5);
  env.table.spin();
  env.table.undo();
  env.table.rebet();
  env.table.setBankroll(5);
  env.pressKey('Enter');
  assert.equal(env.table.spinning, false);
  env.table.stopFastForward();
  env.flushTimers();
  assert.equal(env.engine.bets.black, undefined);
  assert.ok(env.engine.balance > 5);
});

test('Page: stopping between chunks halts the run partway through', () => {
  const env = makeEnvironment();
  env.engine.setBalance(100_000_000);
  bet(env, 'red', 1);
  const realNow = Date.now;
  let fake = 0;
  Date.now = () => (fake += 1); // each spin "takes" 1ms, so a chunk is about 20 spins
  try {
    env.table.runFastForward(100_000);
    assert.equal(env.stepTimers(1), 1);
  } finally {
    Date.now = realNow;
  }
  const spinsSoFar = env.table.ff.spinsRun;
  assert.ok(spinsSoFar > 0 && spinsSoFar < 100_000, `${spinsSoFar} spins in the first chunk`);
  env.node('ff-stop-button').click();
  env.flushTimers();
  assert.equal(env.node('game-container').dataset.fastforward, 'false');
  assert.equal(env.getSession().spinsPlayed, spinsSoFar);
  assert.equal(env.node('fastforward-summary').children[0].textContent, 'Stopped early');
});

test('Page: running out of money ends the simulation and says so', () => {
  const env = makeEnvironment();
  env.engine.setBalance(20);
  env.engine.rng = () => 0.01; // always pocket '0'
  bet(env, 'red', 5);
  env.table.runFastForward(1000);
  env.flushTimers();
  assert.equal(env.getSession().spinsPlayed, 4);
  assert.equal(env.engine.balance, 0);
  assert.equal(env.node('fastforward-summary').children[0].textContent, 'Ran out of money');
  assert.equal(env.node('restart').style.display, 'inline-block');
});

test('Page: fast-forward records the biggest SINGLE spin win, not the run\'s total', () => {
  const env = makeEnvironment();
  env.engine.rng = () => 0; // pocket '0' every spin
  bet(env, 'straight:0', 10);
  env.table.runFastForward(3);
  env.flushTimers();
  assert.equal(env.getSession().totalWon, 360 * 3);
  assert.equal(env.getStats().biggestWin, 360);
});

test('Page: invalid simulation lengths are refused without starting', () => {
  const env = makeEnvironment();
  bet(env, 'red', 1);
  for (const n of [0, -5, 2.5, NaN, 100_001]) {
    env.table.runFastForward(n);
    assert.equal(env.table.fastForwarding, false, String(n));
  }
  assert.deepEqual({ ...env.engine.bets }, { red: 1 });
});

test('Page: fuzz - 300 random rounds through the page keep balance and stats in agreement', () => {
  const env = makeEnvironment();
  const rng = mulberry32(2024);
  const { engine: e, table: t } = env;
  e.rng = rng;
  let topUps = 0;
  const keys = [...BETS.keys()];
  for (let round = 0; round < 300; round++) {
    if (e.balance < 50) { e.balance += 500; topUps += 500; }
    const n = 1 + Math.floor(rng() * 4);
    for (let i = 0; i < n; i++) bet(env, keys[Math.floor(rng() * keys.length)], [1, 5, 25][Math.floor(rng() * 3)] > e.balance ? 1 : [1, 5][Math.floor(rng() * 2)]);
    if (rng() < 0.2) t.undo();
    if (rng() < 0.1) t.doubleBets();
    if (e.totalWagered() === 0) bet(env, 'red', 1);
    assert.equal(t.spin(), true, `round ${round}`);
    env.flushTimers();
    assert.equal(e.phase, 'results', `round ${round}`);
    const s = env.getSession();
    assert.equal(e.balance, 500 + topUps - s.totalWagered + s.totalWon, `round ${round}`);
    assert.equal(env.node('balance').textContent, `Balance: $${e.balance.toLocaleString('en-US')}`);
    if (rng() < 0.3 && t.canRepeat()) t.sameBets(); else t.nextRound();
    if (e.totalWagered() > 0) t.clearBets();
  }
});

const failures = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.length - failures.length, total: results.length, failures }, null, 2));
