'use strict';

// Blackjack rules engine. No DOM, sound, timer or storage code lives here, so it can be
// used by the page (script.js) and by tests running in plain Node.

const STARTING_BALANCE = 1000;

const suits = ['♠', '♥', '♦', '♣'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

const FACE_VALUES = ['K', 'Q', 'J'];

function cardPoints(value) {
    if (value === 'A') {
        return 11;
    }
    return FACE_VALUES.includes(value) ? 10 : parseInt(value, 10);
}

// Basic strategy for a multi-deck shoe where the dealer stands on all 17s,
// doubling after a split is allowed, and late surrender is available.
// Returns 'hit' | 'stand' | 'double' | 'split' | 'surrender', falling back to the
// next best play when an action isn't currently allowed.
function getBasicStrategyAction(cards, dealerUpValue, { canDouble = true, canSplit = true, canSurrender = true } = {}) {
    const up = cardPoints(dealerUpValue);
    const between = (low, high) => up >= low && up <= high;

    const hardTotal = cards.reduce((sum, card) => sum + (card.value === 'A' ? 1 : cardPoints(card.value)), 0);
    const soft = cards.some(card => card.value === 'A') && hardTotal + 10 <= 21;
    const total = soft ? hardTotal + 10 : hardTotal;
    const isPair = cards.length === 2 && cards[0].value === cards[1].value;

    if (isPair && canSplit) {
        const rank = cardPoints(cards[0].value);
        const splitAgainst = {
            11: () => true,
            8: () => true,
            9: () => between(2, 6) || up === 8 || up === 9,
            7: () => between(2, 7),
            6: () => between(2, 6),
            4: () => between(5, 6),
            3: () => between(2, 7),
            2: () => between(2, 7)
        };
        if (splitAgainst[rank] && splitAgainst[rank]()) {
            return 'split';
        }
    }

    if (canSurrender && cards.length === 2 && !soft &&
        ((total === 16 && (up === 9 || up === 10 || up === 11)) || (total === 15 && up === 10))) {
        return 'surrender';
    }

    if (soft) {
        if (total >= 19) {
            return 'stand';
        }
        if (total === 18) {
            if (between(3, 6)) {
                return canDouble ? 'double' : 'stand';
            }
            return (up === 9 || up === 10 || up === 11) ? 'hit' : 'stand';
        }
        const doubleFrom = total <= 14 ? 5 : total <= 16 ? 4 : 3; // soft 13-14, 15-16, 17
        return (between(doubleFrom, 6) && canDouble) ? 'double' : 'hit';
    }

    if (total >= 17) {
        return 'stand';
    }
    if (total >= 13) {
        return between(2, 6) ? 'stand' : 'hit';
    }
    if (total === 12) {
        return between(4, 6) ? 'stand' : 'hit';
    }
    if (total === 11) {
        return (between(2, 10) && canDouble) ? 'double' : 'hit';
    }
    if (total === 10) {
        return (between(2, 9) && canDouble) ? 'double' : 'hit';
    }
    if (total === 9) {
        return (between(3, 6) && canDouble) ? 'double' : 'hit';
    }
    return 'hit';
}

class Deck {
    constructor(numDecks = 6) {
        this.numDecks = numDecks;
        this.reset();
    }

    reset() {
        this.cards = [];
        for (let d = 0; d < this.numDecks; d++) {
            for (let suit of suits) {
                for (let value of values) {
                    this.cards.push({ suit, value });
                }
            }
        }
        this.shuffle();
        this.setNewCutCard();
        this.reshuffleNeeded = false;
    }

    setNewCutCard() {
        // The cut card sits somewhere in the last quarter of the shoe, but never with
        // fewer than 20 cards behind it. It is stored as a number of cards REMAINING:
        // once the shoe is down to that many cards, the next round is the last one.
        const minRemaining = 20;
        const maxRemaining = Math.floor(this.cards.length * 0.25);
        this.cutAtCardsRemaining = Math.floor(Math.random() * (maxRemaining - minRemaining + 1)) + minRemaining;
    }

    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    deal() {
        if (this.cards.length <= this.cutAtCardsRemaining && !this.reshuffleNeeded) {
            this.reshuffleNeeded = true;
            return { card: this.cards.pop(), isLastHand: true };
        }
        return { card: this.cards.pop(), isLastHand: false };
    }

    cardsRemaining() {
        return this.cards.length;
    }

    needsReshuffle() {
        return this.reshuffleNeeded;
    }
}

class Hand {
    constructor() {
        this.cards = [];
        this.bet = 0;
        this.doubledDown = false;
        this.done = false;      // player has finished acting on this hand (stood, doubled, ...)
        this.settled = false;   // the hand has been paid out; it can never be settled again
        this.result = null;     // 'win' | 'loss' | 'push' | 'blackjack' | 'surrender'
    }

    addCard(card) {
        this.cards.push(card);
    }

    getScore() {
        let score = 0;
        let aces = 0;
        for (let card of this.cards) {
            if (card.value === 'A') {
                aces++;
                score += 11;
            } else if (['K', 'Q', 'J'].includes(card.value)) {
                score += 10;
            } else {
                score += parseInt(card.value);
            }
        }
        while (score > 21 && aces > 0) {
            score -= 10;
            aces--;
        }
        return score;
    }

    canSplit() {
        return this.cards.length === 2 && this.cards[0].value === this.cards[1].value;
    }
}

class Player {
    constructor(initialBalance) {
        this.balance = initialBalance;
        this.hands = [new Hand()];
        this.insurance = 0;
    }

    // The only place a hand's wager is paid out. Returns { wager, payout, net },
    // or null if the hand was already settled (so it can never pay twice).
    // hand.bet is left intact so the wager can still be displayed and reported.
    settle(handIndex, outcome) {
        const hand = this.hands[handIndex];
        if (!hand || hand.settled) {
            return null;
        }
        const wager = hand.bet;
        // Payouts are always whole dollars: blackjack pays 3:2 rounded down, and a
        // surrender refund is half the wager rounded up.
        const payouts = {
            win: wager * 2,
            loss: 0,
            push: wager,
            blackjack: wager + Math.floor(wager * 1.5),
            surrender: Math.ceil(wager / 2)
        };
        if (!(outcome in payouts)) {
            throw new Error(`Unknown outcome: ${outcome}`);
        }
        const payout = payouts[outcome];
        this.balance += payout;
        hand.settled = true;
        hand.result = outcome;
        return { wager, payout, net: payout - wager };
    }

    doubleDown(handIndex) {
        const additionalBet = this.hands[handIndex].bet;
        this.balance -= additionalBet;
        this.hands[handIndex].bet += additionalBet;
        this.hands[handIndex].doubledDown = true;
    }

    split(handIndex) {
        const newHand = new Hand();
        newHand.addCard(this.hands[handIndex].cards.pop());
        newHand.bet = this.hands[handIndex].bet;
        this.balance -= newHand.bet;
        this.hands.splice(handIndex + 1, 0, newHand);
    }

    placeInsurance(amount) {
        if (amount > this.balance) {
            throw new Error("Insufficient funds for insurance");
        }
        this.balance -= amount;
        this.insurance = amount;
    }

    winInsurance() {
        this.balance += this.insurance * 3;
        this.insurance = 0;
    }

    loseInsurance() {
        this.insurance = 0;
    }
}

const CHIP_VALUES = [1, 5, 25, 100, 500, 1000];

const ok = () => ({ ok: true });
const fail = reason => ({ ok: false, reason });

// The rules of the game and nothing else: no DOM, sounds, timers or storage. A page
// (or a test) drives it by calling actions and listening to the events it emits:
//
//   phase           { phase }
//   cardDealt       { target: 'player' | 'dealer', handIndex, card, faceUp }
//   cutCard         the cut card was reached; the shoe reshuffles after this round
//   betChanged      { kind: 'added' | 'removed' | 'cleared' | 'set', amount }
//   chips           chips moved for a double, split or insurance
//   openingChecked  { peeked, playerBlackjack, dealerBlackjack }
//   insuranceBought { stake }
//   insuranceSettled{ won, stake, net }
//   settled         { handIndex, outcome, reason, wager, payout, net }
//   streak          { kind: 'hot' | 'cold' }
//   dealerTurn      the dealer is about to play (see autoDealer)
//   reshuffled      the shoe was reshuffled between rounds
//   roundOver       { broke }
//
// Actions that can be refused return { ok: false, reason } (betting, dealing) or false.
// With autoDealer (the default) the dealer's turn plays out immediately, which keeps tests
// simple; a page that animates the dealer sets it to false and drives dealerShouldDraw /
// dealerDraw / finishDealerTurn itself.
class BlackjackEngine {
    constructor({ startingBalance = STARTING_BALANCE, numDecks = 6, autoDealer = true } = {}) {
        this.startingBalance = startingBalance;
        this.autoDealer = autoDealer;
        this.deck = new Deck(numDecks);
        this.player = new Player(startingBalance);
        this.dealer = new Hand();
        this.chips = CHIP_VALUES;
        this.currentHandIndex = 0;
        this.gamePhase = 'betting';
        this.currentBet = 0;
        this.chipsInPot = [];
        this.lastBet = 0;                   // wager of the previous round, for Rebet
        this.streakCounter = 0;
        this.reshuffleAfterRound = false;   // the cut card was reached during this round
        this.allowSplit = true;
        this.allowDoubleDown = true;
        this.allowSurrender = true;
        this.allowInsurance = true;
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
        this.gamePhase = phase;
        this.emit('phase', { phase });
    }

    // ---- Betting ----

    placeBet(amount) {
        if (this.gamePhase !== 'betting') {
            return fail('locked');
        }
        if (!Number.isInteger(amount) || amount < 1) {
            return fail('invalid');
        }
        if (amount > this.player.balance) {
            return fail('insufficient');
        }
        this.currentBet += amount;
        this.player.balance -= amount;
        this.chipsInPot.push(amount);
        this.emit('betChanged', { kind: 'added', amount });
        return ok();
    }

    removeBet(amount) {
        if (this.gamePhase !== 'betting') {
            return fail('locked');
        }
        const index = this.chipsInPot.indexOf(amount);
        if (index === -1) {
            return fail('nothing');
        }
        this.chipsInPot.splice(index, 1);
        this.currentBet -= amount;
        this.player.balance += amount;
        this.emit('betChanged', { kind: 'removed', amount });
        return ok();
    }

    clearBet() {
        if (this.gamePhase !== 'betting') {
            return fail('locked');
        }
        this.player.balance += this.currentBet;
        this.currentBet = 0;
        this.chipsInPot = [];
        this.emit('betChanged', { kind: 'cleared' });
        return ok();
    }

    // Sets the whole bet to an exact whole-dollar amount, replacing any chips already
    // in the pot. The amount is broken into the largest chips that fit.
    setBet(amount) {
        if (this.gamePhase !== 'betting') {
            return fail('locked');
        }
        if (!Number.isInteger(amount) || amount < 1) {
            return fail('invalid');
        }
        if (amount > this.player.balance + this.currentBet) {
            return fail('insufficient');
        }
        this.player.balance += this.currentBet;
        this.chipsInPot = [];
        let remaining = amount;
        for (const chip of [...this.chips].sort((a, b) => b - a)) {
            while (remaining >= chip) {
                this.chipsInPot.push(chip);
                remaining -= chip;
            }
        }
        this.currentBet = amount;
        this.player.balance -= amount;
        this.emit('betChanged', { kind: 'set', amount });
        return ok();
    }

    canRebet() {
        return this.gamePhase === 'betting' &&
               this.lastBet > 0 &&
               this.lastBet <= this.player.balance + this.currentBet;
    }

    rebet() {
        return this.canRebet() ? this.setBet(this.lastBet) : fail('nothing');
    }

    // ---- Dealing ----

    // Deals the opening round in one go. A page that animates the deal uses the three
    // steps below itself: beginDeal, dealInitialCards, beginPlay.
    deal() {
        const started = this.beginDeal();
        if (started.ok) {
            this.dealInitialCards();
            this.beginPlay();
        }
        return started;
    }

    beginDeal() {
        if (this.gamePhase !== 'betting') {
            return fail('locked');
        }
        if (this.currentBet === 0) {
            return fail('nobet');
        }
        this.lastBet = this.currentBet;
        this.player.insurance = 0;
        this.player.hands = [new Hand()];
        this.player.hands[0].bet = this.currentBet;
        this.dealer = new Hand();
        this.currentHandIndex = 0;
        this.setPhase('dealing');
        return ok();
    }

    // Deals player, dealer, player, dealer (the dealer's second card face down) and
    // returns the four cards in order.
    dealInitialCards() {
        const hand = this.player.hands[0];
        return [
            { target: 'player', handIndex: 0, faceUp: true, card: this.dealTo(hand, 'player', 0, true) },
            { target: 'dealer', handIndex: null, faceUp: true, card: this.dealTo(this.dealer, 'dealer', null, true) },
            { target: 'player', handIndex: 0, faceUp: true, card: this.dealTo(hand, 'player', 0, true) },
            { target: 'dealer', handIndex: null, faceUp: false, card: this.dealTo(this.dealer, 'dealer', null, false) }
        ];
    }

    drawCard() {
        const { card, isLastHand } = this.deck.deal();
        if (isLastHand && !this.reshuffleAfterRound) {
            this.reshuffleAfterRound = true;
            this.emit('cutCard');
        }
        return card;
    }

    dealTo(hand, target, handIndex, faceUp = true) {
        const card = this.drawCard();
        hand.addCard(card);
        this.emit('cardDealt', { target, handIndex, card, faceUp });
        return card;
    }

    // Called once the initial deal is complete. The dealer's blackjack is only
    // checked after the player has had the chance to take (or decline) insurance.
    beginPlay() {
        if (this.canOfferInsurance()) {
            this.setPhase('insurance');
        } else {
            this.resolveOpeningHands();
        }
    }

    // ---- Insurance ----

    // Insurance costs half the wager, rounded down to whole dollars (minimum $1).
    insuranceStake() {
        return Math.floor(this.player.hands[0].bet / 2);
    }

    canOfferInsurance() {
        const stake = this.insuranceStake();
        return this.allowInsurance &&
               this.dealer.cards[0].value === 'A' &&
               stake >= 1 &&
               this.player.balance >= stake;
    }

    canInsurance() {
        return this.gamePhase === 'insurance' && this.player.balance >= this.insuranceStake();
    }

    canDeclineInsurance() {
        return this.gamePhase === 'insurance';
    }

    buyInsurance() {
        if (!this.canInsurance()) {
            return false;
        }
        const stake = this.insuranceStake();
        this.player.placeInsurance(stake);
        this.emit('chips');
        this.emit('insuranceBought', { stake });
        this.resolveOpeningHands();
        return true;
    }

    declineInsurance() {
        if (!this.canDeclineInsurance()) {
            return false;
        }
        this.resolveOpeningHands();
        return true;
    }

    settleInsurance(dealerHasBlackjack) {
        const stake = this.player.insurance;
        if (dealerHasBlackjack) {
            this.player.winInsurance();
        } else {
            this.player.loseInsurance();
        }
        this.emit('insuranceSettled', { won: dealerHasBlackjack, stake, net: dealerHasBlackjack ? stake * 2 : -stake });
    }

    // Checks both sides for blackjack (after any insurance decision) and either
    // settles the round immediately or hands control to the player. With a ten-value
    // card or an Ace showing, the dealer "peeks" at the hole card first.
    resolveOpeningHands() {
        const hand = this.player.hands[0];
        const playerBlackjack = hand.getScore() === 21;
        const dealerBlackjack = this.dealer.getScore() === 21;
        const peeked = cardPoints(this.dealer.cards[0].value) >= 10;
        this.emit('openingChecked', { peeked, playerBlackjack, dealerBlackjack });

        if (this.player.insurance > 0) {
            this.settleInsurance(dealerBlackjack);
        }

        if (playerBlackjack && dealerBlackjack) {
            this.settleHand(0, 'push', 'both-blackjack');
        } else if (playerBlackjack) {
            this.settleHand(0, 'blackjack', 'blackjack');
        } else if (dealerBlackjack) {
            this.settleHand(0, 'loss', 'dealer-blackjack');
        } else {
            this.setPhase('playerTurn');
            this.currentHandIndex = 0;
            return;
        }
        hand.done = true;
        this.finishRound();
    }

    // ---- Player actions ----

    hit(handIndex) {
        if (!this.canHit(handIndex)) {
            return false;
        }
        this.drawToHand(handIndex);
        return true;
    }

    // Deals one card to a hand and resolves a bust or a doubled hand.
    // Shared by hit and double down so a doubled hand can take its one card.
    drawToHand(handIndex) {
        const hand = this.player.hands[handIndex];
        this.dealTo(hand, 'player', handIndex);
        if (hand.getScore() > 21) {
            hand.done = true;
            this.settleHand(handIndex, 'loss');
            this.advanceToNextHand();
        } else if (hand.doubledDown || hand.getScore() === 21) {
            this.stand(handIndex); // a doubled hand is done, and there is no reason to hit on 21
        }
    }

    stand(handIndex) {
        if (!this.canStand(handIndex)) {
            return false;
        }
        this.player.hands[handIndex].done = true;
        this.advanceToNextHand();
        return true;
    }

    // Moves to the next hand that still needs playing. When there is none, the
    // dealer plays if any hand is still live; otherwise the round is over.
    advanceToNextHand() {
        const next = this.player.hands.findIndex((hand, index) => index > this.currentHandIndex && !hand.settled);
        if (next !== -1) {
            this.currentHandIndex = next;
        } else if (this.player.hands.some(hand => !hand.settled)) {
            this.startDealerTurn();
        } else {
            this.finishRound();
        }
    }

    doubleDown(handIndex) {
        if (!this.canDouble(handIndex)) {
            return false;
        }
        this.player.doubleDown(handIndex);
        this.emit('chips');
        this.drawToHand(handIndex);
        return true;
    }

    split(handIndex) {
        if (!this.canSplit(handIndex)) {
            return false;
        }
        this.player.split(handIndex);
        this.emit('chips');
        this.dealTo(this.player.hands[handIndex], 'player', handIndex);
        this.dealTo(this.player.hands[handIndex + 1], 'player', handIndex + 1);
        this.standOnTwentyOne();
        return true;
    }

    // After a split a hand can land on 21; skip past any such hands automatically.
    standOnTwentyOne() {
        while (this.gamePhase === 'playerTurn' && this.player.hands[this.currentHandIndex].getScore() === 21) {
            this.stand(this.currentHandIndex);
        }
    }

    surrender() {
        if (!this.canSurrender()) {
            return false;
        }
        const handIndex = this.currentHandIndex;
        this.player.hands[handIndex].done = true;
        this.settleHand(handIndex, 'surrender');
        this.advanceToNextHand();
        return true;
    }

    // ---- Dealer ----

    startDealerTurn() {
        this.setPhase('dealerTurn');
        this.emit('dealerTurn');
        if (this.autoDealer) {
            this.playDealerTurn();
        }
    }

    dealerShouldDraw() {
        return this.dealer.getScore() < 17;
    }

    dealerDraw() {
        return this.dealTo(this.dealer, 'dealer', null, true);
    }

    finishDealerTurn() {
        this.determineWinner();
        this.finishRound();
    }

    playDealerTurn() {
        while (this.dealerShouldDraw()) {
            this.dealerDraw();
        }
        this.finishDealerTurn();
    }

    determineWinner() {
        const dealerScore = this.dealer.getScore();
        this.player.hands.forEach((hand, index) => {
            if (hand.settled) {
                return;
            }
            const playerScore = hand.getScore();
            if (playerScore > 21) {
                this.settleHand(index, 'loss');
            } else if (dealerScore > 21 || playerScore > dealerScore) {
                this.settleHand(index, 'win');
            } else if (playerScore < dealerScore) {
                this.settleHand(index, 'loss');
            } else {
                this.settleHand(index, 'push');
            }
        });
    }

    // ---- Settlement and round flow ----

    // Pays and records ONE hand, exactly once. It does not end the round: other
    // split hands may still be in play (see advanceToNextHand / finishRound).
    settleHand(handIndex, outcome, reason = null) {
        const settlement = this.player.settle(handIndex, outcome);
        if (!settlement) {
            return;
        }
        if (outcome === 'win' || outcome === 'blackjack') {
            this.streakCounter = Math.max(0, this.streakCounter + 1);
        } else if (outcome === 'loss') {
            this.streakCounter = Math.min(0, this.streakCounter - 1);
        } else if (outcome === 'surrender') {
            this.streakCounter = 0;
        }
        this.emit('settled', { handIndex, outcome, reason, ...settlement });
        if (this.streakCounter === 3) {
            this.emit('streak', { kind: 'hot' });
        } else if (this.streakCounter === -3) {
            this.emit('streak', { kind: 'cold' });
        }
    }

    // Ends the round once every hand has been settled.
    finishRound() {
        this.setPhase('gameOver');
        if (this.reshuffleAfterRound) {
            this.reshuffleShoe();
        }
        this.emit('roundOver', { broke: this.isBroke() });
    }

    reshuffleShoe() {
        this.deck.reset();
        this.reshuffleAfterRound = false;
        this.emit('reshuffled');
    }

    // Out of money at the end of a round: there is nothing left to bet.
    isBroke() {
        return this.gamePhase === 'gameOver' && this.player.balance < 1;
    }

    prepareNextHand() {
        if (this.gamePhase !== 'gameOver') {
            return false;
        }
        this.currentHandIndex = 0;
        this.currentBet = 0;
        this.chipsInPot = [];
        this.player.hands = [new Hand()];
        this.dealer = new Hand();
        this.setPhase('betting');
        return true;
    }

    restart() {
        if (!this.isBroke()) {
            return false;
        }
        this.player.balance = this.startingBalance;
        this.streakCounter = 0;
        this.lastBet = 0;
        return this.prepareNextHand();
    }

    // ---- What the player may do right now ----

    canHit(handIndex = this.currentHandIndex) {
        const hand = this.player.hands[handIndex];
        return this.gamePhase === 'playerTurn' && !!hand && !hand.settled && !hand.doubledDown;
    }

    canStand(handIndex = this.currentHandIndex) {
        const hand = this.player.hands[handIndex];
        return this.gamePhase === 'playerTurn' && !!hand && !hand.settled;
    }

    canDouble(handIndex = this.currentHandIndex) {
        const hand = this.player.hands[handIndex];
        return this.allowDoubleDown &&
               this.canStand(handIndex) &&
               hand.cards.length === 2 &&
               this.player.balance >= hand.bet;
    }

    // Single source of truth for splitting: the Split button and the split action
    // both go through here. Only two cards of the same rank may be split.
    canSplit(handIndex = this.currentHandIndex) {
        const hand = this.player.hands[handIndex];
        return this.allowSplit &&
               this.canStand(handIndex) &&
               hand.canSplit() &&
               this.player.balance >= hand.bet &&
               this.player.hands.length < 4; // Limit to 4 hands (3 splits)
    }

    canSurrender(handIndex = this.currentHandIndex) {
        const hand = this.player.hands[handIndex];
        return this.allowSurrender &&
               this.canStand(handIndex) &&
               hand.cards.length === 2 &&
               this.player.hands.length === 1; // no surrender after splitting
    }

    canHint() {
        return this.gamePhase === 'insurance' || (this.gamePhase === 'playerTurn' && this.canStand());
    }

    // What basic strategy recommends right now: 'decline-insurance', or an action
    // ('hit' | 'stand' | 'double' | 'split' | 'surrender'), or null.
    getHint() {
        if (!this.canHint()) {
            return null;
        }
        if (this.gamePhase === 'insurance') {
            return 'decline-insurance';
        }
        const handIndex = this.currentHandIndex;
        return getBasicStrategyAction(
            this.player.hands[handIndex].cards,
            this.dealer.cards[0].value,
            {
                canDouble: this.canDouble(handIndex),
                canSplit: this.canSplit(handIndex),
                canSurrender: this.canSurrender(handIndex)
            }
        );
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { STARTING_BALANCE, CHIP_VALUES, cardPoints, getBasicStrategyAction, Deck, Hand, Player, BlackjackEngine };
}
