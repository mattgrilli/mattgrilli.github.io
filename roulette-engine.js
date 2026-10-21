'use strict';

// Matt's Roulette: an American (double-zero) roulette simulator, play money only. No DOM,
// sound, timer or storage code lives here, so it can be used by the page (roulette.js)
// and by tests running in plain Node.
//
// The wheel has 38 equally likely pockets: 0, 00 and 1-36. Every bet on the table - from a
// single number to red/black - is just a set of those pockets plus a payout, all listed in
// BETS (built once below from the table layout). That makes the house edge of every bet a
// one-line calculation: 1 - (pockets covered / 38) * (payout + 1). Every bet comes out at
// exactly 5.26% except the five-number "basket" (0, 00, 1, 2, 3), which is 7.89% - see
// roulette_verify.cjs. Not affiliated with any casino. Play money only.

const STARTING_BALANCE = 500;
const MIN_BET = 1;
const HISTORY_LENGTH = 20;

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const POCKETS = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];

// The real American wheel, clockwise from 0.
const WHEEL_ORDER = [
    '0', '28', '9', '26', '30', '11', '7', '20', '32', '17', '5', '22', '34', '15', '3', '24', '36', '13', '1',
    '00', '27', '10', '25', '29', '12', '8', '19', '31', '18', '6', '21', '33', '16', '4', '23', '35', '14', '2'
];

function colorOf(pocket) {
    if (pocket === '0' || pocket === '00') {
        return 'green';
    }
    return RED_NUMBERS.has(Number(pocket)) ? 'red' : 'black';
}

// ---- The bet catalogue ----

// Payouts are "to 1": a winning $10 split (17:1) pays $170 profit plus the $10 back.
const KINDS = {
    straight: { payout: 35, name: 'Straight up' },
    split: { payout: 17, name: 'Split' },
    street: { payout: 11, name: 'Street' },
    trio: { payout: 11, name: 'Trio' },
    corner: { payout: 8, name: 'Corner' },
    basket: { payout: 6, name: 'Basket' },
    sixline: { payout: 5, name: 'Six line' },
    dozen: { payout: 2, name: 'Dozen' },
    column: { payout: 2, name: 'Column' },
    evenmoney: { payout: 1, name: 'Even money' }
};

const pocketIndex = new Map(POCKETS.map((p, i) => [p, i]));
const sortPockets = list => [...list].sort((a, b) => pocketIndex.get(a) - pocketIndex.get(b));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

function buildBets() {
    const bets = [];
    const add = (kind, numbers, key, label) => {
        const sorted = sortPockets(numbers.map(String));
        bets.push({
            key: key || `${kind}:${sorted.join('-')}`,
            kind,
            numbers: sorted,
            payout: KINDS[kind].payout,
            label: label || `${KINDS[kind].name} ${sorted.join('/')}`
        });
    };

    POCKETS.forEach(p => add('straight', [p], null, `Straight up ${p}`));

    // The 1-36 grid: column c (1-12) holds 3c-2 (nearest the dealer's "bottom" row),
    // 3c-1 and 3c. Splits join neighbours in a column (n, n+1) or across columns (n, n+3).
    for (let n = 1; n <= 36; n++) {
        if (n % 3 !== 0) add('split', [n, n + 1]);
        if (n <= 33) add('split', [n, n + 3]);
    }
    add('split', ['0', '00']);
    add('split', ['0', '1']);
    add('split', ['00', '3']);

    for (let c = 1; c <= 12; c++) {
        add('street', range(3 * c - 2, 3 * c), null, `Street ${3 * c - 2}-${3 * c}`);
    }
    add('trio', ['0', '1', '2']);
    add('trio', ['00', '2', '3']);

    for (let c = 1; c <= 11; c++) {
        for (const base of [3 * c - 2, 3 * c - 1]) {
            add('corner', [base, base + 1, base + 3, base + 4]);
        }
        add('sixline', range(3 * c - 2, 3 * c + 3), null, `Six line ${3 * c - 2}-${3 * c + 3}`);
    }
    add('basket', ['0', '00', '1', '2', '3'], 'basket', 'Basket 0/00/1/2/3');

    const ones = range(1, 36);
    add('dozen', range(1, 12), 'dozen1', '1st Dozen (1-12)');
    add('dozen', range(13, 24), 'dozen2', '2nd Dozen (13-24)');
    add('dozen', range(25, 36), 'dozen3', '3rd Dozen (25-36)');
    add('column', ones.filter(n => n % 3 === 1), 'column1', 'Column 1 (1, 4 ... 34)');
    add('column', ones.filter(n => n % 3 === 2), 'column2', 'Column 2 (2, 5 ... 35)');
    add('column', ones.filter(n => n % 3 === 0), 'column3', 'Column 3 (3, 6 ... 36)');
    add('evenmoney', ones.filter(n => colorOf(n) === 'red'), 'red', 'Red');
    add('evenmoney', ones.filter(n => colorOf(n) === 'black'), 'black', 'Black');
    add('evenmoney', ones.filter(n => n % 2 === 1), 'odd', 'Odd');
    add('evenmoney', ones.filter(n => n % 2 === 0), 'even', 'Even');
    add('evenmoney', range(1, 18), 'low', '1 to 18');
    add('evenmoney', range(19, 36), 'high', '19 to 36');
    return bets;
}

const BET_LIST = buildBets();
const BETS = new Map(BET_LIST.map(bet => [bet.key, bet]));

function houseEdgePct(bet) {
    return (1 - (bet.numbers.length / POCKETS.length) * (bet.payout + 1)) * 100;
}

// The paytable: one row per kind of bet, derived from the catalogue itself.
const PAYTABLE_GROUPS = [
    ['straight', 'Straight up (1 number)'],
    ['split', 'Split (2)'],
    ['street', 'Street / Trio (3)'],
    ['corner', 'Corner (4)'],
    ['basket', 'Basket 0-00-1-2-3 (5)'],
    ['sixline', 'Six line (6)'],
    ['dozen', 'Dozen / Column (12)'],
    ['evenmoney', 'Red/Black, Odd/Even, 1-18/19-36 (18)']
];

function computeOddsTable() {
    return PAYTABLE_GROUPS.map(([kind, label]) => {
        const sample = BET_LIST.find(bet => bet.kind === kind);
        return {
            key: kind,
            label,
            payout: sample.payout,
            winProbability: sample.numbers.length / POCKETS.length,
            houseEdgePct: houseEdgePct(sample)
        };
    });
}

// ---- The engine ----

const ok = () => ({ ok: true });
const fail = reason => ({ ok: false, reason });

function freshEngineStats() {
    return { spinsPlayed: 0, betsPlaced: 0, totalWagered: 0, totalWon: 0, biggestWin: 0 };
}

class RouletteEngine {
    constructor({ startingBalance = STARTING_BALANCE, rng = Math.random } = {}) {
        this.startingBalance = startingBalance;
        this.rng = rng;
        this.balance = startingBalance;
        this.phase = 'betting'; // 'betting' | 'results'
        this.bets = {};         // bet key -> total amount on it this round
        this.placements = [];   // this round's chips in the order placed, for Undo
        this.lastRoundBets = {}; // the bets of the most recent spin, for Rebet
        this.lastSpin = null;
        this.history = [];      // recent winning pockets, most recent last
        this.stats = freshEngineStats();
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

    totalWagered() {
        return Object.values(this.bets).reduce((sum, amount) => sum + amount, 0);
    }

    // ---- Bankroll ----

    canSetBalance() {
        return this.phase === 'betting' && this.totalWagered() === 0;
    }

    setBalance(amount) {
        if (!this.canSetBalance()) {
            return fail('locked');
        }
        if (!Number.isInteger(amount) || amount < MIN_BET) {
            return fail('invalid');
        }
        this.balance = amount;
        this.startingBalance = amount;
        this.emit('balanceSet', { amount });
        return ok();
    }

    // ---- Placing and taking back bets ----

    placeBet(key, amount) {
        if (!BETS.has(key) || !Number.isInteger(amount) || amount < MIN_BET) {
            return fail('invalid');
        }
        if (this.phase !== 'betting') {
            return fail('locked');
        }
        if (this.balance < amount) {
            return fail('insufficient');
        }
        this.balance -= amount;
        this.bets[key] = (this.bets[key] || 0) + amount;
        this.placements.push({ key, amount });
        this.emit('betPlaced', { key, amount });
        return ok();
    }

    // Takes back the most recently placed chip.
    undo() {
        if (this.phase !== 'betting' || this.placements.length === 0) {
            return fail('nothing');
        }
        const { key, amount } = this.placements.pop();
        this.balance += amount;
        this.bets[key] -= amount;
        if (this.bets[key] === 0) {
            delete this.bets[key];
        }
        this.emit('betRemoved', { key, amount });
        return ok();
    }

    // Takes back everything on one spot.
    removeBet(key) {
        if (this.phase !== 'betting' || !this.bets[key]) {
            return fail('nothing');
        }
        const amount = this.bets[key];
        this.balance += amount;
        delete this.bets[key];
        this.placements = this.placements.filter(p => p.key !== key);
        this.emit('betRemoved', { key, amount });
        return ok();
    }

    clearBets() {
        if (this.phase !== 'betting' || this.totalWagered() === 0) {
            return fail('nothing');
        }
        const refund = this.totalWagered();
        this.balance += refund;
        this.bets = {};
        this.placements = [];
        this.emit('betsCleared', { refund });
        return ok();
    }

    // Rebet: put last spin's bets back on an empty table.
    canRebet() {
        const total = Object.values(this.lastRoundBets).reduce((sum, a) => sum + a, 0);
        return this.phase === 'betting' && this.totalWagered() === 0 && total > 0 && this.balance >= total;
    }

    rebet() {
        if (!this.canRebet()) {
            return fail('nothing');
        }
        for (const [key, amount] of Object.entries(this.lastRoundBets)) {
            this.placeBet(key, amount);
        }
        return ok();
    }

    // Double: put the same amount again on every spot that has a bet.
    canDouble() {
        const total = this.totalWagered();
        return this.phase === 'betting' && total > 0 && this.balance >= total;
    }

    doubleBets() {
        if (!this.canDouble()) {
            return fail('insufficient');
        }
        for (const [key, amount] of Object.entries({ ...this.bets })) {
            this.placeBet(key, amount);
        }
        return ok();
    }

    // ---- Spinning ----

    canSpin() {
        return this.phase === 'betting' && this.totalWagered() > 0;
    }

    drawPocket() {
        return POCKETS[Math.floor(this.rng() * POCKETS.length)];
    }

    // `forced` optionally fixes the winning pocket - only ever passed by tests; real play
    // never does, so every real spin is random.
    spin(forced = null) {
        if (this.phase !== 'betting') {
            return fail('locked');
        }
        if (this.totalWagered() === 0) {
            return fail('nobets');
        }
        const pocket = forced && pocketIndex.has(forced) ? forced : this.drawPocket();
        const results = Object.entries(this.bets).map(([key, amount]) => this.settle(key, amount, pocket));
        const wagered = this.totalWagered();
        const totalWon = results.reduce((sum, r) => sum + r.payout, 0);

        this.balance += totalWon;
        this.stats.spinsPlayed += 1;
        this.stats.betsPlaced += results.length;
        this.stats.totalWagered += wagered;
        this.stats.totalWon += totalWon;
        if (totalWon > this.stats.biggestWin) {
            this.stats.biggestWin = totalWon;
        }
        this.history.push(pocket);
        if (this.history.length > HISTORY_LENGTH) {
            this.history.shift();
        }
        this.lastRoundBets = { ...this.bets };
        this.lastSpin = { pocket, color: colorOf(pocket), results, wagered, totalWon };
        this.setPhase('results');
        this.emit('spinResolved', this.lastSpin);
        return { ...ok(), spin: this.lastSpin };
    }

    // What one bet pays back, stake included; 0 if it lost (the stake left the balance
    // when the bet was placed).
    settle(key, amount, pocket) {
        const bet = BETS.get(key);
        const won = bet.numbers.includes(pocket);
        return { key, kind: bet.kind, label: bet.label, amount, won, payout: won ? amount * (bet.payout + 1) : 0 };
    }

    // ---- Between rounds ----

    nextRound() {
        if (this.phase !== 'results') {
            return false;
        }
        this.bets = {};
        this.placements = [];
        this.lastSpin = null;
        this.setPhase('betting');
        return true;
    }

    // Out of money with nothing left to do: nothing on the table while betting, or a spin
    // just settled with less than a minimum bet left.
    isBroke() {
        if (this.balance >= MIN_BET) {
            return false;
        }
        return this.phase === 'results' || this.totalWagered() === 0;
    }

    restart() {
        if (!this.isBroke()) {
            return false;
        }
        this.balance = this.startingBalance;
        this.bets = {};
        this.placements = [];
        this.lastRoundBets = {};
        this.lastSpin = null;
        this.history = [];
        this.stats = freshEngineStats();
        this.setPhase('betting');
        return true;
    }
}

RouletteEngine.STARTING_BALANCE = STARTING_BALANCE;
RouletteEngine.MIN_BET = MIN_BET;
RouletteEngine.HISTORY_LENGTH = HISTORY_LENGTH;
RouletteEngine.POCKETS = POCKETS;
RouletteEngine.WHEEL_ORDER = WHEEL_ORDER;
RouletteEngine.BETS = BETS;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RouletteEngine, colorOf, computeOddsTable, houseEdgePct, POCKETS, WHEEL_ORDER, BETS, BET_LIST };
}
