'use strict';

// Matt's Baccarat: a Punto Banco simulator, play money only. No DOM, sound, timer or
// storage code lives here, so it can be used by the page (baccarat.js) and by tests
// running in plain Node.
//
// ALL MONEY IN THIS FILE IS INTEGER CENTS. The 5% Banker commission produces cents, and
// keeping every amount an integer means balances never drift the way floating-point
// dollars would over thousands of hands. The page converts to and from dollars.
//
// Rules: an 8-deck shoe. Player and Banker each get two cards; a hand's total is the last
// digit of its card points (A = 1, 2-9 = face value, 10/J/Q/K = 0). An 8 or 9 is a
// "natural" and ends the hand. Otherwise the third-card rules (the "tableau", see
// playerDraws/bankerDraws) decide, with no choices for anyone. Bets: Player pays 1:1,
// Banker pays 1:1 less a 5% commission, Tie pays 8:1; Player and Banker bets push on a tie.
//
// computeExactOdds() derives each outcome's probability by enumerating every possible
// card sequence from a fresh shoe, which is how the published house edges (Banker 1.06%,
// Player 1.24%, Tie 14.36%) are themselves derived - see baccarat_verify.cjs.
// This project is not affiliated with or endorsed by any casino. Play money only.

const NUM_DECKS = 8;
const STARTING_BALANCE = 100_000; // $1,000.00
const MIN_BET = 100;              // $1.00
const BANKER_COMMISSION_PCT = 5;
const TIE_PAYOUT = 8;
const HISTORY_LENGTH = 60;
const SPOTS = ['player', 'banker', 'tie'];

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function cardPoints(rank) {
    if (rank === 'A') {
        return 1;
    }
    if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') {
        return 0;
    }
    return Number(rank);
}

function handTotal(cards) {
    return cards.reduce((sum, card) => sum + cardPoints(card.rank), 0) % 10;
}

// ---- The tableau ----

// Player draws a third card on 0-5 and stands on 6-7 (8-9 never get here: naturals end
// the hand before anyone draws).
function playerDraws(playerTotal) {
    return playerTotal <= 5;
}

// Banker's rule depends on whether the Player drew, and if so on the point value of the
// Player's third card. `playerThird` is null if the Player stood.
function bankerDraws(bankerTotal, playerThird) {
    if (playerThird === null) {
        return bankerTotal <= 5;
    }
    switch (bankerTotal) {
        case 0: case 1: case 2: return true;
        case 3: return playerThird !== 8;
        case 4: return playerThird >= 2 && playerThird <= 7;
        case 5: return playerThird >= 4 && playerThird <= 7;
        case 6: return playerThird === 6 || playerThird === 7;
        default: return false; // 7 stands
    }
}

// Plays one hand ("coup") from a card source. `drawCard()` returns the next card. Returns
// both hands, their totals, the winner, and the order cards came out (for the page to
// animate the deal in the right sequence).
function playCoup(drawCard) {
    const player = [];
    const banker = [];
    const order = [];
    const deal = (hand, side) => {
        const card = drawCard();
        hand.push(card);
        order.push({ side, card });
        return card;
    };
    deal(player, 'player');
    deal(banker, 'banker');
    deal(player, 'player');
    deal(banker, 'banker');

    let playerTotal = handTotal(player);
    let bankerTotal = handTotal(banker);
    const natural = playerTotal >= 8 || bankerTotal >= 8;

    if (!natural) {
        let playerThird = null;
        if (playerDraws(playerTotal)) {
            playerThird = cardPoints(deal(player, 'player').rank);
            playerTotal = handTotal(player);
        }
        if (bankerDraws(bankerTotal, playerThird)) {
            deal(banker, 'banker');
            bankerTotal = handTotal(banker);
        }
    }

    const winner = playerTotal > bankerTotal ? 'player' : bankerTotal > playerTotal ? 'banker' : 'tie';
    return { player, banker, playerTotal, bankerTotal, winner, natural, order };
}

// ---- Exact odds ----

// Every outcome's exact probability from a freshly shuffled shoe: walk every possible
// sequence of card point values (0-9) the coup could draw, weighting each by its chance
// without replacement. Only the cards a coup actually uses are enumerated, so this is at
// most 10^6 leaves. Uses the same playerDraws/bankerDraws as real play.
const exactOddsCache = new Map();

function computeExactOdds(numDecks = NUM_DECKS) {
    if (exactOddsCache.has(numDecks)) {
        return exactOddsCache.get(numDecks);
    }
    const counts = new Array(10).fill(4 * numDecks);
    counts[0] = 16 * numDecks; // 10, J, Q, K
    let remaining = 52 * numDecks;
    const result = { player: 0, banker: 0, tie: 0 };

    const draw = (next, weight) => {
        for (let v = 0; v < 10; v++) {
            if (counts[v] === 0) {
                continue;
            }
            const p = counts[v] / remaining;
            counts[v]--;
            remaining--;
            next(v, weight * p);
            counts[v]++;
            remaining++;
        }
    };
    const finish = (pt, bt, w) => {
        result[pt > bt ? 'player' : bt > pt ? 'banker' : 'tie'] += w;
    };

    draw((p1, w1) => draw((b1, w2) => draw((p2, w3) => draw((b2, w4) => {
        const pt = (p1 + p2) % 10;
        const bt = (b1 + b2) % 10;
        if (pt >= 8 || bt >= 8) {
            finish(pt, bt, w4);
        } else if (playerDraws(pt)) {
            draw((p3, w5) => {
                const pt3 = (pt + p3) % 10;
                if (bankerDraws(bt, p3)) {
                    draw((b3, w6) => finish(pt3, (bt + b3) % 10, w6), w5);
                } else {
                    finish(pt3, bt, w5);
                }
            }, w4);
        } else if (bankerDraws(bt, null)) {
            draw((b3, w5) => finish(pt, (bt + b3) % 10, w5), w4);
        } else {
            finish(pt, bt, w4);
        }
    }, w3), w2), w1), 1);

    exactOddsCache.set(numDecks, result);
    return result;
}

// The paytable: each bet's payout, win probability and house edge, all derived from
// computeExactOdds rather than typed in.
function computeOddsTable(numDecks = NUM_DECKS) {
    const p = computeExactOdds(numDecks);
    const bankerProfit = 1 - BANKER_COMMISSION_PCT / 100;
    const ev = {
        player: p.player * 1 - p.banker,
        banker: p.banker * bankerProfit - p.player,
        tie: p.tie * TIE_PAYOUT - (1 - p.tie)
    };
    return [
        { key: 'player', label: 'Player', payoutLabel: '1:1 (push on tie)', winProbability: p.player, houseEdgePct: -ev.player * 100 },
        { key: 'banker', label: 'Banker', payoutLabel: '0.95:1 (push on tie)', winProbability: p.banker, houseEdgePct: -ev.banker * 100 },
        { key: 'tie', label: 'Tie', payoutLabel: `${TIE_PAYOUT}:1`, winProbability: p.tie, houseEdgePct: -ev.tie * 100 }
    ];
}

// ---- The shoe ----

class Shoe {
    constructor(numDecks, rng) {
        this.numDecks = numDecks;
        this.rng = rng;
        this.reset();
    }

    reset() {
        this.cards = [];
        for (let d = 0; d < this.numDecks; d++) {
            for (const suit of SUITS) {
                for (const rank of RANKS) {
                    this.cards.push({ rank, suit });
                }
            }
        }
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(this.rng() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
        // The cut card sits 14-30 cards from the end. A coup uses at most 6 cards, so
        // checking it before each coup means the shoe can never run out mid-hand.
        this.cutAtCardsRemaining = 14 + Math.floor(this.rng() * 17);
    }

    needsShuffle() {
        return this.cards.length <= this.cutAtCardsRemaining;
    }

    draw() {
        return this.cards.pop();
    }
}

// ---- The engine ----

const ok = () => ({ ok: true });
const fail = reason => ({ ok: false, reason });

function freshEngineStats() {
    return { handsPlayed: 0, totalWagered: 0, totalWon: 0, biggestWin: 0, playerWins: 0, bankerWins: 0, ties: 0 };
}

class BaccaratEngine {
    constructor({ startingBalance = STARTING_BALANCE, numDecks = NUM_DECKS, rng = Math.random } = {}) {
        this.startingBalance = startingBalance;
        this.rng = rng;
        this.shoe = new Shoe(numDecks, () => this.rng());
        this.balance = startingBalance;
        this.phase = 'betting'; // 'betting' | 'results'
        this.bets = { player: 0, banker: 0, tie: 0 };
        this.lastCoup = null;
        this.history = []; // most recent last: 'player' | 'banker' | 'tie'
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
        return this.bets.player + this.bets.banker + this.bets.tie;
    }

    // ---- Bankroll ----

    canSetBalance() {
        return this.phase === 'betting' && this.totalWagered() === 0;
    }

    setBalance(cents) {
        if (!this.canSetBalance()) {
            return fail('locked');
        }
        if (!Number.isInteger(cents) || cents < MIN_BET) {
            return fail('invalid');
        }
        this.balance = cents;
        this.startingBalance = cents;
        this.emit('balanceSet', { amount: cents });
        return ok();
    }

    // ---- Betting ----

    placeBet(spot, cents) {
        if (!SPOTS.includes(spot)) {
            return fail('invalid');
        }
        if (this.phase !== 'betting') {
            return fail('locked');
        }
        if (!Number.isInteger(cents) || cents < MIN_BET) {
            return fail('invalid');
        }
        if (this.balance < cents) {
            return fail('insufficient');
        }
        this.balance -= cents;
        this.bets[spot] += cents;
        this.emit('betPlaced', { spot, amount: cents });
        return ok();
    }

    clearBets() {
        if (this.phase !== 'betting' || this.totalWagered() === 0) {
            return fail('nothing');
        }
        const refund = this.totalWagered();
        this.balance += refund;
        this.bets = { player: 0, banker: 0, tie: 0 };
        this.emit('betsCleared', { refund });
        return ok();
    }

    // ---- Dealing ----

    canDeal() {
        return this.phase === 'betting' && this.totalWagered() > 0;
    }

    // `stackedCards` optionally supplies the exact cards to deal, in order (P, B, P, B,
    // then any third cards) - only ever passed by tests; the page never does, so every
    // real hand comes from the shuffled shoe.
    deal(stackedCards = null) {
        if (this.phase !== 'betting') {
            return fail('locked');
        }
        if (this.totalWagered() === 0) {
            return fail('nobets');
        }
        if (!stackedCards && this.shoe.needsShuffle()) {
            this.shoe.reset();
            this.emit('shuffled');
        }
        const source = stackedCards ? [...stackedCards] : null;
        const coup = playCoup(() => (source ? source.shift() : this.shoe.draw()));

        const results = SPOTS
            .filter(spot => this.bets[spot] > 0)
            .map(spot => this.settle(spot, this.bets[spot], coup.winner));
        const wagered = this.totalWagered();
        const totalWon = results.reduce((sum, r) => sum + r.payout, 0);

        this.balance += totalWon;
        this.stats.handsPlayed += 1;
        this.stats.totalWagered += wagered;
        this.stats.totalWon += totalWon;
        if (totalWon > this.stats.biggestWin) {
            this.stats.biggestWin = totalWon;
        }
        if (coup.winner === 'player') this.stats.playerWins += 1;
        else if (coup.winner === 'banker') this.stats.bankerWins += 1;
        else this.stats.ties += 1;

        this.history.push(coup.winner);
        if (this.history.length > HISTORY_LENGTH) {
            this.history.shift();
        }

        this.lastCoup = { ...coup, results, wagered, totalWon };
        this.setPhase('results');
        this.emit('coupResolved', this.lastCoup);
        return { ...ok(), coup: this.lastCoup };
    }

    // What one bet pays back (stake included). 0 means it lost; the stake already left
    // the balance when the bet was placed.
    settle(spot, stake, winner) {
        let payout = 0;
        let outcome = 'lost';
        if (spot === 'tie') {
            if (winner === 'tie') {
                payout = stake * (TIE_PAYOUT + 1);
                outcome = 'won';
            }
        } else if (winner === 'tie') {
            payout = stake; // Player and Banker bets push on a tie
            outcome = 'push';
        } else if (winner === spot) {
            const commission = spot === 'banker' ? Math.ceil(stake * BANKER_COMMISSION_PCT / 100) : 0;
            payout = stake * 2 - commission;
            outcome = 'won';
        }
        return { spot, stake, payout, outcome };
    }

    // ---- Between rounds ----

    nextRound() {
        if (this.phase !== 'results') {
            return false;
        }
        this.bets = { player: 0, banker: 0, tie: 0 };
        this.lastCoup = null;
        this.setPhase('betting');
        return true;
    }

    // Out of money with nothing left to do: mid-betting with nothing on the table, or a
    // hand just settled with less than a minimum bet left.
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
        this.bets = { player: 0, banker: 0, tie: 0 };
        this.lastCoup = null;
        this.history = [];
        this.stats = freshEngineStats();
        this.setPhase('betting');
        return true;
    }
}

BaccaratEngine.STARTING_BALANCE = STARTING_BALANCE;
BaccaratEngine.MIN_BET = MIN_BET;
BaccaratEngine.NUM_DECKS = NUM_DECKS;
BaccaratEngine.HISTORY_LENGTH = HISTORY_LENGTH;
BaccaratEngine.SPOTS = SPOTS;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        BaccaratEngine, Shoe, cardPoints, handTotal, playerDraws, bankerDraws, playCoup,
        computeExactOdds, computeOddsTable
    };
}
