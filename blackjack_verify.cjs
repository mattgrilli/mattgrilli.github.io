'use strict';

// Checks for the blackjack game. Run with:  node blackjack_verify.cjs
//
// Part 1 tests the rules engine (engine.js) directly in plain Node, with no browser.
// Part 2 loads engine.js and script.js into a mocked browser to check the page wiring:
// messages, statistics, sounds, storage and the like.
//
// (blackjack_audit.cjs is a separate script that reproduces the ORIGINAL bugs.)

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const dir = process.argv[2] ? path.resolve(process.argv[2]) : __dirname;
const enginePath = path.join(dir, 'engine.js');
const scriptPath = path.join(dir, 'script.js');
const Engine = require(enginePath);
const { BlackjackEngine, Deck, getBasicStrategyAction } = Engine;

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); process.exitCode = 1; }
}

const SUITS = ['♠', '♥', '♦', '♣'];
function stack(engine, values) {
  // The first value in the list is the next card dealt.
  engine.deck.cards = values.map((value, index) => ({ value, suit: SUITS[index % 4] })).reverse();
  engine.deck.cutAtCardsRemaining = -1; // keep tiny test shoes from being reshuffled
  engine.deck.reshuffleNeeded = false;
}
function record(engine) {
  const events = [];
  engine.subscribe(event => events.push(event));
  return events;
}
function dealt(values, bet = 100, options) {
  const engine = new BlackjackEngine(options);
  stack(engine, values);
  assert.equal(engine.placeBet(bet).ok, true);
  engine.deal();
  return engine;
}
const cardsOf = values => values.map(value => ({ value, suit: '♠' }));
const strategy = (values, up, options) => getBasicStrategyAction(cardsOf(values), up, options);

// =====================================================================
// Part 1: the rules engine
// =====================================================================

test('Engine: bets are locked once cards are dealt', () => {
  const e = dealt(['10', '10', 'K', '8']);
  assert.deepEqual(e.clearBet(), { ok: false, reason: 'locked' });
  assert.deepEqual(e.removeBet(100), { ok: false, reason: 'locked' });
  assert.deepEqual(e.placeBet(5), { ok: false, reason: 'locked' });
  e.stand(0);
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.player.balance, 1100);
});

test('Engine: bets cannot be changed after a settled win either', () => {
  const e = dealt(['10', '10', 'K', '8']);
  e.stand(0);
  assert.equal(e.clearBet().ok, false);
  assert.equal(e.player.balance, 1100);
});

test('Engine: betting, clearing and removing chips', () => {
  const e = new BlackjackEngine();
  assert.equal(e.placeBet(100).ok, true);
  assert.equal(e.placeBet(25).ok, true);
  assert.equal(e.player.balance, 875);
  assert.equal(e.removeBet(100).ok, true);
  assert.equal(e.currentBet, 25);
  assert.equal(e.removeBet(500).reason, 'nothing');
  assert.equal(e.clearBet().ok, true);
  assert.equal(e.player.balance, 1000);
  assert.equal(e.placeBet(1001).reason, 'insufficient');
  assert.equal(e.placeBet(2.5).reason, 'invalid');
  assert.equal(e.beginDeal().reason, 'nobet');
});

test('Engine: Set Bet replaces the pot with an exact amount broken into chips', () => {
  const e = new BlackjackEngine();
  assert.equal(e.setBet(137).ok, true);
  assert.equal(e.currentBet, 137);
  assert.equal(e.player.balance, 863);
  assert.equal(e.chipsInPot.reduce((a, b) => a + b, 0), 137);
  assert.equal(e.setBet(50).ok, true); // replaces, refunding the old pot first
  assert.equal(e.player.balance, 950);
  assert.equal(e.setBet(1000).ok, true);
  assert.equal(e.player.balance, 0);
  for (const bad of [0, -5, 2.5, NaN]) assert.equal(e.setBet(bad).reason, 'invalid');
  assert.equal(e.setBet(1001).reason, 'insufficient');
});

test('Engine: Rebet repeats the previous wager and cannot double the bet', () => {
  const e = dealt(['10', '10', 'K', '8']);
  e.stand(0);
  e.prepareNextHand();
  assert.equal(e.canRebet(), true);
  assert.equal(e.rebet().ok, true);
  assert.equal(e.rebet().ok, true);
  assert.equal(e.currentBet, 100);
  assert.equal(e.player.balance, 1100 - 100);
  assert.equal(new BlackjackEngine().rebet().reason, 'nothing');
});

test('Engine: Rebet is unavailable when the last wager is no longer affordable', () => {
  const e = dealt(['6', '10', '7', '9'], 600);
  e.stand(0); // loses 600
  e.prepareNextHand();
  assert.equal(e.canRebet(), false);
});

test('Engine: the deal produces the four opening cards in order', () => {
  const e = new BlackjackEngine();
  stack(e, ['10', '9', '8', '7']);
  const events = record(e);
  e.placeBet(100);
  e.deal();
  const cards = events.filter(ev => ev.type === 'cardDealt');
  assert.deepEqual(cards.map(c => [c.target, c.card.value, c.faceUp]),
    [['player', '10', true], ['dealer', '9', true], ['player', '8', true], ['dealer', '7', false]]);
});

test('Engine: staged dealing keeps the phase at "dealing" until beginPlay', () => {
  const e = new BlackjackEngine();
  stack(e, ['10', '9', '8', '7']);
  e.placeBet(100);
  assert.equal(e.beginDeal().ok, true);
  assert.equal(e.gamePhase, 'dealing');
  assert.equal(e.dealInitialCards().length, 4);
  assert.equal(e.gamePhase, 'dealing');
  assert.equal(e.canHit(), false);
  e.beginPlay();
  assert.equal(e.gamePhase, 'playerTurn');
});

test('Engine: surrender refunds half and reports the real loss', () => {
  const e = new BlackjackEngine();
  stack(e, ['10', '9', '6', '8']);
  const events = record(e);
  e.placeBet(100);
  e.deal();
  assert.equal(e.surrender(), true);
  assert.equal(e.player.balance, 950);
  const settled = events.find(ev => ev.type === 'settled');
  assert.equal(settled.outcome, 'surrender');
  assert.equal(settled.wager, 100);
  assert.equal(settled.net, -50);
  assert.equal(e.gamePhase, 'gameOver');
});

test('Engine: busting one split hand lets the other hand play and settle', () => {
  const e = new BlackjackEngine();
  stack(e, ['8', '10', '8', '7', '10', '9', 'K']);
  const events = record(e);
  e.placeBet(100);
  e.deal();
  assert.equal(e.split(0), true);
  assert.equal(e.player.hands[0].getScore(), 18);
  assert.equal(e.player.hands[1].getScore(), 17);
  e.hit(0); // K -> bust
  assert.equal(e.gamePhase, 'playerTurn');
  assert.equal(e.currentHandIndex, 1);
  assert.equal(e.player.hands[0].settled, true);
  assert.equal(e.player.hands[1].settled, false);
  e.stand(1); // dealer holds 17 -> push
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.player.hands[1].result, 'push');
  assert.equal(e.player.balance, 900);
  assert.equal(events.filter(ev => ev.type === 'settled').length, 2);
});

test('Engine: if every split hand busts the dealer never draws', () => {
  const e = dealt(['8', '10', '8', '7', '10', '10', 'K', 'Q']);
  e.split(0);
  e.hit(0);
  assert.equal(e.gamePhase, 'playerTurn');
  e.hit(1);
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.dealer.cards.length, 2);
  assert.equal(e.player.balance, 800);
});

test('Engine: surrender is not available after splitting', () => {
  const e = dealt(['8', '10', '8', '7', '10', '9']);
  assert.equal(e.canSurrender(), true);
  e.split(0);
  assert.equal(e.canSurrender(), false);
  assert.equal(e.surrender(), false);
});

test('Engine: insurance is offered before the dealer blackjack is revealed', () => {
  const e = dealt(['10', 'A', '9', 'K']);
  assert.equal(e.gamePhase, 'insurance');
  assert.equal(e.canInsurance(), true);
  assert.equal(e.player.balance, 900);
});

test('Engine: winning insurance pays 2:1 and cannot be bought twice', () => {
  const e = new BlackjackEngine();
  stack(e, ['10', 'A', '9', 'K']);
  const events = record(e);
  e.placeBet(100);
  e.deal();
  assert.equal(e.buyInsurance(), true);
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.player.balance, 1000); // -100 hand, +100 insurance
  assert.equal(events.find(ev => ev.type === 'insuranceSettled').net, 100);
  assert.equal(e.buyInsurance(), false);
  assert.equal(e.player.balance, 1000);
});

test('Engine: declining insurance against a dealer blackjack loses the hand only', () => {
  const e = dealt(['10', 'A', '9', 'K']);
  assert.equal(e.declineInsurance(), true);
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.player.balance, 900);
});

test('Engine: losing insurance is charged once and cannot be bought again', () => {
  const e = new BlackjackEngine();
  stack(e, ['10', 'A', '9', '7']);
  const events = record(e);
  e.placeBet(100);
  e.deal();
  e.buyInsurance();
  assert.equal(e.player.balance, 850);
  assert.equal(e.gamePhase, 'playerTurn');
  assert.equal(e.canInsurance(), false);
  assert.equal(e.buyInsurance(), false);
  assert.equal(e.player.balance, 850);
  assert.equal(e.player.insurance, 0);
  assert.equal(events.find(ev => ev.type === 'insuranceSettled').net, -50);
});

test('Engine: insurance uses whole dollars and is not offered on a $1 bet', () => {
  const small = dealt(['10', 'A', '9', '7', '2'], 1);
  assert.equal(small.gamePhase, 'playerTurn');
  assert.equal(small.canInsurance(), false);
  const odd = dealt(['10', 'A', '9', 'K'], 5);
  odd.buyInsurance(); // stake $2 pays +$4; the hand loses $5
  assert.equal(odd.player.balance, 999);
  assert.ok(Number.isInteger(odd.player.balance));
});

test('Engine: dealer peeks with a ten or Ace showing', () => {
  const tenUp = new BlackjackEngine();
  stack(tenUp, ['9', '10', '7', 'A']);
  const events = record(tenUp);
  tenUp.placeBet(100);
  tenUp.deal();
  const check = events.find(ev => ev.type === 'openingChecked');
  assert.deepEqual([check.peeked, check.dealerBlackjack, check.playerBlackjack], [true, true, false]);
  assert.equal(tenUp.gamePhase, 'gameOver'); // no chance to act, and no insurance for a ten
  assert.equal(tenUp.player.balance, 900);

  const sixUp = new BlackjackEngine();
  stack(sixUp, ['9', '6', '7', '10', '2']);
  const events2 = record(sixUp);
  sixUp.placeBet(100);
  sixUp.deal();
  assert.equal(events2.find(ev => ev.type === 'openingChecked').peeked, false);
  assert.equal(sixUp.gamePhase, 'playerTurn');
});

test('Engine: the Split button and the split action agree on unlike face cards', () => {
  const e = dealt(['J', '9', 'Q', '8']);
  assert.equal(e.canSplit(), false);
  assert.equal(e.player.hands[0].canSplit(), false);
  assert.equal(e.split(0), false);
  assert.equal(e.player.hands.length, 1);
  assert.equal(e.player.balance, 900);
});

test('Engine: splitting works for matching ranks and is capped at four hands', () => {
  const e = dealt(['8', '10', '8', '7', '8', '8', '8', '8', '8', '8', '8', '8'], 10);
  assert.equal(e.canSplit(), true);
  e.split(0);
  e.split(0);
  e.split(0);
  assert.equal(e.player.hands.length, 4);
  assert.equal(e.canSplit(0), false);
});

test('Engine: the cut card is measured in cards remaining, in the last quarter', () => {
  for (let i = 0; i < 200; i++) {
    const deck = new Deck(6);
    assert.ok(deck.cutAtCardsRemaining >= 20 && deck.cutAtCardsRemaining <= 78, `cut ${deck.cutAtCardsRemaining}`);
  }
  const deck = new Deck(6);
  deck.cutAtCardsRemaining = 50;
  let draws = 0;
  while (!deck.needsReshuffle()) { deck.deal(); draws++; }
  assert.equal(draws, 263); // 312 - 50 cards dealt, +1 for the card that trips it
  assert.equal(deck.cardsRemaining(), 49);
});

test('Engine: reaching the cut card reshuffles the shoe after the round', () => {
  const e = new BlackjackEngine();
  stack(e, ['10', '10', 'K', '8']);
  e.deck.cutAtCardsRemaining = 100; // the tiny stacked shoe is already past the cut card
  const events = record(e);
  e.placeBet(100);
  e.deal();
  assert.equal(events.filter(ev => ev.type === 'cutCard').length, 1);
  assert.equal(events.some(ev => ev.type === 'reshuffled'), false); // not mid-round
  e.stand(0);
  assert.equal(events.filter(ev => ev.type === 'reshuffled').length, 1);
  assert.equal(e.deck.cardsRemaining(), 312);
});

test('Engine: a hand settles only once', () => {
  const e = dealt(['10', '10', 'K', '8']);
  const events = record(e);
  e.stand(0);
  e.determineWinner();
  e.determineWinner();
  assert.equal(e.player.balance, 1100);
  assert.equal(events.filter(ev => ev.type === 'settled').length, 1);
  assert.equal(e.player.settle(0, 'win'), null);
});

test('Engine: payouts are whole dollars (blackjack 3:2 rounded down, surrender rounded up)', () => {
  const bj = dealt(['A', '10', 'K', '9'], 100);
  assert.equal(bj.gamePhase, 'gameOver');
  assert.equal(bj.player.balance, 1150);
  const odd = dealt(['A', '10', 'K', '9'], 5);
  assert.equal(odd.player.balance, 1007);
  const sur = dealt(['10', '9', '6', '8'], 5);
  sur.surrender();
  assert.equal(sur.player.balance, 998);
});

test('Engine: double down doubles the wager, takes one card, and pays double', () => {
  const e = dealt(['5', '10', '6', '7', 'K']);
  assert.equal(e.canDouble(), true);
  assert.equal(e.doubleDown(0), true);
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.player.balance, 1200);
});

test('Engine: a hand that reaches 21 by hitting stands automatically', () => {
  const e = dealt(['5', '10', '6', '7', 'K']);
  e.hit(0);
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.player.hands[0].result, 'win');
  assert.equal(e.player.balance, 1100);
});

test('Engine: split hands that land on 21 are skipped automatically', () => {
  const e = dealt(['A', '10', 'A', '7', 'K', '9']);
  e.split(0); // A+K = 21, A+9 = 20
  assert.equal(e.player.hands[0].getScore(), 21);
  assert.equal(e.player.hands[0].done, true);
  assert.equal(e.gamePhase, 'playerTurn');
  assert.equal(e.currentHandIndex, 1);
});

test('Engine: running out of money offers a restart', () => {
  const e = dealt(['6', '10', '7', '9'], 1000);
  const events = record(e);
  e.stand(0);
  assert.equal(e.player.balance, 0);
  assert.equal(e.isBroke(), true);
  assert.equal(events.find(ev => ev.type === 'roundOver').broke, true);
  assert.equal(e.restart(), true);
  assert.equal(e.player.balance, 1000);
  assert.equal(e.gamePhase, 'betting');
});

test('Engine: restart and prepareNextHand do nothing at the wrong time', () => {
  const e = dealt(['10', '10', 'K', '8']);
  e.stand(0);
  assert.equal(e.restart(), false);
  assert.equal(e.player.balance, 1100);
  const fresh = new BlackjackEngine();
  assert.equal(fresh.prepareNextHand(), false);
});

test('Engine: the dealer can be driven step by step (autoDealer off)', () => {
  const e = dealt(['10', '10', 'K', '6', '5'], 100, { autoDealer: false });
  const events = record(e);
  e.stand(0);
  assert.equal(e.gamePhase, 'dealerTurn');
  assert.equal(events.some(ev => ev.type === 'dealerTurn'), true);
  assert.equal(e.dealerShouldDraw(), true); // 16
  assert.equal(e.dealerDraw().value, '5');
  assert.equal(e.dealerShouldDraw(), false); // 21
  assert.equal(e.gamePhase, 'dealerTurn');
  e.finishDealerTurn();
  assert.equal(e.gamePhase, 'gameOver');
  assert.equal(e.player.balance, 900);
});

test('Engine: streak events fire after three wins or losses in a row', () => {
  const win = new BlackjackEngine();
  const events = record(win);
  for (let i = 0; i < 3; i++) {
    stack(win, ['10', '10', 'K', '8']);
    win.placeBet(10);
    win.deal();
    win.stand(0);
    win.prepareNextHand();
  }
  assert.deepEqual(events.filter(ev => ev.type === 'streak').map(ev => ev.kind), ['hot']);

  const lose = new BlackjackEngine();
  const events2 = record(lose);
  for (let i = 0; i < 3; i++) {
    stack(lose, ['6', '10', '7', '9']);
    lose.placeBet(10);
    lose.deal();
    lose.stand(0);
    lose.prepareNextHand();
  }
  assert.deepEqual(events2.filter(ev => ev.type === 'streak').map(ev => ev.kind), ['cold']);
});

test('Engine: action buttons are only enabled in the right phases', () => {
  const e = new BlackjackEngine();
  assert.equal(e.canHit(), false);
  stack(e, ['10', 'A', '9', '7', '2']);
  e.placeBet(100);
  e.deal();
  assert.equal(e.canHit(), false); // insurance decision pending
  e.declineInsurance();
  assert.equal(e.canHit(), true);
  e.hit(0);
  assert.equal(e.canSurrender(), false);
});

test('Engine: basic strategy, hard totals', () => {
  assert.equal(strategy(['10', '6'], '10'), 'surrender');
  assert.equal(strategy(['10', '6'], '10', { canSurrender: false }), 'hit');
  assert.equal(strategy(['10', '6'], '6'), 'stand');
  assert.equal(strategy(['10', '2'], '3'), 'hit');
  assert.equal(strategy(['10', '2'], '4'), 'stand');
  assert.equal(strategy(['6', '5'], '6'), 'double');
  assert.equal(strategy(['6', '5'], '6', { canDouble: false }), 'hit');
  assert.equal(strategy(['6', '5'], 'A'), 'hit');
  assert.equal(strategy(['5', '4'], '5'), 'double');
  assert.equal(strategy(['5', '4'], '2'), 'hit');
  assert.equal(strategy(['10', '7'], 'A'), 'stand');
  assert.equal(strategy(['5', '3'], '6'), 'hit');
});

test('Engine: basic strategy, soft totals', () => {
  assert.equal(strategy(['A', '7'], '6'), 'double');
  assert.equal(strategy(['A', '7'], '6', { canDouble: false }), 'stand');
  assert.equal(strategy(['A', '7'], '9'), 'hit');
  assert.equal(strategy(['A', '7'], '8'), 'stand');
  assert.equal(strategy(['A', '6'], '3'), 'double');
  assert.equal(strategy(['A', '6'], '2'), 'hit');
  assert.equal(strategy(['A', '3'], '5'), 'double');
  assert.equal(strategy(['A', '2', '4'], '5'), 'double');
  assert.equal(strategy(['A', '9'], '6'), 'stand');
});

test('Engine: basic strategy, pairs', () => {
  assert.equal(strategy(['A', 'A'], '10'), 'split');
  assert.equal(strategy(['8', '8'], '10'), 'split');
  assert.equal(strategy(['10', '10'], '6'), 'stand');
  assert.equal(strategy(['9', '9'], '7'), 'stand');
  assert.equal(strategy(['9', '9'], '8'), 'split');
  assert.equal(strategy(['7', '7'], '8'), 'hit');
  assert.equal(strategy(['5', '5'], '6'), 'double');
  assert.equal(strategy(['8', '8'], '10', { canSplit: false }), 'surrender');
  assert.equal(strategy(['A', 'A'], '5', { canSplit: false }), 'double');
});

test('Engine: hints', () => {
  assert.equal(new BlackjackEngine().getHint(), null);
  assert.equal(dealt(['10', '10', '6', '5']).getHint(), 'surrender'); // 16 vs 10
  assert.equal(dealt(['10', 'A', '9', '7']).getHint(), 'decline-insurance');
});

test('Engine: fuzz - 5000 random rounds conserve money and always finish', () => {
  const e = new BlackjackEngine();
  const events = record(e);
  let adjust = 0;
  let net = 0;
  events.length = 0;
  e.subscribe(ev => {
    if (ev.type === 'settled' || ev.type === 'insuranceSettled') net += ev.net;
  });
  for (let round = 0; round < 5000; round++) {
    if (e.player.balance < 20) { e.player.balance += 1000; adjust += 1000; }
    const affordable = [5, 25, 100].filter(chip => chip <= e.player.balance);
    e.placeBet(affordable[Math.floor(Math.random() * affordable.length)]);
    e.deal();
    let guard = 0;
    while (e.gamePhase !== 'gameOver' && guard++ < 60) {
      if (e.gamePhase === 'insurance') {
        Math.random() < 0.5 ? e.buyInsurance() : e.declineInsurance();
      } else {
        const roll = Math.random();
        if (roll < 0.15 && e.canSplit()) e.split(e.currentHandIndex);
        else if (roll < 0.30 && e.canDouble()) e.doubleDown(e.currentHandIndex);
        else if (roll < 0.35 && e.canSurrender()) e.surrender();
        else if (roll < 0.7 && e.canHit()) e.hit(e.currentHandIndex);
        else e.stand(e.currentHandIndex);
      }
    }
    assert.equal(e.gamePhase, 'gameOver', `round ${round} never finished`);
    assert.ok(e.player.hands.every(hand => hand.settled), 'every hand settled at round end');
    assert.ok(Number.isInteger(e.player.balance), `non-integer balance ${e.player.balance}`);
    assert.equal(e.player.balance, 1000 + adjust + net, `round ${round}: money was created or lost`);
    e.prepareNextHand();
  }
});

// =====================================================================
// Part 2: the page (script.js) in a mocked browser
// =====================================================================

function makeEnvironment(savedStats = null, { storageThrows = false, presets = {} } = {}) {
  // A minimal DOM: enough tree operations for the page's keyed rendering, so tests can
  // check which elements are kept, replaced or removed.
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
      this.innerHTML = '';
      this._text = '';
      this.children = [];
      this.parentNode = null;
      this.disabled = false;
    }
    get className() { return [...this._classes].join(' '); }
    set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text; }
    set textContent(value) { this._text = String(value); this.children = []; } // like the DOM, drops children
    get lastChild() { return this.children[this.children.length - 1] || null; }
    appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
    replaceChild(next, old) {
      const index = this.children.indexOf(old);
      if (index === -1) throw new Error('replaceChild: not a child');
      next.remove();
      this.children[this.children.indexOf(old)] = next;
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
  if (savedStats) storage.set('blackjackStats', typeof savedStats === 'string' ? savedStats : JSON.stringify(savedStats));
  for (const [key, value] of Object.entries(presets)) storage.set(key, value);
  const playLog = [];
  let now = 0;
  let timerId = 0;
  const timers = [];
  const context = vm.createContext({
    console,
    Audio: class { constructor(src) { this.src = src; } play() { playLog.push(this.src); return Promise.resolve(); } },
    document: {
      body: node('body'),
      getElementById: id => node(id),
      createElement: () => new Element(),
      querySelector: selector => node(selector),
      querySelectorAll: selector => (selector === '.hand' ? node('player-hands').children : []),
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
  const source = fs.readFileSync(enginePath, 'utf8') + '\n' + fs.readFileSync(scriptPath, 'utf8');
  vm.runInContext(source + '\n;globalThis.pageExports = { game, getStats: () => ({...gameStats}), getSession: () => ({...sessionStats}), toggleMute, isMuted: () => soundMuted, toggleHints, hintsOn: () => hintsEnabled, describeCard };', context, { filename: 'engine.js+script.js' });
  // Runs timers that are due within the next `ms` milliseconds (and any they schedule).
  function advance(ms) {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.time - b.time || a.id - b.id);
      if (!timers.length || timers[0].time > until) break;
      const timer = timers.shift();
      now = timer.time;
      timer.fn();
    }
    now = until;
  }
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
  return { ...context.pageExports, node, flushTimers, advance, playLog, storage };
}

function uiDeal(env, values, bet = 100) {
  stack(env.game.engine, values);
  assert.equal(env.game.placeBet(bet), true);
  env.game.deal();
  env.flushTimers();
}

test('Page: bets are locked once dealing begins, with a message', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', 'K', '8']);
  assert.equal(env.game.clearBet(), false);
  assert.match(env.node('message').textContent, /locked/);
  assert.equal(env.game.removeBet(100), false);
  assert.equal(env.game.engine.player.balance, 900);
});

test('Page: the table shows the current phase', () => {
  const env = makeEnvironment();
  assert.equal(env.node('game-container').dataset.phase, 'betting');
  uiDeal(env, ['10', '10', 'K', '8']);
  assert.equal(env.node('game-container').dataset.phase, 'playerTurn');
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.node('game-container').dataset.phase, 'gameOver');
  assert.equal(env.node('next-hand').style.display, 'inline-block');
});

test('Page: the dealer plays out at a watchable pace and the round settles', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', 'K', '6', '5']);
  env.game.stand(0);
  assert.equal(env.game.engine.gamePhase, 'dealerTurn'); // waiting on timers
  env.flushTimers();
  assert.equal(env.game.engine.gamePhase, 'gameOver');
  assert.equal(env.game.engine.player.balance, 900);
  assert.match(env.node('message').textContent, /You lose \$100/);
});

test('Page: surrender reports the real amounts in the message and statistics', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '9', '6', '8']);
  env.game.surrender();
  assert.equal(env.game.engine.player.balance, 950);
  assert.equal(env.getStats().totalMoney, -50);
  assert.equal(env.getSession().totalMoney, -50);
  assert.match(env.node('message').textContent, /\$50 of your \$100/);
});

test('Page: a busted split hand and the surviving hand are both recorded', () => {
  const env = makeEnvironment();
  uiDeal(env, ['8', '10', '8', '7', '10', '9', 'K']);
  env.game.split(0);
  env.game.hit(0);
  env.game.stand(1);
  env.flushTimers();
  assert.equal(env.getStats().gamesPlayed, 2);
  assert.equal(env.getStats().totalMoney, -100);
  assert.match(env.node('message').textContent, /Hand 1:.*Hand 2:/);
});

test('Page: session statistics start at zero while lifetime statistics reload', () => {
  const env = makeEnvironment({ gamesPlayed: 10, gamesWon: 7, totalMoney: 3000 });
  assert.equal(env.game.engine.player.balance, 1000);
  assert.equal(JSON.stringify(env.getSession()), JSON.stringify({ gamesPlayed: 0, gamesWon: 0, totalMoney: 0 }));
  assert.match(env.node('stats').textContent, /Session: .*Lifetime: /);
  uiDeal(env, ['10', '10', 'K', '8']);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.getSession().totalMoney, 100);
  assert.equal(env.getStats().totalMoney, 3100);
  assert.equal(env.getStats().gamesPlayed, 11);
});

test('Page: insurance results are included in the statistics', () => {
  const lose = makeEnvironment();
  uiDeal(lose, ['10', 'A', '9', '7']);
  assert.equal(lose.game.engine.gamePhase, 'insurance');
  assert.match(lose.node('message').textContent, /buy insurance/);
  lose.game.buyInsurance();
  assert.equal(lose.getSession().totalMoney, -50);
  assert.equal(lose.game.engine.gamePhase, 'playerTurn');
  lose.game.buyInsurance(); // no second purchase
  assert.equal(lose.game.engine.player.balance, 850);

  const win = makeEnvironment();
  uiDeal(win, ['10', 'A', '9', 'K']);
  win.game.buyInsurance();
  assert.equal(win.game.engine.player.balance, 1000);
  assert.equal(win.getSession().totalMoney, 0);
});

test('Page: dealer peek explains why a dealer blackjack ended the round', () => {
  const env = makeEnvironment();
  uiDeal(env, ['9', '10', '7', 'A']);
  assert.equal(env.game.engine.gamePhase, 'gameOver');
  assert.match(env.node('message').textContent, /Dealer showed a 10 and peeked at the hole card: Blackjack! You lose\./);
});

test('Page: dealer peek tells you when there was no blackjack', () => {
  const env = makeEnvironment();
  uiDeal(env, ['9', '10', '7', '6', '2']);
  assert.equal(env.game.engine.gamePhase, 'playerTurn');
  assert.equal(env.node('message').textContent, 'Dealer peeked: no Blackjack. Your move.');

  const low = makeEnvironment();
  uiDeal(low, ['9', '6', '7', '10', '2']);
  assert.equal(low.node('message').textContent, 'Your move.'); // nothing was peeked at
});

test('Page: running out of money offers a New Game button', () => {
  const env = makeEnvironment();
  uiDeal(env, ['6', '10', '7', '9'], 1000);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.game.engine.isBroke(), true);
  assert.equal(env.node('restart').style.display, 'inline-block');
  assert.equal(env.node('next-hand').style.display, 'none');
  assert.match(env.node('message').textContent, /out of money/);
  env.game.restart();
  assert.equal(env.game.engine.player.balance, 1000);
  assert.equal(env.game.engine.gamePhase, 'betting');
  assert.equal(env.node('restart').style.display, 'none');
  assert.equal(env.getSession().totalMoney, -1000);
});

test('Page: betting messages', () => {
  const env = makeEnvironment();
  env.game.setBet(137);
  assert.equal(env.node('message').textContent, 'Bet set to $137.');
  assert.equal(env.game.setBet(0), false);
  assert.match(env.node('message').textContent, /whole-dollar/);
  assert.equal(env.game.rebet(), false);
  assert.equal(env.node('message').textContent, 'Nothing to rebet.');
  env.game.clearBet();
  assert.equal(env.game.engine.player.balance, 1000);
  env.game.deal();
  assert.equal(env.node('message').textContent, 'Please place a bet first.');
});

test('Page: corrupt or malformed saved stats fall back to a fresh start', () => {
  for (const bad of ['{not json', '{"gamesPlayed":"x","gamesWon":1,"totalMoney":2}', '[]', 'null']) {
    const env = makeEnvironment(bad);
    assert.equal(JSON.stringify(env.getStats()), JSON.stringify({ gamesPlayed: 0, gamesWon: 0, totalMoney: 0 }), bad);
  }
});

test('Page: the game works when localStorage is blocked', () => {
  const env = makeEnvironment(null, { storageThrows: true });
  uiDeal(env, ['10', '10', 'K', '8']);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(env.game.engine.player.balance, 1100);
  env.toggleMute();
  assert.equal(env.isMuted(), true);
});

test('Page: each dealt card plays its sound once', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', 'K', '8']);
  assert.equal(env.playLog.filter(src => src === 'sounds/card.wav').length, 4);
});

test('Page: mute silences every sound and is remembered', () => {
  const env = makeEnvironment();
  env.toggleMute();
  assert.equal(env.isMuted(), true);
  assert.equal(env.storage.get('blackjackMuted'), '1');
  assert.equal(env.node('mute').textContent, 'Sound: Off');
  uiDeal(env, ['A', '10', 'K', '9']); // blackjack: chips, cards and the popup sound
  assert.equal(env.playLog.length, 0);
  env.toggleMute();
  assert.equal(env.storage.get('blackjackMuted'), '0');

  const restored = makeEnvironment(null, { presets: { blackjackMuted: '1' } });
  assert.equal(restored.isMuted(), true);
  assert.equal(restored.node('mute').textContent, 'Sound: Off');
});

test('Page: hint messages', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', '6', '5']); // 16 vs 10
  env.game.hint();
  assert.match(env.node('message').textContent, /Surrender/);

  const ins = makeEnvironment();
  uiDeal(ins, ['10', 'A', '9', '7']);
  ins.game.hint();
  assert.match(ins.node('message').textContent, /decline insurance/);
});

test('Page: hints can be switched off, which hides the Hint button, and the choice is remembered', () => {
  const env = makeEnvironment();
  assert.equal(env.hintsOn(), true); // on by default
  assert.equal(env.node('toggle-hints').textContent, 'Hints: On');
  assert.notEqual(env.node('hint').style.display, 'none');
  uiDeal(env, ['10', '10', '6', '5', '2']); // 16 vs 10
  env.game.hint();
  assert.match(env.node('message').textContent, /Surrender/);

  env.toggleHints();
  assert.equal(env.hintsOn(), false);
  assert.equal(env.node('toggle-hints').textContent, 'Hints: Off');
  assert.equal(env.node('toggle-hints').getAttribute('aria-pressed'), 'false');
  assert.equal(env.node('hint').style.display, 'none'); // hidden straight away, mid-hand
  assert.equal(env.storage.get('blackjackHints'), '0');
  env.game.hit(0); // now the message changes, and a hint must not bring it back
  const before = env.node('message').textContent;
  env.game.hint();
  assert.equal(env.node('message').textContent, before);

  env.toggleHints();
  assert.equal(env.hintsOn(), true);
  assert.notEqual(env.node('hint').style.display, 'none');
  assert.equal(env.storage.get('blackjackHints'), '1');
});

test('Page: the hints setting is restored on load, and insurance hints obey it too', () => {
  const off = makeEnvironment(null, { presets: { blackjackHints: '0' } });
  assert.equal(off.hintsOn(), false);
  assert.equal(off.node('toggle-hints').textContent, 'Hints: Off');
  assert.equal(off.node('hint').style.display, 'none');
  uiDeal(off, ['10', 'A', '9', '7']); // insurance phase
  assert.equal(off.game.engine.gamePhase, 'insurance');
  off.game.hint();
  assert.doesNotMatch(off.node('message').textContent, /decline insurance/);
  assert.equal(off.node('hint').style.display, 'none');
  // the engine itself still knows the answer; only the page hides it
  assert.equal(off.game.engine.getHint(), 'decline-insurance');
});

test('Page: the hints setting survives blocked storage', () => {
  const env = makeEnvironment(null, { storageThrows: true });
  assert.equal(env.hintsOn(), true);
  env.toggleHints();
  assert.equal(env.hintsOn(), false);
});

test('Page: cards have screen-reader descriptions', () => {
  const env = makeEnvironment();
  assert.equal(env.describeCard({ value: 'Q', suit: '♥' }), 'Queen of hearts');
  assert.equal(env.describeCard({ value: '10', suit: '♠' }), '10 of spades');
  const element = env.game.buildCardElement({ value: 'A', suit: '♣' });
  assert.equal(element.getAttribute('aria-label'), 'Ace of clubs');
  assert.equal(element.getAttribute('role'), 'img');
  assert.equal(env.game.buildCardElement({ value: 'A', suit: '♣' }, { hidden: true }).getAttribute('aria-label'), null);
});

const cardElements = env => env.node('player-hands').children.map(hand => hand.parts.cards.children);
const dealerElements = env => env.node('dealer-cards').children;

test('Page: the opening cards are revealed one at a time', () => {
  const env = makeEnvironment();
  stack(env.game.engine, ['10', '9', '8', '7']);
  env.game.placeBet(100);
  env.game.deal();
  assert.equal(env.node('game-container').dataset.phase, 'dealing');
  assert.equal(env.node('player-hands').children.length, 1); // the hand exists, still empty
  assert.equal(cardElements(env)[0].length, 0);
  assert.equal(dealerElements(env).length, 0);
  env.advance(0);
  assert.deepEqual([cardElements(env)[0].length, dealerElements(env).length], [1, 0]);
  env.advance(500);
  assert.deepEqual([cardElements(env)[0].length, dealerElements(env).length], [1, 1]);
  env.advance(500);
  assert.deepEqual([cardElements(env)[0].length, dealerElements(env).length], [2, 1]);
  env.advance(500);
  assert.deepEqual([cardElements(env)[0].length, dealerElements(env).length], [2, 2]);
  assert.equal(env.game.engine.gamePhase, 'dealing');
  env.advance(500);
  assert.equal(env.game.engine.gamePhase, 'playerTurn');
});

test('Page: the dealer\'s hole card stays face down until the dealer plays', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', '9', '6', '5']);
  assert.equal(dealerElements(env)[1].classList.contains('card-back'), true);
  assert.equal(dealerElements(env)[1].getAttribute('aria-label'), null);
  const upCard = dealerElements(env)[0];
  env.game.stand(0);
  env.flushTimers();
  assert.equal(dealerElements(env)[0], upCard); // the up card element was never rebuilt
  assert.equal(dealerElements(env)[1].classList.contains('card-back'), false);
  assert.match(dealerElements(env)[1].getAttribute('aria-label'), /^6 of /);
  assert.equal(dealerElements(env).length, env.game.engine.dealer.cards.length);
});

test('Page: cards that have not changed keep the same element when the table updates', () => {
  const env = makeEnvironment();
  uiDeal(env, ['2', '10', '3', '7', '4', '5']);
  const before = [...cardElements(env)[0]];
  assert.equal(before.length, 2);
  env.game.hit(0); // 2+3+4 = 9
  const after = cardElements(env)[0];
  assert.equal(after.length, 3);
  assert.equal(after[0], before[0]);
  assert.equal(after[1], before[1]);
  assert.equal(after[2].classList.contains('deal-in'), true); // the new card animates in
  env.game.hit(0);
  assert.equal(cardElements(env)[0][0], before[0]);
  assert.equal(cardElements(env)[0][2], after[2]);
});

test('Page: a newly turned-over card is replaced without the fly-in animation', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', '9', '6', '5']);
  const hole = dealerElements(env)[1];
  env.game.stand(0);
  env.flushTimers();
  const revealed = dealerElements(env)[1];
  assert.notEqual(revealed, hole);
  assert.equal(revealed.classList.contains('deal-in'), false);
});

test('Page: hand elements persist and are updated, not rebuilt', () => {
  const env = makeEnvironment();
  uiDeal(env, ['8', '10', '8', '7', '10', '9', 'K']);
  const hand = env.node('player-hands').children[0];
  assert.equal(hand.parts.name.textContent, 'Hand 1');
  assert.equal(hand.parts.score.textContent, '16');
  assert.equal(hand.classList.contains('active-hand'), true);
  env.game.split(0);
  assert.equal(env.node('player-hands').children.length, 2);
  assert.equal(env.node('player-hands').children[0], hand); // same element, new contents
  assert.equal(hand.parts.score.textContent, '18');
  env.game.hit(0); // bust
  assert.equal(hand.parts.status.textContent, 'BUST');
  assert.equal(hand.parts.score.classList.contains('bust'), true); // the badge turns red
  assert.equal(hand.dataset.result, 'loss');
  assert.equal(hand.classList.contains('active-hand'), false);
  assert.equal(env.node('player-hands').children[1].classList.contains('active-hand'), true);
  env.game.stand(1);
  env.flushTimers();
  assert.equal(env.node('player-hands').children[0], hand);
  assert.equal(env.node('player-hands').children[1].parts.status.textContent, 'PUSH');
});

test('Page: the table is cleared for the next round', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', 'K', '8']);
  env.game.stand(0);
  env.flushTimers();
  assert.equal(dealerElements(env).length, 2);
  env.game.prepareNextHand();
  assert.equal(dealerElements(env).length, 0);
  assert.equal(env.node('player-hands').children.length, 0);
  assert.equal(env.node('bet-chips').children.length, 0);
});

test('Page: chips in the pot match the bet, and untouched rack chips are kept', () => {
  const env = makeEnvironment();
  const rack = env.node('chip-container').children;
  assert.equal(rack.length, 6);
  const dollar = rack[0];
  env.game.placeBet(25);
  env.game.placeBet(100);
  assert.deepEqual(env.node('bet-chips').children.map(chip => chip.dataset.key.split(':')[1]), ['25', '100']);
  assert.equal(env.node('chip-container').children[0], dollar); // the $1 chip was never rebuilt
  assert.equal(env.node('bet-chips').children[1].getAttribute('aria-label'), 'Remove a $100 chip from your bet');
  env.node('bet-chips').children[0].onclick(); // clicking a chip in the pot removes it
  assert.deepEqual(env.node('bet-chips').children.map(chip => chip.dataset.key.split(':')[1]), ['100']);
  assert.equal(env.game.engine.currentBet, 100);
  env.game.setBet(137);
  assert.equal(env.node('bet-chips').children.length, env.game.engine.chipsInPot.length);
});

test('Page: chips you cannot afford are locked in the rack', () => {
  const env = makeEnvironment();
  env.game.setBet(950);
  const locked = env.node('chip-container').children.filter(chip => chip.classList.contains('locked'));
  assert.deepEqual(locked.map(chip => chip.dataset.key.split(':')[0]), ['100', '500', '1000']);
  assert.equal(locked[0].tabIndex, -1);
});

test('Page: results colour the hand and its popup by outcome', () => {
  const env = makeEnvironment();
  uiDeal(env, ['10', '10', 'K', '8']);
  env.game.stand(0);
  env.advance(1000); // the dealer stands on 18 and the hand settles
  const hand = env.node('player-hands').children[0];
  assert.equal(hand.dataset.result, 'win');
  const popup = hand.children.find(child => child.className.includes('result-popup'));
  assert.ok(popup, 'a result popup is shown on the hand');
  assert.ok(popup.classList.contains('result-win'));
  assert.match(popup.innerHTML, /WIN/);
  env.flushTimers();
  assert.equal(hand.children.some(child => child.className.includes('result-popup')), false); // it fades away
  assert.equal(hand.dataset.result, 'win'); // the hand keeps its colour
});

test('Page: the dealer\'s score badge stays hidden until the hole card is revealed', () => {
  const env = makeEnvironment();
  const badge = env.node('#dealer-hand .score');
  uiDeal(env, ['10', '10', 'K', '8']);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, '');
  env.game.stand(0);
  env.flushTimers();
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '18');
  env.game.prepareNextHand();
  assert.equal(badge.hidden, true); // nothing dealt yet
});

test('Page: score badges highlight 21 and busts', () => {
  const env = makeEnvironment();
  uiDeal(env, ['A', '10', 'K', '9']); // blackjack
  const score = env.node('player-hands').children[0].parts.score;
  assert.equal(score.textContent, '21');
  assert.equal(score.classList.contains('twenty-one'), true);
  assert.equal(score.classList.contains('bust'), false);
});

test('Page: chips added to the bet pop in, but the rest do not', () => {
  const env = makeEnvironment();
  env.game.placeBet(25);
  const first = env.node('bet-chips').children[0];
  assert.equal(first.classList.contains('chip-in'), true);
  env.game.placeBet(100);
  assert.equal(env.node('bet-chips').children[0], first); // untouched
  assert.equal(env.node('bet-chips').children[1].classList.contains('chip-in'), true);
});

test('Page: fuzz - 300 random rounds through the page keep balance and statistics in step', () => {
  const env = makeEnvironment();
  const g = env.game;
  const e = g.engine;
  let adjust = 0;
  // The page must always show exactly what the engine holds.
  function checkRendered() {
    assert.equal(dealerElements(env).length, e.dealer.cards.length, 'dealer cards on screen');
    const handEls = env.node('player-hands').children;
    assert.equal(handEls.length, e.gamePhase === 'betting' ? 0 : e.player.hands.length, 'hands on screen');
    handEls.forEach((el, i) => assert.equal(el.parts.cards.children.length, e.player.hands[i].cards.length, `cards in hand ${i}`));
    assert.equal(env.node('bet-chips').children.length, e.chipsInPot.length, 'chips in the pot');
  }
  for (let round = 0; round < 300; round++) {
    if (e.player.balance < 20) { e.player.balance += 1000; adjust += 1000; }
    const affordable = [5, 25, 100].filter(chip => chip <= e.player.balance);
    g.placeBet(affordable[Math.floor(Math.random() * affordable.length)]);
    g.deal();
    env.flushTimers();
    let guard = 0;
    while (e.gamePhase !== 'gameOver' && guard++ < 60) {
      if (e.gamePhase === 'insurance') {
        Math.random() < 0.5 ? g.buyInsurance() : g.declineInsurance();
      } else {
        const roll = Math.random();
        if (roll < 0.15 && e.canSplit()) g.split(e.currentHandIndex);
        else if (roll < 0.30 && e.canDouble()) g.doubleDown(e.currentHandIndex);
        else if (roll < 0.35 && e.canSurrender()) g.surrender();
        else if (roll < 0.7 && e.canHit()) g.hit(e.currentHandIndex);
        else g.stand(e.currentHandIndex);
      }
      env.flushTimers();
      checkRendered();
    }
    assert.equal(e.gamePhase, 'gameOver', `round ${round} never finished`);
    checkRendered();
    assert.equal(e.player.balance, 1000 + adjust + env.getSession().totalMoney, `round ${round}: page statistics disagree with the balance`);
    g.prepareNextHand();
  }
});

const failures = results.filter(r => !r.ok);
console.log(JSON.stringify({ passed: results.length - failures.length, total: results.length, failures }, null, 2));
