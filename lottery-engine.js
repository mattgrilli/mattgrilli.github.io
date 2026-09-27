'use strict';

// Lucky Draw: a lottery-ticket simulator with play money only. No DOM, sound, timer or
// storage code lives here, so it can be used by the page (lottery.js) and by tests
// running in plain Node.
//
// The drawing mechanics mirror a well-known U.S. multi-state number-matching game: 5
// unique numbers from 1-69 (the "whites") plus 1 number from 1-26 (the "red ball").
// Every drawing really draws those numbers at random and compares them to each ticket,
// so the odds below are not made up - they fall out of the combinatorics and match the
// real game's published odds exactly (see computeOddsTable and lottery_verify.cjs).
// This project is not affiliated with or endorsed by any lottery operator. Play money
// only: there are no real tickets, no real draws and no real prizes.

const STARTING_BALANCE = 100;
const TICKET_PRICE = 2;
const WHITE_COUNT = 69;
const WHITE_PICK = 5;
const RED_COUNT = 26;
const BASE_JACKPOT = 20_000_000;
const JACKPOT_INCREMENT = 3_000_000; // added to the jackpot after a drawing with no jackpot winner
const MAX_TICKETS_PER_ROUND = 1_000_000; // a hard cap; see canBuy() for why

// n-choose-r. Every value used here is small enough (n <= 69) to stay well within
// float precision, so a straightforward running product is exact once rounded.
function nCr(n, r) {
    if (r < 0 || r > n) {
        return 0;
    }
    r = Math.min(r, n - r);
    let result = 1;
    for (let i = 0; i < r; i++) {
        result = (result * (n - i)) / (i + 1);
    }
    return Math.round(result);
}

// How many of the possible drawings would give a ticket exactly `matchWhite` matching
// white numbers and, if `matchRed` is true, the red ball too (or, if false, any of the
// other red numbers). Dividing this into the total possible drawings gives the real odds.
function outcomesFor(matchWhite, matchRed, { whitePick = WHITE_PICK, whiteCount = WHITE_COUNT, redCount = RED_COUNT } = {}) {
    const otherWhites = whiteCount - whitePick;
    const ways = nCr(whitePick, matchWhite) * nCr(otherWhites, whitePick - matchWhite);
    return ways * (matchRed ? 1 : redCount - 1);
}

function totalDrawings({ whitePick = WHITE_PICK, whiteCount = WHITE_COUNT, redCount = RED_COUNT } = {}) {
    return nCr(whiteCount, whitePick) * redCount;
}

// The prize table. 'jackpot' is resolved against the engine's current jackpot instead of
// a fixed amount; every other tier pays the same fixed cash amount as the real game.
const TIERS = [
    { key: 'jackpot', matchWhite: 5, matchRed: true, prize: 'jackpot', label: 'Match 5 + Red Ball' },
    { key: 'match5', matchWhite: 5, matchRed: false, prize: 1_000_000, label: 'Match 5' },
    { key: 'match4pb', matchWhite: 4, matchRed: true, prize: 50_000, label: 'Match 4 + Red Ball' },
    { key: 'match4', matchWhite: 4, matchRed: false, prize: 100, label: 'Match 4' },
    { key: 'match3pb', matchWhite: 3, matchRed: true, prize: 100, label: 'Match 3 + Red Ball' },
    { key: 'match3', matchWhite: 3, matchRed: false, prize: 7, label: 'Match 3' },
    { key: 'match2pb', matchWhite: 2, matchRed: true, prize: 7, label: 'Match 2 + Red Ball' },
    { key: 'match1pb', matchWhite: 1, matchRed: true, prize: 4, label: 'Match 1 + Red Ball' },
    { key: 'match0pb', matchWhite: 0, matchRed: true, prize: 4, label: 'Red Ball Only' }
];

const TIER_BY_MATCH = new Map(TIERS.map(tier => [`${tier.matchWhite}:${tier.matchRed}`, tier]));

function tierFor(matchWhite, matchRed) {
    return TIER_BY_MATCH.get(`${matchWhite}:${matchRed}`) || null;
}

// The paytable, highest prize first, formatted for display: each tier's label, its fixed
// prize (or 'jackpot' for the variable top prize) and its real odds as "1 in X".
function computeOddsTable(options = {}) {
    const total = totalDrawings(options);
    return TIERS.map(tier => {
        const outcomes = outcomesFor(tier.matchWhite, tier.matchRed, options);
        const oddsInOne = total / outcomes;
        return {
            key: tier.key,
            label: tier.label,
            prize: tier.prize,
            oddsInOne,
            oddsLabel: `1 in ${oddsInOne.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
        };
    }).concat([(() => {
        const oddsInOne = total / TIERS.reduce((sum, tier) => sum + outcomesFor(tier.matchWhite, tier.matchRed, options), 0);
        return {
            key: 'overall',
            label: 'Any prize',
            prize: null,
            oddsInOne,
            oddsLabel: `1 in ${oddsInOne.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
        };
    })()]);
}

const ok = () => ({ ok: true });
const fail = reason => ({ ok: false, reason });

class LotteryEngine {
    constructor({ startingBalance = STARTING_BALANCE, ticketPrice = TICKET_PRICE, rng = Math.random } = {}) {
        this.startingBalance = startingBalance;
        this.ticketPrice = ticketPrice;
        this.rng = rng;
        this.balance = startingBalance;
        this.jackpot = BASE_JACKPOT;
        this.phase = 'buying'; // 'buying' | 'results'
        this.tickets = [];     // tickets bought for the round in progress
        this.winningWhites = null; // set by revealDraw(), before tickets are checked
        this.winningRed = null;
        this.checkedResults = []; // filled in gradually by checkBatch() during 'checking'
        this.lastDraw = null;  // set once checking finishes: { winningWhites, winningRed, results, totalWon, jackpotWon, jackpotBefore }
        this.stats = { drawsPlayed: 0, ticketsBought: 0, totalSpent: 0, totalWon: 0, biggestWin: 0 };
        this.listeners = [];
    }

    subscribe(listener) {
        this.listeners.push(listener);
    }

    emit(type, data = {}) {
        for (const listener of this.listeners) {
            listener({ type, ...data });
        }
    }

    setPhase(phase) {
        this.phase = phase;
        this.emit('phase', { phase });
    }

    // ---- Bankroll ----

    // Lets the player pick how much money they start with. Only allowed before any
    // tickets are held for the round, so it can't be used to top up mid-round. This also
    // becomes the amount a later restart() (going broke) resets to, since a player who
    // deliberately chose a bankroll almost certainly wants to keep experimenting with it,
    // not fall back to some earlier default.
    canSetBalance() {
        return this.phase === 'buying' && this.tickets.length === 0;
    }

    setBalance(amount) {
        if (!this.canSetBalance()) {
            return fail('locked');
        }
        if (!Number.isInteger(amount) || amount < this.ticketPrice) {
            return fail('invalid');
        }
        this.balance = amount;
        this.startingBalance = amount;
        this.emit('balanceSet', { amount });
        return ok();
    }

    // ---- Buying tickets ----

    // A hard ceiling on tickets held per round, independent of how much money the player
    // has. Generating a ticket (5 random numbers) is cheap, but not free: at a few hundred
    // thousand tickets, one synchronous buy already takes a noticeable fraction of a
    // second, and there is nothing stopping a player from setting an enormous bankroll
    // and asking for tens or hundreds of millions of tickets in one purchase, which would
    // hang or crash the page well before it ever got to rendering anything. A cap this
    // high still costs $2,000,000 to reach and is far more than enough to demonstrate how
    // little even that buys against these odds.
    canBuy(quantity) {
        return this.phase === 'buying' &&
               Number.isInteger(quantity) && quantity >= 1 &&
               this.balance >= quantity * this.ticketPrice &&
               this.tickets.length + quantity <= MAX_TICKETS_PER_ROUND;
    }

    // The most tickets the player could buy right now (for a "Max" button), at least 0.
    maxAffordable() {
        if (this.phase !== 'buying') {
            return 0;
        }
        const affordable = Math.floor(this.balance / this.ticketPrice);
        const roomLeft = MAX_TICKETS_PER_ROUND - this.tickets.length;
        return Math.max(0, Math.min(affordable, roomLeft));
    }

    buyTickets(quantity) {
        if (this.phase !== 'buying') {
            return fail('locked');
        }
        if (!Number.isInteger(quantity) || quantity < 1) {
            return fail('invalid');
        }
        if (this.tickets.length + quantity > MAX_TICKETS_PER_ROUND) {
            return fail('toomany');
        }
        if (!this.canBuy(quantity)) {
            return fail('insufficient');
        }
        const cost = quantity * this.ticketPrice;
        this.balance -= cost;
        this.stats.ticketsBought += quantity;
        this.stats.totalSpent += cost;
        const bought = [];
        for (let i = 0; i < quantity; i++) {
            const ticket = this.quickPick();
            this.tickets.push(ticket);
            bought.push(ticket);
        }
        this.emit('ticketsBought', { quantity, cost, tickets: bought });
        return ok();
    }

    clearTickets() {
        if (this.phase !== 'buying' || this.tickets.length === 0) {
            return fail('nothing');
        }
        const refund = this.tickets.length * this.ticketPrice;
        this.balance += refund;
        this.stats.ticketsBought -= this.tickets.length;
        this.stats.totalSpent -= refund;
        this.tickets = [];
        this.emit('ticketsCleared', { refund });
        return ok();
    }

    quickPick() {
        return { whites: this.drawWhites(), red: this.drawRed() };
    }

    // A partial Fisher-Yates draw over a pool reused across calls (not rebuilt each time)
    // with swap-based removal (O(1), not the O(n) shift a splice-based removal costs) -
    // this matters once buying tickets by the hundred thousand or million.
    drawWhites() {
        if (!this._whitePool) {
            this._whitePool = new Array(WHITE_COUNT);
        }
        const pool = this._whitePool;
        for (let i = 0; i < WHITE_COUNT; i++) {
            pool[i] = i + 1;
        }
        const picks = new Array(WHITE_PICK);
        let remaining = WHITE_COUNT;
        for (let i = 0; i < WHITE_PICK; i++) {
            const index = Math.floor(this.rng() * remaining);
            picks[i] = pool[index];
            remaining--;
            pool[index] = pool[remaining];
        }
        return picks.sort((a, b) => a - b);
    }

    drawRed() {
        return 1 + Math.floor(this.rng() * RED_COUNT);
    }

    // ---- The drawing: revealing the winning numbers, then checking tickets ----
    //
    // These are two separate steps so a page can show the numbers first (the dramatic
    // moment) and let the player check their tickets separately - and so checking a huge
    // number of tickets can be paced in batches with a progress bar, rather than done in
    // one long synchronous call. draw() below does both steps at once, for a test (or a
    // page) that just wants the end result.

    canDraw() {
        return this.phase === 'buying' && this.tickets.length > 0;
    }

    // Reveals the winning numbers only; tickets aren't checked against them yet (see
    // checkBatch). `forced` optionally fixes the winning numbers ({ whites, red }) - only
    // ever passed by tests; the page never calls it, so every real drawing is random.
    revealDraw(forced = null) {
        if (this.phase !== 'buying') {
            return fail('locked');
        }
        if (this.tickets.length === 0) {
            return fail('notickets');
        }
        this.winningWhites = forced && forced.whites ? [...forced.whites].sort((a, b) => a - b) : this.drawWhites();
        this.winningRed = forced && forced.red ? forced.red : this.drawRed();
        this.checkedResults = [];
        this.setPhase('checking');
        this.emit('numbersRevealed', { winningWhites: this.winningWhites, winningRed: this.winningRed });
        return ok();
    }

    canCheck() {
        return this.phase === 'checking' && this.checkedResults.length < this.tickets.length;
    }

    ticketsLeftToCheck() {
        return this.phase === 'checking' ? this.tickets.length - this.checkedResults.length : 0;
    }

    // Checks up to `batchSize` more tickets against the already-revealed winning numbers.
    // Once every ticket has been checked, the round settles automatically (finishChecking)
    // and 'drawResolved' fires, exactly as it did before this was split into two steps.
    checkBatch(batchSize) {
        if (!this.canCheck()) {
            return fail('locked');
        }
        const start = this.checkedResults.length;
        const end = Math.min(start + batchSize, this.tickets.length);
        for (let i = start; i < end; i++) {
            this.checkedResults.push(this.evaluateTicket(this.tickets[i], this.winningWhites, this.winningRed));
        }
        this.emit('checkProgress', { checked: this.checkedResults.length, total: this.tickets.length });
        if (this.checkedResults.length >= this.tickets.length) {
            this.finishChecking();
        }
        return ok();
    }

    finishChecking() {
        const results = this.checkedResults;
        const totalWon = results.reduce((sum, r) => sum + r.prize, 0);
        const jackpotWon = results.some(r => r.tier === 'jackpot');
        const jackpotBefore = this.jackpot;

        this.balance += totalWon;
        this.stats.drawsPlayed += 1;
        this.stats.totalWon += totalWon;
        // A plain loop, not Math.max(...results.map(...)): spreading hundreds of
        // thousands of arguments into a function call overflows the stack.
        for (const result of results) {
            if (result.prize > this.stats.biggestWin) {
                this.stats.biggestWin = result.prize;
            }
        }
        this.jackpot = jackpotWon ? BASE_JACKPOT : this.jackpot + JACKPOT_INCREMENT;

        this.lastDraw = { winningWhites: this.winningWhites, winningRed: this.winningRed, results, totalWon, jackpotWon, jackpotBefore, jackpotAfter: this.jackpot };
        this.setPhase('results');
        this.emit('drawResolved', this.lastDraw);
    }

    // Convenience: reveals the numbers and checks every ticket in one synchronous call.
    // Used by tests, and by anything that doesn't need the paced, two-step flow.
    draw(forced = null) {
        const started = this.revealDraw(forced);
        if (!started.ok) {
            return started;
        }
        this.checkBatch(this.tickets.length);
        return { ...ok(), draw: this.lastDraw };
    }

    evaluateTicket(ticket, winningWhites, winningRed) {
        const matchWhite = ticket.whites.filter(n => winningWhites.includes(n)).length;
        const matchRed = ticket.red === winningRed;
        const tier = tierFor(matchWhite, matchRed);
        const prize = tier ? (tier.prize === 'jackpot' ? this.jackpot : tier.prize) : 0;
        return { ticket, matchWhite, matchRed, tier: tier ? tier.key : null, tierLabel: tier ? tier.label : null, prize };
    }

    // ---- Between rounds ----

    nextRound() {
        if (this.phase !== 'results') {
            return false;
        }
        this.tickets = [];
        this.lastDraw = null;
        this.winningWhites = null;
        this.winningRed = null;
        this.checkedResults = [];
        this.setPhase('buying');
        return true;
    }

    // Out of money with nothing left to do: either mid-buying with no tickets held (so
    // there is nothing to draw), or a drawing just finished (so the tickets in `tickets`
    // are already spent and about to be cleared by nextRound - there is nothing to play
    // again with). While mid-buying with tickets already held, the player can still draw.
    isBroke() {
        if (this.balance >= this.ticketPrice) {
            return false;
        }
        return this.phase === 'results' || this.tickets.length === 0;
    }

    restart() {
        if (!this.isBroke()) {
            return false;
        }
        this.balance = this.startingBalance;
        this.jackpot = BASE_JACKPOT;
        this.tickets = [];
        this.lastDraw = null;
        this.winningWhites = null;
        this.winningRed = null;
        this.checkedResults = [];
        this.stats = { drawsPlayed: 0, ticketsBought: 0, totalSpent: 0, totalWon: 0, biggestWin: 0 };
        this.setPhase('buying');
        return true;
    }
}

LotteryEngine.STARTING_BALANCE = STARTING_BALANCE;
LotteryEngine.TICKET_PRICE = TICKET_PRICE;
LotteryEngine.WHITE_COUNT = WHITE_COUNT;
LotteryEngine.WHITE_PICK = WHITE_PICK;
LotteryEngine.RED_COUNT = RED_COUNT;
LotteryEngine.BASE_JACKPOT = BASE_JACKPOT;
LotteryEngine.JACKPOT_INCREMENT = JACKPOT_INCREMENT;
LotteryEngine.MAX_TICKETS_PER_ROUND = MAX_TICKETS_PER_ROUND;
LotteryEngine.TIERS = TIERS;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LotteryEngine, nCr, outcomesFor, totalDrawings, computeOddsTable, tierFor };
}
