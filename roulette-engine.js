'use strict';

// Matt's Roulette: an American (double-zero) roulette simulator, play money only. No DOM,
// sound, timer or storage code lives here, so it can be used by the page (roulette.js) and
// by tests running in plain Node.
//
// The wheel has 38 equally likely pockets: 0, 00, and 1-36. Every bet type here (straight
// numbers, red/black, odd/even, low/high, dozens, columns) has exactly the same real house
// edge: 5.26%, regardless of how safe or wild it looks - see computeOddsTable and
// roulette_verify.cjs, which verify this from the combinatorics rather than a hardcoded
// table. (The one well-known American-wheel exception, the five-number 0/00/1/2/3 "basket"
// bet at 7.89%, isn't offered here - see the README.)
// This project is not affiliated with or endorsed by any casino. Play money only: there is
// no real betting, no real wheel and no real payouts.

const STARTING_BALANCE = 500;
const MIN_BET = 1;
const MAX_BETS_PER_SPIN = 200; // generous, but bounded - see canPlaceBet

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const POCKETS = ['0', '00', ...Array.from({ length: 36 }, (_, i) => String(i + 1))];

function colorOf(pocket) {
    if (pocket === '0' || pocket === '00') {
        return 'green';
    }
    return RED_NUMBERS.has(Number(pocket)) ? 'red' : 'black';
}

// The bet menu. Every evaluator takes the winning pocket (a string: '0', '00', or '1'-'36')
// and the bet's `selection`, and returns true if that bet wins. `payout` is the "to 1"
// multiplier (a $10 straight-up win pays $350, the original $10 stays too - see settleBet).
const BET_TYPES = {
    straight: {
        label: 'Straight up',
        payout: 35,
        outcomes: 1,
        wins: (pocket, selection) => pocket === selection
    },
    red: {
        label: 'Red',
        payout: 1,
        outcomes: 18,
        wins: pocket => colorOf(pocket) === 'red'
    },
    black: {
        label: 'Black',
        payout: 1,
        outcomes: 18,
        wins: pocket => colorOf(pocket) === 'black'
    },
    odd: {
        label: 'Odd',
        payout: 1,
        outcomes: 18,
        wins: pocket => isNumber(pocket) && Number(pocket) % 2 === 1
    },
    even: {
        label: 'Even',
        payout: 1,
        outcomes: 18,
        wins: pocket => isNumber(pocket) && Number(pocket) % 2 === 0
    },
    low: {
        label: '1 to 18',
        payout: 1,
        outcomes: 18,
        wins: pocket => isNumber(pocket) && Number(pocket) >= 1 && Number(pocket) <= 18
    },
    high: {
        label: '19 to 36',
        payout: 1,
        outcomes: 18,
        wins: pocket => isNumber(pocket) && Number(pocket) >= 19 && Number(pocket) <= 36
    },
    dozen1: {
        label: '1st Dozen (1-12)',
        payout: 2,
        outcomes: 12,
        wins: pocket => isNumber(pocket) && Number(pocket) >= 1 && Number(pocket) <= 12
    },
    dozen2: {
        label: '2nd Dozen (13-24)',
        payout: 2,
        outcomes: 12,
        wins: pocket => isNumber(pocket) && Number(pocket) >= 13 && Number(pocket) <= 24
    },
    dozen3: {
        label: '3rd Dozen (25-36)',
        payout: 2,
        outcomes: 12,
        wins: pocket => isNumber(pocket) && Number(pocket) >= 25 && Number(pocket) <= 36
    },
    column1: {
        label: 'Column 1',
        payout: 2,
        outcomes: 12,
        wins: pocket => isNumber(pocket) && Number(pocket) % 3 === 1
    },
    column2: {
        label: 'Column 2',
        payout: 2,
        outcomes: 12,
        wins: pocket => isNumber(pocket) && Number(pocket) % 3 === 2
    },
    column3: {
        label: 'Column 3',
        payout: 2,
        outcomes: 12,
        wins: pocket => isNumber(pocket) && Number(pocket) % 3 === 0
    }
};

function isNumber(pocket) {
    return pocket !== '0' && pocket !== '00';
}

// The paytable, computed from the bet menu rather than hand-typed: every type's real odds
// and house edge, derived the same way a published odds sheet would be.
function computeOddsTable() {
    const total = POCKETS.length;
    return Object.entries(BET_TYPES).map(([key, def]) => {
        const probability = def.outcomes / total;
        // Expected value per $1 bet: win pays `payout` profit with probability `probability`,
        // lose the $1 stake otherwise.
        const ev = probability * def.payout - (1 - probability);
        return {
            key,
            label: def.label,
            payout: def.payout,
            oddsInOne: total / def.outcomes,
            oddsLabel: `1 in ${(total / def.outcomes).toLocaleString('en-US', { maximumFractionDigits: 2 })}`,
            houseEdgePct: -ev * 100
        };
    });
}

const ok = () => ({ ok: true });
const fail = reason => ({ ok: false, reason });

class RouletteEngine {
    constructor({ startingBalance = STARTING_BALANCE, rng = Math.random } = {}) {
        this.startingBalance = startingBalance;
        this.rng = rng;
        this.balance = startingBalance;
        this.phase = 'betting'; // 'betting' | 'results'
        this.bets = [];         // this round's bets: { type, selection, amount }
        this.lastSpin = null;   // set by spin(): { pocket, color, results, totalWon }
        this.stats = { spinsPlayed: 0, betsPlaced: 0, totalWagered: 0, totalWon: 0, biggestWin: 0 };
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

    canSetBalance() {
        return this.phase === 'betting' && this.bets.length === 0;
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

    // ---- Placing bets ----

    // A bet's selection: straight bets need a pocket ('17', '0', '00'); every other type
    // ignores it (pass null).
    canPlaceBet(type, selection, amount) {
        if (this.phase !== 'betting') {
            return false;
        }
        if (!BET_TYPES[type]) {
            return false;
        }
        if (type === 'straight' && !POCKETS.includes(selection)) {
            return false;
        }
        if (!Number.isInteger(amount) || amount < MIN_BET) {
            return false;
        }
        if (this.bets.length >= MAX_BETS_PER_SPIN) {
            return false;
        }
        return this.balance >= amount;
    }

    placeBet(type, selection, amount) {
        if (!BET_TYPES[type]) {
            return fail('invalid');
        }
        if (this.phase !== 'betting') {
            return fail('locked');
        }
        if (type === 'straight' && !POCKETS.includes(selection)) {
            return fail('invalid');
        }
        if (!Number.isInteger(amount) || amount < MIN_BET) {
            return fail('invalid');
        }
        if (this.bets.length >= MAX_BETS_PER_SPIN) {
            return fail('toomany');
        }
        if (this.balance < amount) {
            return fail('insufficient');
        }
        this.balance -= amount;
        const bet = { type, selection: type === 'straight' ? selection : null, amount };
        this.bets.push(bet);
        this.emit('betPlaced', { bet });
        return ok();
    }

    clearBets() {
        if (this.phase !== 'betting' || this.bets.length === 0) {
            return fail('nothing');
        }
        const refund = this.bets.reduce((sum, bet) => sum + bet.amount, 0);
        this.balance += refund;
        this.bets = [];
        this.emit('betsCleared', { refund });
        return ok();
    }

    totalWagered() {
        return this.bets.reduce((sum, bet) => sum + bet.amount, 0);
    }

    // ---- Spinning ----

    canSpin() {
        return this.phase === 'betting' && this.bets.length > 0;
    }

    drawPocket() {
        return POCKETS[Math.floor(this.rng() * POCKETS.length)];
    }

    // `forced` optionally fixes the winning pocket - only ever passed by tests; the page
    // never calls it, so every real spin is truly random.
    spin(forced = null) {
        if (this.phase !== 'betting') {
            return fail('locked');
        }
        if (this.bets.length === 0) {
            return fail('nobets');
        }
        const pocket = forced && POCKETS.includes(forced) ? forced : this.drawPocket();
        const color = colorOf(pocket);

        const results = this.bets.map(bet => this.settleBet(bet, pocket));
        const totalWon = results.reduce((sum, r) => sum + r.payout, 0);
        const wagered = this.totalWagered();

        this.balance += totalWon;
        this.stats.spinsPlayed += 1;
        this.stats.betsPlaced += this.bets.length;
        this.stats.totalWagered += wagered;
        this.stats.totalWon += totalWon;
        for (const r of results) {
            if (r.payout > this.stats.biggestWin) {
                this.stats.biggestWin = r.payout;
            }
        }

        this.lastSpin = { pocket, color, results, totalWon, wagered };
        this.setPhase('results');
        this.emit('spinResolved', this.lastSpin);
        return { ...ok(), spin: this.lastSpin };
    }

    // Pays a single bet against the winning pocket. Win: the stake back plus `payout`
    // times the stake. Loss: $0 (the stake is already gone - it left the balance when the
    // bet was placed).
    settleBet(bet, pocket) {
        const def = BET_TYPES[bet.type];
        const won = def.wins(pocket, bet.selection);
        const payout = won ? bet.amount * (def.payout + 1) : 0;
        return { bet, won, payout };
    }

    // ---- Between rounds ----

    nextRound() {
        if (this.phase !== 'results') {
            return false;
        }
        this.bets = [];
        this.lastSpin = null;
        this.setPhase('betting');
        return true;
    }

    // Out of money with nothing left to do: either mid-betting with no bets placed (there
    // is nothing to spin), or a spin just settled (the bets in `bets` are already spent and
    // about to be cleared by nextRound - there is nothing to play again with). While
    // mid-betting with bets already placed, the player can still spin.
    isBroke() {
        if (this.balance >= MIN_BET) {
            return false;
        }
        return this.phase === 'results' || this.bets.length === 0;
    }

    restart() {
        if (!this.isBroke()) {
            return false;
        }
        this.balance = this.startingBalance;
        this.bets = [];
        this.lastSpin = null;
        this.stats = { spinsPlayed: 0, betsPlaced: 0, totalWagered: 0, totalWon: 0, biggestWin: 0 };
        this.setPhase('betting');
        return true;
    }
}

RouletteEngine.STARTING_BALANCE = STARTING_BALANCE;
RouletteEngine.MIN_BET = MIN_BET;
RouletteEngine.MAX_BETS_PER_SPIN = MAX_BETS_PER_SPIN;
RouletteEngine.POCKETS = POCKETS;
RouletteEngine.BET_TYPES = BET_TYPES;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { RouletteEngine, colorOf, computeOddsTable, isNumber, POCKETS, BET_TYPES };
}
