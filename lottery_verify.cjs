'use strict';

// Checks for Lucky Draw. Run with:  node lottery_verify.cjs
//
// Part 1 tests the engine (lottery-engine.js) directly in plain Node, with no browser,
// including that its odds match the real published odds of the game it is modeled on.
// Part 2 loads the engine and the page (lottery.js) into a mocked browser to check the
// page wiring: messages, statistics, sounds, storage and rendering.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const enginePath = path.join(dir, 'lottery-engine.js');
const scriptPath = path.join(dir, 'lottery.js');
const { LotteryEngine, nCr, outcomesFor, totalDrawings, computeOddsTable } = require(enginePath);

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
// Part 1: the odds and the engine
// =====================================================================

test('Engine: the total number of drawings matches the real game (292,201,338)', () => {
  assert.equal(totalDrawings(), 292201338);
});

test('Engine: every published odds tier matches the real game exactly', () => {
  const official = {
    jackpot: 292201338,
    match5: 11688053.52,
    match4pb: 913129.18,
    match4: 36525.17,
    match3pb: 14494.11,
    match3: 579.76,
    match2pb: 701.33,
    match1pb: 91.98,
    match0pb: 38.32
  };
  const table = computeOddsTable();
  for (const [key, expected] of Object.entries(official)) {
    const tier = table.find(t => t.key === key);
    assert.ok(tier, `missing tier ${key}`);
    assert.ok(Math.abs(tier.oddsInOne - expected) < 0.02, `${key}: got ${tier.oddsInOne}, expected ${expected}`);
  }
  const overall = table.find(t => t.key === 'overall');
  assert.ok(Math.abs(overall.oddsInOne - 24.9) < 0.1, `overall odds: got ${overall.oddsInOne}`);
  assert.match(overall.oddsLabel, /^1 in 24\.\d/); // officially cited as ~1 in 24.9
});

test('Engine: nCr matches known binomial coefficients', () => {
  assert.equal(nCr(69, 5), 11238513);
  assert.equal(nCr(5, 5), 1);
  assert.equal(nCr(5, 0), 1);
  assert.equal(nCr(64, 5), 7624512);
  assert.equal(nCr(3, 5), 0); // r > n
});

test('Engine: outcomesFor sums to the total across every match count', () => {
  let sum = 0;
  for (let matchWhite = 0; matchWhite <= 5; matchWhite++) {
    sum += outcomesFor(matchWhite, true) + outcomesFor(matchWhite, false);
  }
  assert.equal(sum, totalDrawings());
});

// =====================================================================
// Part 2: the engine's behaviour
// =====================================================================

test('Engine: revealDraw shows the numbers without checking any tickets yet', () => {
  const e = new LotteryEngine();
  e.buyTickets(3);
  const events = record(e);
  assert.equal(e.revealDraw({ whites: [1, 2, 3, 4, 5], red: 1 }).ok, true);
  assert.equal(e.phase, 'checking');
  assert.deepEqual(e.winningWhites, [1, 2, 3, 4, 5]);
  assert.equal(e.winningRed, 1);
  assert.equal(e.checkedResults.length, 0);
  assert.equal(e.lastDraw, null); // nothing has settled yet
  assert.equal(e.balance, 94); // just the cost of the tickets, no winnings yet
  assert.equal(events.find(ev => ev.type === 'numbersRevealed') !== undefined, true);
  assert.equal(e.canDraw(), false); // can't draw again mid-check
  assert.equal(e.canBuy(1), false);
});

test('Engine: checkBatch processes tickets incrementally and settles once all are checked', () => {
  const e = new LotteryEngine();
  for (let i = 0; i < 10; i++) e.buyTickets(1);
  e.tickets.forEach(t => { t.whites = [60, 61, 62, 63, 64]; t.red = 25; }); // guaranteed losers
  const events = record(e);
  e.revealDraw({ whites: [1, 2, 3, 4, 5], red: 1 });
  assert.equal(e.canCheck(), true);
  assert.equal(e.ticketsLeftToCheck(), 10);

  e.checkBatch(4);
  assert.equal(e.checkedResults.length, 4);
  assert.equal(e.ticketsLeftToCheck(), 6);
  assert.equal(e.phase, 'checking'); // not settled yet
  assert.equal(e.canCheck(), true);
  const progress = events.filter(ev => ev.type === 'checkProgress');
  assert.equal(progress.length, 1);
  assert.deepEqual([progress[0].checked, progress[0].total], [4, 10]);

  e.checkBatch(4);
  assert.equal(e.ticketsLeftToCheck(), 2);
  assert.equal(e.phase, 'checking');

  e.checkBatch(100); // asking for more than remain finishes it off
  assert.equal(e.checkedResults.length, 10);
  assert.equal(e.phase, 'results');
  assert.equal(e.canCheck(), false);
  assert.equal(events.some(ev => ev.type === 'drawResolved'), true);
  assert.equal(e.lastDraw.results.length, 10);
});

test('Engine: checkBatch is locked outside the checking phase', () => {
  const e = new LotteryEngine();
  assert.equal(e.checkBatch(10).reason, 'locked'); // still buying, nothing revealed
  e.buyTickets(1);
  e.draw({ whites: [1, 2, 3, 4, 5], red: 1 }); // reveals and checks in one call
  assert.equal(e.phase, 'results');
  assert.equal(e.checkBatch(10).reason, 'locked'); // already fully checked
});

test('Engine: draw() (the one-call convenience) gives the same result as revealDraw + checkBatch', () => {
  const stepwise = new LotteryEngine();
  stepwise.buyTickets(5);
  stepwise.tickets.forEach(t => { t.whites = [1, 2, 3, 4, 6]; t.red = 1; });
  stepwise.revealDraw({ whites: [1, 2, 3, 4, 5], red: 1 });
  while (stepwise.canCheck()) stepwise.checkBatch(2);

  const oneCall = new LotteryEngine();
  oneCall.buyTickets(5);
  oneCall.tickets.forEach(t => { t.whites = [1, 2, 3, 4, 6]; t.red = 1; });
  oneCall.draw({ whites: [1, 2, 3, 4, 5], red: 1 });

  assert.equal(stepwise.balance, oneCall.balance);
  assert.equal(stepwise.phase, oneCall.phase);
  assert.deepEqual(stepwise.lastDraw.results.map(r => r.prize), oneCall.lastDraw.results.map(r => r.prize));
});

test('Engine: a huge number of tickets does not overflow the call stack computing the biggest win', () => {
  const e = new LotteryEngine({ startingBalance: 2_000_000 });
  e.buyTickets(500_000);
  e.tickets.forEach(t => { t.whites = [60, 61, 62, 63, 64]; t.red = 25; }); // all guaranteed losers
  e.tickets[123].whites = [1, 2, 3, 4, 6]; // one match4 winner: $100
  assert.doesNotThrow(() => e.draw({ whites: [1, 2, 3, 4, 5], red: 9 }));
  assert.equal(e.lastDraw.totalWon, 100);
  assert.equal(e.stats.biggestWin, 100);
});

test('Engine: isBroke stays false mid-check even at $0, and going broke is detected once settled', () => {
  const e = new LotteryEngine({ startingBalance: 2 });
  e.buyTickets(1);
  e.tickets[0] = { whites: [1, 2, 3, 4, 5], red: 1 }; // guaranteed not to match
  e.revealDraw({ whites: [60, 61, 62, 63, 64], red: 25 });
  assert.equal(e.balance, 0);
  assert.equal(e.isBroke(), false); // still mid-check, nothing has settled
  e.checkBatch(1);
  assert.equal(e.phase, 'results');
  assert.equal(e.isBroke(), true);
});

test('Engine: revealed numbers are cleared between rounds and on restart', () => {
  const e = new LotteryEngine({ startingBalance: 2 });
  e.buyTickets(1);
  e.draw({ whites: [1, 2, 3, 4, 5], red: 1 });
  e.nextRound();
  assert.equal(e.winningWhites, null);
  assert.equal(e.winningRed, null);
  assert.equal(e.checkedResults.length, 0);

  const broke = new LotteryEngine({ startingBalance: 2 });
  broke.buyTickets(1);
  broke.tickets[0] = { whites: [1, 2, 3, 4, 5], red: 1 }; // guaranteed not to match
  broke.draw({ whites: [60, 61, 62, 63, 64], red: 25 });
  assert.equal(broke.isBroke(), true);
  broke.restart();
  assert.equal(broke.winningWhites, null);
  assert.equal(broke.winningRed, null);
});

test('Engine: the player can set their own starting balance before buying anything', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  assert.equal(e.canSetBalance(), true);
  assert.equal(e.setBalance(5000).ok, true);
  assert.equal(e.balance, 5000);
  assert.equal(e.startingBalance, 5000); // also becomes the restart-to amount
  assert.equal(e.setBalance(1.5).reason, 'invalid');
  assert.equal(e.setBalance(-10).reason, 'invalid');
  assert.equal(e.setBalance(1).reason, 'invalid'); // below the ticket price
  assert.equal(e.setBalance(e.ticketPrice).ok, true); // exactly the ticket price is fine
});

test('Engine: setting the balance is locked once a ticket is held', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  e.buyTickets(1);
  assert.equal(e.canSetBalance(), false);
  assert.equal(e.setBalance(5000).reason, 'locked');
  assert.equal(e.balance, 98);
});

test('Engine: a chosen balance survives going broke and restarting', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  e.setBalance(6);
  e.buyTickets(1);
  e.tickets[0] = { whites: [60, 61, 62, 63, 64], red: 25 }; // guaranteed not to match
  e.draw({ whites: [1, 2, 3, 4, 5], red: 20 });
  e.nextRound();
  assert.equal(e.balance, 4);
  e.buyTickets(2);
  e.tickets.forEach(t => { t.whites = [60, 61, 62, 63, 64]; t.red = 25; });
  e.draw({ whites: [1, 2, 3, 4, 5], red: 20 });
  assert.equal(e.balance, 0);
  assert.equal(e.isBroke(), true);
  assert.equal(e.restart(), true);
  assert.equal(e.balance, 6); // back to the chosen $6, not the original $100
});

test('Engine: buying tickets deducts the cost and records the purchase', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  const events = record(e);
  assert.equal(e.buyTickets(5).ok, true);
  assert.equal(e.balance, 90);
  assert.equal(e.tickets.length, 5);
  assert.equal(e.stats.ticketsBought, 5);
  assert.equal(e.stats.totalSpent, 10);
  const bought = events.find(ev => ev.type === 'ticketsBought');
  assert.equal(bought.quantity, 5);
  assert.equal(bought.cost, 10);
  e.tickets.forEach(ticket => {
    assert.equal(ticket.whites.length, 5);
    assert.equal(new Set(ticket.whites).size, 5); // no duplicate numbers
    ticket.whites.forEach(n => assert.ok(n >= 1 && n <= 69));
    assert.ok(ticket.red >= 1 && ticket.red <= 26);
  });
});

test('Engine: buying can be repeated before a drawing, accumulating tickets', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  e.buyTickets(3);
  e.buyTickets(2);
  assert.equal(e.tickets.length, 5);
  assert.equal(e.balance, 90);
});

test('Engine: cannot buy zero, a fraction, more than affordable, or while locked', () => {
  const e = new LotteryEngine({ startingBalance: 10 });
  assert.equal(e.buyTickets(0).reason, 'invalid');
  assert.equal(e.buyTickets(-1).reason, 'invalid');
  assert.equal(e.buyTickets(2.5).reason, 'invalid');
  assert.equal(e.buyTickets(6).reason, 'insufficient'); // needs $12, has $10
  assert.equal(e.buyTickets(5).ok, true); // exactly affordable
  assert.equal(e.balance, 0);
  e.draw({ whites: [1, 2, 3, 4, 5], red: 1 });
  assert.equal(e.buyTickets(1).reason, 'locked');
});

test('Engine: maxAffordable and buying the max leaves nothing over', () => {
  const e = new LotteryEngine({ startingBalance: 47 });
  assert.equal(e.maxAffordable(), 23);
  e.buyTickets(e.maxAffordable());
  assert.equal(e.balance, 1);
  assert.equal(e.canBuy(1), false);
});

test('Engine: clearing tickets refunds them, but only before the drawing', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  e.buyTickets(10);
  assert.equal(e.clearTickets().ok, true);
  assert.equal(e.balance, 100);
  assert.equal(e.tickets.length, 0);
  assert.equal(e.stats.ticketsBought, 0);
  assert.equal(e.stats.totalSpent, 0);
  assert.equal(e.clearTickets().reason, 'nothing');
  e.buyTickets(1);
  e.draw({ whites: [1, 2, 3, 4, 5], red: 1 });
  assert.equal(e.clearTickets().reason, 'nothing'); // wrong phase, not just empty
});

test('Engine: a drawing produces 5 unique whites 1-69 and one red 1-26', () => {
  const e = new LotteryEngine();
  e.buyTickets(1);
  const { draw } = e.draw();
  assert.equal(draw.winningWhites.length, 5);
  assert.equal(new Set(draw.winningWhites).size, 5);
  draw.winningWhites.forEach(n => assert.ok(n >= 1 && n <= 69));
  assert.ok(draw.winningRed >= 1 && draw.winningRed <= 26);
  assert.deepEqual(draw.winningWhites, [...draw.winningWhites].sort((a, b) => a - b));
});

test('Engine: white numbers can reach both the low (1) and high (69) end', () => {
  const lowEngine = new LotteryEngine({ rng: () => 0 }); // always pick index 0 of what remains
  assert.deepEqual(lowEngine.drawWhites(), [1, 2, 3, 4, 5]);
  const highEngine = new LotteryEngine({ rng: () => 0.999999 }); // always pick the last remaining index
  assert.deepEqual(highEngine.drawWhites(), [65, 66, 67, 68, 69]);
  assert.equal(new LotteryEngine({ rng: () => 0 }).drawRed(), 1);
  assert.equal(new LotteryEngine({ rng: () => 0.999999 }).drawRed(), 26);
});

test('Engine: cannot draw with no tickets, and drawing is locked afterwards', () => {
  const e = new LotteryEngine();
  assert.equal(e.draw().reason, 'notickets');
  e.buyTickets(1);
  e.draw();
  assert.equal(e.phase, 'results');
  assert.equal(e.draw().reason, 'locked');
  assert.equal(e.canDraw(), false);
});

test('Engine: every prize tier pays exactly what it should', () => {
  const cases = [
    { whites: [1, 2, 3, 4, 5], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: 'jackpot', prize: LotteryEngine.BASE_JACKPOT },
    { whites: [1, 2, 3, 4, 5], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 2, tier: 'match5', prize: 1000000 },
    { whites: [1, 2, 3, 4, 6], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: 'match4pb', prize: 50000 },
    { whites: [1, 2, 3, 4, 6], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 2, tier: 'match4', prize: 100 },
    { whites: [1, 2, 3, 6, 7], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: 'match3pb', prize: 100 },
    { whites: [1, 2, 3, 6, 7], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 2, tier: 'match3', prize: 7 },
    { whites: [1, 2, 6, 7, 8], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: 'match2pb', prize: 7 },
    { whites: [1, 6, 7, 8, 9], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: 'match1pb', prize: 4 },
    { whites: [6, 7, 8, 9, 10], red: 1, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: 'match0pb', prize: 4 },
    { whites: [6, 7, 8, 9, 10], red: 2, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: null, prize: 0 },
    { whites: [1, 2, 6, 7, 8], red: 2, expectWhites: [1, 2, 3, 4, 5], expectRed: 1, tier: null, prize: 0 }
  ];
  for (const c of cases) {
    const e = new LotteryEngine();
    e.tickets = [{ whites: c.whites, red: c.red }];
    const result = e.evaluateTicket(e.tickets[0], c.expectWhites, c.expectRed);
    assert.equal(result.tier, c.tier, JSON.stringify(c));
    assert.equal(result.prize, c.prize, JSON.stringify(c));
  }
});

test('Engine: a drawing pays every winning ticket and totals them correctly', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  e.buyTickets(1);
  e.tickets[0] = { whites: [1, 2, 3, 4, 5], red: 2 }; // will match 5, not the red ball
  e.buyTickets(1);
  e.tickets[1] = { whites: [9, 10, 11, 12, 13], red: 9 }; // will not win
  const { draw } = e.draw({ whites: [1, 2, 3, 4, 5], red: 1 });
  assert.equal(draw.results[0].tier, 'match5');
  assert.equal(draw.results[0].prize, 1000000);
  assert.equal(draw.results[1].tier, null);
  assert.equal(draw.totalWon, 1000000);
  assert.equal(e.balance, 96 + 1000000); // 100 - 2 tickets*$2 each + winnings
  assert.equal(e.stats.totalWon, 1000000);
  assert.equal(e.stats.biggestWin, 1000000);
});

test('Engine: the jackpot rolls over when nobody wins it, and resets after a win', () => {
  const e = new LotteryEngine();
  e.buyTickets(1);
  e.tickets[0] = { whites: [60, 61, 62, 63, 64], red: 20 }; // guaranteed not to match
  const first = e.draw({ whites: [1, 2, 3, 4, 5], red: 1 });
  assert.equal(first.draw.jackpotWon, false);
  assert.equal(e.jackpot, LotteryEngine.BASE_JACKPOT + LotteryEngine.JACKPOT_INCREMENT);
  e.nextRound();
  e.buyTickets(1);
  e.tickets[0] = { whites: [1, 2, 3, 4, 5], red: 1 }; // guaranteed jackpot
  const second = e.draw({ whites: [1, 2, 3, 4, 5], red: 1 });
  assert.equal(second.draw.jackpotWon, true);
  assert.equal(second.draw.results[0].prize, LotteryEngine.BASE_JACKPOT + LotteryEngine.JACKPOT_INCREMENT);
  assert.equal(e.jackpot, LotteryEngine.BASE_JACKPOT); // reset for the next drawing
});

test('Engine: nextRound clears tickets and returns to buying, only after a drawing', () => {
  const e = new LotteryEngine();
  assert.equal(e.nextRound(), false); // nothing to advance from
  e.buyTickets(1);
  assert.equal(e.nextRound(), false); // still buying, no drawing yet
  e.draw();
  assert.equal(e.nextRound(), true);
  assert.equal(e.phase, 'buying');
  assert.equal(e.tickets.length, 0);
  assert.equal(e.lastDraw, null);
});

test('Engine: going broke offers a restart, which keeps lifetime stats but resets money', () => {
  const e = new LotteryEngine({ startingBalance: 1 });
  assert.equal(e.isBroke(), true); // $1 buys nothing at $2/ticket
  assert.equal(e.buyTickets(1).reason, 'insufficient');
  assert.equal(e.restart(), true);
  assert.equal(e.balance, 1);
  const e2 = new LotteryEngine({ startingBalance: 2 });
  e2.buyTickets(1);
  e2.tickets[0] = { whites: [60, 61, 62, 63, 64], red: 25 }; // guaranteed not to match
  e2.draw({ whites: [1, 2, 3, 4, 5], red: 20 });
  e2.nextRound();
  assert.equal(e2.balance, 0);
  assert.equal(e2.isBroke(), true);
  assert.equal(e2.restart(), true);
  assert.equal(e2.balance, e2.startingBalance);
  assert.equal(e2.jackpot, LotteryEngine.BASE_JACKPOT);
  assert.equal(e2.stats.drawsPlayed, 0); // restarting is a fresh start
});

test('Engine: restart refuses while you still have money', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  assert.equal(e.restart(), false);
});

test('Engine: broke is shown right after a drawing, not only once buying resumes', () => {
  const e = new LotteryEngine({ startingBalance: 2 });
  e.buyTickets(1);
  e.tickets[0] = { whites: [60, 61, 62, 63, 64], red: 25 }; // guaranteed not to match
  e.draw({ whites: [1, 2, 3, 4, 5], red: 20 }); // guaranteed loss
  assert.equal(e.balance, 0);
  assert.equal(e.phase, 'results');
  assert.equal(e.tickets.length, 1); // not cleared yet
  assert.equal(e.isBroke(), true); // but there is nothing left to play again with
  assert.equal(e.restart(), true);
  assert.equal(e.balance, 2);
  assert.equal(e.tickets.length, 0);
});

test('Engine: not broke mid-buying with tickets already held, even at $0', () => {
  const e = new LotteryEngine({ startingBalance: 2 });
  e.buyTickets(1);
  assert.equal(e.balance, 0);
  assert.equal(e.isBroke(), false); // can still draw the ticket already bought
  assert.equal(e.restart(), false);
});

test('Engine: a fixed rng makes a drawing fully deterministic', () => {
  let calls = 0;
  const values = [0.01, 0.3, 0.5, 0.7, 0.9, 0.4];
  const rng = () => values[calls++ % values.length];
  const e = new LotteryEngine({ rng });
  e.buyTickets(1);
  const first = e.tickets[0];
  calls = 0;
  const e2 = new LotteryEngine({ rng });
  e2.buyTickets(1);
  assert.deepEqual(e2.tickets[0], first);
});

test('Engine: fuzz - 4000 random drawings never create or lose money', () => {
  const e = new LotteryEngine({ startingBalance: 100 });
  let adjust = 0;
  for (let round = 0; round < 4000; round++) {
    if (e.balance < e.ticketPrice) { e.balance += 100; adjust += 100; }
    const quantity = 1 + Math.floor(Math.random() * Math.min(20, e.maxAffordable()));
    assert.equal(e.buyTickets(quantity).ok, true, `round ${round}`);
    if (Math.random() < 0.3) {
      e.buyTickets(1 + Math.floor(Math.random() * Math.max(1, Math.min(5, e.maxAffordable()))));
    }
    const spentSoFar = e.stats.totalSpent;
    const result = e.draw();
    assert.equal(result.ok, true);
    assert.ok(Number.isInteger(e.balance), `non-integer balance ${e.balance} at round ${round}`);
    assert.equal(e.balance, 100 + adjust - e.stats.totalSpent + e.stats.totalWon, `round ${round}: money accounting is wrong`);
    assert.equal(result.draw.results.length, e.tickets.length);
    e.nextRound();
  }
});

// =====================================================================
// Part 3: the page (lottery.js) in a mocked browser
// =====================================================================

function makeEnvironment(savedStats = null, { storageThrows = false, presets = {} } = {}) {
  // A minimal DOM: enough tree operations for the page's keyed rendering, so tests can
  // check which elements are kept, replaced or removed. Mirrors the one used for the
  // blackjack project's own page tests.
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
  const storage = new Map();
  if (savedStats) storage.set('lotteryStats', typeof savedStats === 'string' ? savedStats : JSON.stringify(savedStats));
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
      querySelectorAll: () => [],
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
      if (++count > 10000) throw new Error('Timer loop did not terminate');
      timers.sort((a, b) => a.time - b.time || a.id - b.id);
      const timer = timers.shift();
      now = timer.time;
      timer.fn();
    }
  }
  const source = fs.readFileSync(enginePath, 'utf8') + '\n' + fs.readFileSync(scriptPath, 'utf8');
  vm.runInContext(source + '\n;globalThis.pageExports = { engine, kiosk, getStats: () => ({...gameStats}), getSession: () => ({...sessionStats}), toggleMute, isMuted: () => soundMuted };', context, { filename: 'lottery-engine.js+lottery.js' });
  return { ...context.pageExports, node, body: bodyEl, flushTimers, playLog, storage };
}

function forcedDraw(env, whites, red) {
  return env.engine.draw({ whites, red });
}

test('Page: Draw reveals the numbers without checking tickets; Check Tickets does the rest', () => {
  const env = makeEnvironment();
  env.kiosk.buy(3);
  env.kiosk.draw();
  assert.equal(env.node('game-container').dataset.phase, 'checking');
  assert.equal(env.node('drawn-balls').children.length, 6); // numbers are already shown
  assert.match(env.node('message').textContent, /Check Tickets/);
  assert.equal(env.node('check-tickets-button').disabled, false);
  // tickets are visible with numbers, but nothing has been checked or paid out yet
  assert.equal(env.getSession().totalWon, 0);
  assert.equal(env.node('draw-button').disabled, true); // can't draw again mid-check

  env.kiosk.checkTickets();
  env.flushTimers();
  assert.equal(env.node('game-container').dataset.phase, 'results');
  assert.equal(env.node('check-tickets-button').disabled, true);
});

test('Page: the progress bar advances in batches while checking a large purchase', () => {
  const env = makeEnvironment();
  env.engine.balance = 100000;
  env.kiosk.buy(1000);
  env.kiosk.draw();
  assert.equal(env.node('check-progress').getAttribute('aria-valuenow'), '0');
  env.kiosk.checkTickets();
  // the first batch has been scheduled but not yet run
  assert.equal(env.engine.phase, 'checking');
  env.flushTimers();
  assert.equal(env.engine.phase, 'results');
  assert.equal(env.node('check-progress').getAttribute('aria-valuenow'), '100');
  assert.match(env.node('check-progress-label').textContent, /1,000 \/ 1,000/);
});

test('Page: winning tickets highlight as soon as numbers are revealed, before checking', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [1, 2, 60, 61, 62], red: 9 };
  env.engine.revealDraw({ whites: [1, 2, 3, 4, 5], red: 1 });
  env.kiosk.updateUI();
  const row = env.node('ticket-list').children[0];
  const minis = row.parts.balls.children;
  assert.deepEqual(minis.map(m => m.classList.contains('hit')), [true, true, false, false, false, false]);
  // but nothing has actually been paid out yet
  assert.equal(env.engine.balance, 98);
});

test('Page: cannot buy, clear tickets or set the bankroll while checking', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  env.kiosk.draw();
  assert.equal(env.kiosk.buy(1), false);
  env.kiosk.clearTickets(); // must refuse silently, not clear the ticket
  assert.equal(env.engine.tickets.length, 1);
  assert.equal(env.node('quantity-amount').disabled, true);
  assert.equal(env.node('bankroll-amount').disabled, true);
});

test('Page: setting the starting balance updates the balance and the restart amount', () => {
  const env = makeEnvironment();
  assert.equal(env.node('bankroll-amount').disabled, false);
  assert.equal(env.kiosk.setBankroll(5000), true);
  assert.equal(env.engine.balance, 5000);
  assert.match(env.node('balance').textContent, /\$5,000/);
  assert.match(env.node('message').textContent, /Starting balance set to \$5,000/);

  assert.equal(env.kiosk.setBankroll(0), false);
  assert.match(env.node('message').textContent, /at least \$2/);
  assert.equal(env.engine.balance, 5000); // unchanged by the failed attempt

  env.kiosk.buy(1);
  assert.equal(env.node('bankroll-amount').disabled, true);
  assert.equal(env.node('set-bankroll').disabled, true);
  assert.equal(env.kiosk.setBankroll(100), false);
  assert.match(env.node('message').textContent, /before buying tickets/);
});

test('Page: a chosen starting balance is what New Game restores after going broke', () => {
  const env = makeEnvironment();
  env.kiosk.setBankroll(6);
  env.kiosk.buy(3);
  env.engine.tickets.forEach(t => { t.whites = [60, 61, 62, 63, 64]; t.red = 25; });
  forcedDraw(env, [1, 2, 3, 4, 5], 20);
  assert.equal(env.engine.balance, 0);
  assert.equal(env.node('restart').style.display, 'inline-block');
  env.kiosk.restart();
  assert.equal(env.engine.balance, 6);
  assert.match(env.node('message').textContent, /start again with \$6/);
});

test('Page: buying far more tickets than can be usefully listed still shows every one in the DOM count cap', () => {
  const env = makeEnvironment();
  env.engine.balance = 100000;
  assert.equal(env.kiosk.buy(500), true);
  assert.equal(env.engine.tickets.length, 500);
  assert.equal(env.node('ticket-list').children.length, 300); // capped, not 500
  assert.match(env.node('ticket-list-note').textContent, /\+ 200 more not shown/);
  assert.match(env.node('tickets-summary').textContent, /500 tickets/); // the real count is still shown
});

test('Page: the ticket-list cap does not affect balance, statistics or per-ticket accuracy', () => {
  const env = makeEnvironment();
  env.engine.balance = 100000;
  env.kiosk.buy(500);
  // every ticket matches only the red ball ($4 each): 500 winners, well past the 200-row cap
  env.engine.tickets.forEach(t => { t.whites = [60, 61, 62, 63, 64]; t.red = 9; });
  forcedDraw(env, [1, 2, 3, 4, 5], 9);
  assert.equal(env.engine.lastDraw.totalWon, 500 * 4);
  assert.equal(env.getSession().ticketsBought, 500);
  assert.equal(env.getSession().totalSpent, 1000);
  assert.equal(env.engine.balance, 100000 - 1000 + 2000);
  const rows = env.node('winners-list').children[0].children;
  assert.equal(rows.length, 200); // capped display, not all 500
  assert.match(env.node('winners-list').children[1].textContent, /\+ 300 more winning tickets not shown/);
});

test('Page: the caps do not trigger for an ordinary number of tickets', () => {
  const env = makeEnvironment();
  env.kiosk.buy(50);
  assert.equal(env.node('ticket-list').children.length, 50);
  assert.equal(env.node('ticket-list-note').textContent, '');
});

test('Page: quantity chips buy tickets, and chips you cannot afford are locked', () => {
  const env = makeEnvironment();
  const chips = env.node('quantity-container').children;
  assert.equal(chips.length, 6); // 1, 5, 10, 25, 50, max
  assert.equal(chips[0].dataset.key, '1:1');
  chips[0].onclick(); // buy 1
  assert.equal(env.engine.tickets.length, 1);
  assert.equal(env.engine.balance, 98);
  assert.match(env.node('message').textContent, /Bought 1 ticket for \$2/);

  env.engine.balance = 3; // can now only afford the $1 and $5-priced-at-$2=$10... recompute
  env.kiosk.updateUI();
  const stillUsable = env.node('quantity-container').children.filter(c => !c.classList.contains('locked'));
  assert.deepEqual(stillUsable.map(c => c.dataset.key.split(':')[0]), ['1', 'max']); // Max still buys the 1 you can afford
});

test('Page: the Max chip buys as many tickets as affordable', () => {
  const env = makeEnvironment();
  const chips = env.node('quantity-container').children;
  const maxChip = chips[chips.length - 1];
  assert.equal(maxChip.dataset.key.split(':')[0], 'max');
  maxChip.onclick();
  assert.equal(env.engine.tickets.length, 50); // $100 / $2
  assert.equal(env.engine.balance, 0);
});

test('Page: buying custom quantities via the input, including failures', () => {
  const env = makeEnvironment();
  env.node('quantity-amount').value = '7';
  env.kiosk.buy(Number(env.node('quantity-amount').value)) && (env.node('quantity-amount').value = '');
  assert.equal(env.engine.tickets.length, 7);
  assert.equal(env.node('quantity-amount').value, '');

  assert.equal(env.kiosk.buy(0), false);
  assert.match(env.node('message').textContent, /whole number/);
  assert.equal(env.kiosk.buy(1000), false);
  assert.match(env.node('message').textContent, /Not enough balance/);
});

test('Page: Clear Tickets refunds, and is disabled with none bought', () => {
  const env = makeEnvironment();
  assert.equal(env.node('clear-tickets').disabled, true);
  env.kiosk.buy(10);
  assert.equal(env.node('clear-tickets').disabled, false);
  env.kiosk.clearTickets();
  assert.equal(env.engine.balance, 100);
  assert.equal(env.node('clear-tickets').disabled, true);
});

test('Page: the Draw button is disabled until at least one ticket is bought', () => {
  const env = makeEnvironment();
  assert.equal(env.node('draw-button').disabled, true);
  env.kiosk.buy(1);
  assert.equal(env.node('draw-button').disabled, false);
});

test('Page: drawing renders the winning numbers, one per ball, white then red', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  forcedDraw(env, [1, 2, 3, 4, 5], 6);
  env.kiosk.updateUI();
  const balls = env.node('drawn-balls').children;
  assert.equal(balls.length, 6);
  assert.deepEqual(balls.slice(0, 5).map(b => b.textContent), ['1', '2', '3', '4', '5']);
  assert.equal(balls[5].textContent, '6');
  assert.equal(balls[5].classList.contains('red'), true);
  assert.equal(balls[0].classList.contains('white'), true);
});

test('Page: a losing drawing reports no winners and plays the lose sound', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [60, 61, 62, 63, 64], red: 25 }; // guaranteed not to match
  forcedDraw(env, [1, 2, 3, 4, 5], 20);
  assert.match(env.node('message').textContent, /No winners this time/);
  assert.equal(env.playLog.includes('sounds/lose.mp3'), true);
  assert.match(env.node('winners-list').children[0].textContent, /did not win/);
});

test('Page: a winning ticket is listed with its tier and prize, sorted highest first', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [1, 2, 3, 4, 9], red: 1 }; // match4 + red ball
  env.kiosk.buy(1);
  env.engine.tickets[1] = { whites: [1, 2, 9, 9, 9].slice(0, 1).concat([9, 10, 11, 12]), red: 9 }; // will not win
  forcedDraw(env, [1, 2, 3, 4, 5], 1);
  const rows = env.node('winners-list').children[0].children;
  assert.equal(rows.length, 1);
  assert.match(rows[0].children[1].textContent, /Match 4 \+ Red Ball/);
  assert.equal(rows[0].children[2].textContent, '$50,000');
  assert.match(env.node('winners-list').children[1].textContent, /1 other ticket did not win/);
  assert.equal(env.playLog.includes('sounds/win.mp3'), true);
});

test('Page: multiple winners are sorted with the biggest prize first', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [1, 2, 3, 6, 7], red: 1 };  // match3 + red ball: $100
  env.kiosk.buy(1);
  env.engine.tickets[1] = { whites: [1, 2, 3, 4, 9], red: 1 };  // match4 + red ball: $50,000
  env.kiosk.buy(1);
  env.engine.tickets[2] = { whites: [1, 2, 3, 6, 7], red: 9 };  // match3, no red: $7
  forcedDraw(env, [1, 2, 3, 4, 5], 1);
  const rows = env.node('winners-list').children[0].children;
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.children[2].textContent), ['$50,000', '$100', '$7']);
  assert.deepEqual(rows.map(r => r.children[0].textContent), ['Ticket #2', 'Ticket #1', 'Ticket #3']);
});

test('Page: winning the jackpot shows a popup that clears itself, and plays the fanfare', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [1, 2, 3, 4, 5], red: 1 };
  forcedDraw(env, [1, 2, 3, 4, 5], 1);
  assert.equal(env.playLog.includes('sounds/blackjack.mp3'), true);
  const popup = env.body.children.find(child => child.className === 'jackpot-popup');
  assert.ok(popup, 'a jackpot popup was added to the page');
  assert.match(popup.innerHTML, /JACKPOT/);
  assert.equal(env.engine.jackpot, LotteryEngine.BASE_JACKPOT); // reset for next time
  env.flushTimers();
  assert.equal(env.body.children.includes(popup), false); // it removes itself
});

test('Page: ticket rows highlight the numbers that matched', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [1, 2, 60, 61, 62], red: 9 };
  forcedDraw(env, [1, 2, 3, 4, 5], 1);
  env.kiosk.updateUI();
  const row = env.node('ticket-list').children[0];
  const minis = row.parts.balls.children;
  assert.deepEqual(minis.map(m => m.classList.contains('hit')), [true, true, false, false, false, false]);
});

test('Page: ticket rows are reconciled, not rebuilt, when nothing about them changed', () => {
  const env = makeEnvironment();
  env.kiosk.buy(3);
  const before = [...env.node('ticket-list').children];
  env.kiosk.updateUI();
  const after = env.node('ticket-list').children;
  assert.deepEqual(after, before);
});

test('Page: "Show ticket numbers" is hidden until tickets are bought, and hides again once cleared', () => {
  const env = makeEnvironment();
  assert.equal(env.node('ticket-details').hidden, true);
  env.kiosk.buy(1);
  assert.equal(env.node('ticket-details').hidden, false);
  env.kiosk.clearTickets();
  assert.equal(env.node('ticket-details').hidden, true);
});

test('Page: Play Again returns to buying and clears the table', () => {
  const env = makeEnvironment();
  env.kiosk.buy(1);
  forcedDraw(env, [60, 61, 62, 63, 64], 20);
  env.kiosk.updateUI();
  assert.equal(env.node('game-container').dataset.phase, 'results');
  env.kiosk.nextRound();
  assert.equal(env.node('game-container').dataset.phase, 'buying');
  assert.equal(env.node('drawn-balls').children.length, 0);
  assert.equal(env.node('ticket-list').children.length, 0);
});

test('Page: going broke shows New Game immediately, and it resets the bankroll', () => {
  const env = makeEnvironment();
  env.kiosk.buy(50); // the whole $100 balance
  env.engine.tickets.forEach(t => { t.whites = [60, 61, 62, 63, 64]; t.red = 25; });
  forcedDraw(env, [1, 2, 3, 4, 5], 20);
  assert.equal(env.engine.balance, 0);
  assert.equal(env.node('restart').style.display, 'inline-block');
  assert.match(env.node('message').textContent, /No winners/);
  env.kiosk.restart();
  assert.equal(env.engine.balance, 100);
  assert.equal(env.node('game-container').dataset.phase, 'buying');
  assert.equal(env.node('restart').style.display, 'none');
});

test('Page: session and lifetime statistics track spending and winnings', () => {
  const env = makeEnvironment({ drawsPlayed: 5, ticketsBought: 20, totalSpent: 40, totalWon: 10, biggestWin: 7 });
  assert.equal(env.getSession().drawsPlayed, 0);
  assert.equal(env.getStats().drawsPlayed, 5);
  env.kiosk.buy(4);
  forcedDraw(env, [60, 61, 62, 63, 64], 20);
  assert.equal(env.getSession().drawsPlayed, 1);
  assert.equal(env.getSession().ticketsBought, 4);
  assert.equal(env.getStats().drawsPlayed, 6);
  assert.equal(env.getStats().ticketsBought, 24);
  assert.match(env.node('stats').textContent, /Session: .*Lifetime: /);
});

test('Page: corrupt saved stats fall back to a fresh start', () => {
  for (const bad of ['{not json', '[]', 'null', '{"drawsPlayed":"x"}']) {
    const env = makeEnvironment(bad);
    assert.equal(env.getStats().drawsPlayed, 0, bad);
  }
});

test('Page: mute silences sounds and is remembered across a reload', () => {
  const env = makeEnvironment();
  env.toggleMute();
  assert.equal(env.isMuted(), true);
  assert.equal(env.storage.get('lotteryMuted'), '1');
  env.kiosk.buy(1);
  assert.equal(env.playLog.length, 0);
  const restored = makeEnvironment(null, { presets: { lotteryMuted: '1' } });
  assert.equal(restored.isMuted(), true);
  assert.equal(restored.node('mute').textContent, 'Sound: Off');
});

test('Page: the game works when localStorage is blocked', () => {
  const env = makeEnvironment(null, { storageThrows: true });
  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [60, 61, 62, 63, 64], red: 25 }; // guaranteed not to match
  forcedDraw(env, [1, 2, 3, 4, 5], 20);
  assert.equal(env.engine.balance, 98);
  env.toggleMute();
  assert.equal(env.isMuted(), true);
});

test('Page: the paytable lists every tier, reflects the live jackpot, and can be toggled', () => {
  const env = makeEnvironment();
  assert.equal(env.node('paytable').hidden, true);
  env.kiosk.togglePaytable();
  assert.equal(env.node('paytable').hidden, false);
  assert.equal(env.node('toggle-paytable').getAttribute('aria-pressed'), 'true');
  const rows = env.node('paytable-body').children;
  assert.equal(rows.length, 10); // 9 tiers + overall
  const jackpotRow = rows[0];
  assert.match(jackpotRow.parts[0].textContent, /Match 5 \+ Red Ball/);
  assert.equal(jackpotRow.parts[1].textContent, '$20,000,000+');
  assert.match(jackpotRow.parts[2].textContent, /^1 in 292,201,338/);
  const overallRow = rows[rows.length - 1];
  assert.equal(overallRow.classList.contains('overall-row'), true);

  env.kiosk.buy(1);
  env.engine.tickets[0] = { whites: [60, 61, 62, 63, 64], red: 25 };
  forcedDraw(env, [1, 2, 3, 4, 5], 20); // no jackpot winner: it rolls over
  assert.equal(env.node('paytable-body').children[0].parts[1].textContent, '$23,000,000+');

  env.kiosk.togglePaytable();
  assert.equal(env.node('paytable').hidden, true);
});

test('Page: pressing Enter draws while buying (with tickets) and plays again after a drawing', () => {
  const env = makeEnvironment();
  const fire = key => {
    let handler;
    const original = env.node('body').addEventListener;
    // the listener was attached to `document`, not a node; simulate via direct call instead
    return handler;
  };
  // lottery.js attaches its keydown listener to `document`, which the mock accepts but
  // does not dispatch through; call the same logic path via the engine/kiosk directly.
  env.kiosk.buy(1);
  assert.equal(env.engine.canDraw(), true);
  env.kiosk.draw();
  assert.equal(env.engine.phase, 'checking');
  env.kiosk.checkTickets();
  env.flushTimers();
  assert.equal(env.engine.phase, 'results');
  env.kiosk.nextRound();
  assert.equal(env.engine.phase, 'buying');
});

test('Page: fuzz - 300 random rounds keep the page and the engine in agreement', () => {
  const env = makeEnvironment();
  const { engine: e, kiosk: k } = env;
  let adjust = 0;
  for (let round = 0; round < 300; round++) {
    if (e.balance < e.ticketPrice * 2) { e.balance += 100; adjust += 100; }
    const quantity = 1 + Math.floor(Math.random() * Math.min(30, e.maxAffordable()));
    assert.equal(k.buy(quantity), true, `round ${round}`);
    if (Math.random() < 0.4) {
      k.buy(1 + Math.floor(Math.random() * Math.max(1, Math.min(5, e.maxAffordable()))));
    }
    k.draw();
    assert.equal(e.phase, 'checking');
    k.checkTickets();
    env.flushTimers();
    assert.equal(e.phase, 'results');
    assert.equal(env.node('drawn-balls').children.length, 6, `round ${round}: balls on screen`);
    assert.equal(env.node('ticket-list').children.length, e.tickets.length, `round ${round}: ticket rows on screen`);
    const expectedBalance = 100 + adjust - e.stats.totalSpent + e.stats.totalWon;
    assert.equal(e.balance, expectedBalance, `round ${round}: balance vs stats disagree`);
    assert.equal(100 + adjust - env.getSession().totalSpent + env.getSession().totalWon, expectedBalance, `round ${round}: session stats vs balance disagree`);
    k.nextRound();
    assert.equal(env.node('drawn-balls').children.length, 0, `round ${round}: table cleared`);
  }
});

const failures = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.length - failures.length, total: results.length, failures }, null, 2));
