const STARTING_BALANCE = 1000;

const suits = ['♠', '♥', '♦', '♣'];
const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// Initialize sound effects
const cardSound = new Audio('sounds/card.wav');
const chipSound = new Audio('sounds/chip.wav');
const winSound = new Audio('sounds/win.mp3');
const loseSound = new Audio('sounds/lose.mp3');
const drawSound = new Audio('sounds/draw.wav');
const clickSound = new Audio('sounds/click.wav');

// Function to play sound
function playSound(sound) {
    sound.currentTime = 0;
    sound.play();
}

// Save and load statistics
function saveStats() {
    localStorage.setItem('blackjackStats', JSON.stringify(gameStats));
}

function loadStats() {
    const stats = localStorage.getItem('blackjackStats');
    return stats ? JSON.parse(stats) : { gamesPlayed: 0, gamesWon: 0, totalMoney: 0 };
}

function formatMoney(amount) {
    return `${amount < 0 ? '-' : ''}$${Math.abs(amount)}`;
}

// Update stats display
function updateStatsDisplay() {
    const line = (label, stats) =>
        `${label}: ${stats.gamesPlayed} played, ${stats.gamesWon} won, ${formatMoney(stats.totalMoney)}`;
    document.getElementById('stats').textContent =
        `${line('Session', sessionStats)}  |  ${line('Lifetime', gameStats)}`;
}

// Lifetime statistics persist in localStorage; session statistics start fresh
// on every page load, together with the bankroll.
let gameStats = loadStats();
let sessionStats = { gamesPlayed: 0, gamesWon: 0, totalMoney: 0 };

// Record settled hands and/or money movement in both the session and lifetime stats.
function recordStats({ net = 0, hands = 0, won = 0 }) {
    for (const stats of [gameStats, sessionStats]) {
        stats.gamesPlayed += hands;
        stats.gamesWon += won;
        stats.totalMoney += net;
    }
    saveStats();
    updateStatsDisplay();
}

updateStatsDisplay();

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
        playSound(cardSound);
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

    placeBet(amount, handIndex = 0) {
        if (amount > this.balance) {
            throw new Error("Insufficient funds");
        }
        this.balance -= amount;
        this.hands[handIndex].bet += amount;
        playSound(chipSound);
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
        playSound(chipSound);
    }

    split(handIndex) {
        const newHand = new Hand();
        newHand.addCard(this.hands[handIndex].cards.pop());
        newHand.bet = this.hands[handIndex].bet;
        this.balance -= newHand.bet;
        this.hands.splice(handIndex + 1, 0, newHand);
        playSound(chipSound);
    }

    placeInsurance(amount) {
        if (amount > this.balance) {
            throw new Error("Insufficient funds for insurance");
        }
        this.balance -= amount;
        this.insurance = amount;
        playSound(chipSound);
    }

    winInsurance() {
        this.balance += this.insurance * 3;
        this.insurance = 0;
    }

    loseInsurance() {
        this.insurance = 0;
    }
}

class Game {
    constructor(playerBalance, numDecks = 6) {
        this.deck = new Deck(numDecks);
        this.player = new Player(playerBalance);
        this.dealer = new Hand();
        this.currentHandIndex = 0;
        this.gamePhase = 'betting';
        this.currentBet = 0;
        this.allowSplit = true;
        this.allowDoubleDown = true;
        this.allowSurrender = true;
        this.allowInsurance = true;
        this.chipsInPot = [];
        this.streakCounter = 0;
        this.initializeChips();
        this.themes = ['theme1', 'theme2', 'theme3'];
        this.currentTheme = 0;
        this.lastHandBeforeReshuffle = false;
        this.lastBet = 0;         // wager of the previous round, for Rebet
        this.roundMessages = [];  // result messages collected over the current round
        this.pendingPopups = [];  // per-hand result popups waiting for the next render
    }

    initializeChips() {
        this.availableChips = [1, 5, 25, 100, 500, 1000].filter(chip => chip <= this.player.balance);
        this.updateChips();
    }

    placeBet(amount) {
        if (this.gamePhase !== 'betting') {
            setMessage("You can only place bets before dealing.");
            return false;
        }
        if (amount > this.player.balance) {
            setMessage("Insufficient funds for this bet.");
            return false;
        }
        this.currentBet += amount;
        this.player.balance -= amount;
        this.chipsInPot.push(amount);
        this.updateUI();
        setMessage(`Added $${amount} to the bet. Total bet: $${this.currentBet}`);
        playSound(chipSound);
        this.animateChip(amount);
        return true;
    }

    removeBet(amount) {
        if (this.gamePhase !== 'betting') {
            setMessage('Bets are locked once dealing begins.');
            return false;
        }
        const index = this.chipsInPot.indexOf(amount);
        if (index > -1) {
            this.chipsInPot.splice(index, 1);
            this.currentBet -= amount;
            this.player.balance += amount;
            this.updateUI();
            setMessage(`Removed $${amount} from the bet. Total bet: $${this.currentBet}`);
            playSound(chipSound);
            return true;
        }
        return false;
    }

    clearBet() {
        if (this.gamePhase !== 'betting') {
            setMessage('Bets are locked once dealing begins.');
            return false;
        }
        this.player.balance += this.currentBet;
        this.currentBet = 0;
        this.chipsInPot = [];
        this.updateUI();
        setMessage("Bet cleared.");
        playSound(chipSound);
        return true;
    }

    // Sets the whole bet to an exact whole-dollar amount, replacing any chips already
    // in the pot. The amount is broken into the largest chips that fit.
    setBet(amount) {
        if (this.gamePhase !== 'betting') {
            setMessage('Bets are locked once dealing begins.');
            return false;
        }
        if (!Number.isInteger(amount) || amount < 1) {
            setMessage('Enter a whole-dollar bet of at least $1.');
            return false;
        }
        if (amount > this.player.balance + this.currentBet) {
            setMessage('Insufficient funds for this bet.');
            return false;
        }
        this.player.balance += this.currentBet;
        this.chipsInPot = [];
        let remaining = amount;
        for (const chip of [...this.availableChips].sort((a, b) => b - a)) {
            while (remaining >= chip) {
                this.chipsInPot.push(chip);
                remaining -= chip;
            }
        }
        this.currentBet = amount;
        this.player.balance -= amount;
        this.updateUI();
        setMessage(`Bet set to $${amount}.`);
        playSound(chipSound);
        return true;
    }

    canRebet() {
        return this.gamePhase === 'betting' &&
               this.lastBet > 0 &&
               this.lastBet <= this.player.balance + this.currentBet;
    }

    rebet() {
        if (!this.canRebet()) {
            setMessage('Nothing to rebet.');
            return false;
        }
        return this.setBet(this.lastBet);
    }

    deal() {
        if (this.gamePhase !== 'betting') {
            return;
        }
        if (this.currentBet === 0) {
            setMessage("Please place a bet first.");
            return;
        }

        this.lastBet = this.currentBet;
        this.roundMessages = [];
        this.pendingPopups = [];
        this.player.insurance = 0;
        this.player.hands = [new Hand()];
        this.player.hands[0].bet = this.currentBet;
        this.dealer = new Hand();

        const dealSequence = [
            { target: this.player.hands[0], faceUp: true },
            { target: this.dealer, faceUp: true },
            { target: this.player.hands[0], faceUp: true },
            { target: this.dealer, faceUp: false }
        ];

        this.gamePhase = 'dealing';
        this.updateUI();

        // Clear existing cards
        document.querySelector('.hand-cards').innerHTML = '';
        document.getElementById('dealer-cards').innerHTML = '';

        let lastHandTriggered = false;

        dealSequence.forEach((deal, index) => {
            setTimeout(() => {
                const { card, isLastHand } = this.deck.deal();
                deal.target.addCard(card);
                this.animateDealCard(deal.target, card, deal.faceUp, index);

                if (isLastHand && !lastHandTriggered) {
                    this.lastHandBeforeReshuffle = true;
                    this.showCutCard();
                    lastHandTriggered = true;
                }

                if (index === dealSequence.length - 1) {
                    setTimeout(() => {
                        this.currentHandIndex = 0;
                        this.updateShoeDisplay();
                        this.beginPlay();
                    }, 500);
                }
            }, index * 500);
        });

        // Update the UI to show remaining cards in the shoe
        document.getElementById('cards-remaining').textContent = `Cards in shoe: ${this.deck.cardsRemaining()}`;
    }

    showCutCard() {
        const cutCard = document.createElement('div');
        cutCard.className = 'cut-card';
        cutCard.textContent = 'RESHUFFLE';
        document.getElementById('dealer-cards').appendChild(cutCard);
        
        setTimeout(() => {
            cutCard.style.transform = 'translateY(-100%)';
        }, 100);

        setTimeout(() => {
            cutCard.remove();
        }, 3000);
    }

    animateDealCard(target, card, faceUp, index) {
        const handElement = target === this.dealer ? document.getElementById('dealer-cards') : document.querySelector('.hand-cards');
        const cardElement = document.createElement('div');
        cardElement.className = `card ${faceUp ? '' : 'card-back'}`;
        cardElement.style.opacity = '0';
        cardElement.style.transform = 'translateY(-100px) translateX(-100px) rotate(-90deg)';
        
        if (faceUp) {
            cardElement.innerHTML = this.createCardInnerHTML(card);
            cardElement.classList.add(card.suit === '♥' || card.suit === '♦' ? 'red' : 'black');
        } else {
            cardElement.style.backgroundColor = '#0063B3';
            cardElement.style.backgroundImage = `repeating-linear-gradient(45deg, #0063B3, #0063B3 5px, #004C8C 5px, #004C8C 10px)`;
        }

        handElement.appendChild(cardElement);

        // Trigger reflow
        void cardElement.offsetWidth;

        // Apply the animation
        cardElement.style.transition = 'all 0.5s ease-out';
        cardElement.style.opacity = '1';
        cardElement.style.transform = 'translateY(0) translateX(0) rotate(0)';

        playSound(cardSound);
    }

    createCardInnerHTML(card) {
        const suitSymbols = {
            '♠': '&spades;',
            '♥': '&hearts;',
            '♦': '&diams;',
            '♣': '&clubs;'
        };
        
        let color = (card.suit === '♥' || card.suit === '♦') ? 'red' : 'black';
        let symbol = suitSymbols[card.suit] || card.suit;
        
        return `
            <div class="card-corner top-left">
                <div class="card-value">${card.value}</div>
                <div class="card-suit">${symbol}</div>
            </div>
            <div class="card-center-suit">${symbol}</div>
            <div class="card-corner bottom-right">
                <div class="card-value">${card.value}</div>
                <div class="card-suit">${symbol}</div>
            </div>
        `;
    }

    noteCutCard(isLastHand) {
        if (isLastHand && !this.lastHandBeforeReshuffle) {
            this.lastHandBeforeReshuffle = true;
            this.showCutCard();
        }
    }

    hit(handIndex) {
        if (!this.canHit(handIndex)) {
            return;
        }
        this.drawToHand(handIndex);
    }

    // Deals one card to a hand and resolves a bust or a doubled hand.
    // Shared by hit and double down so a doubled hand can take its one card.
    drawToHand(handIndex) {
        const hand = this.player.hands[handIndex];
        const { card, isLastHand } = this.deck.deal();
        hand.addCard(card);
        this.noteCutCard(isLastHand);
        if (hand.getScore() > 21) {
            hand.done = true;
            this.settleHand(handIndex, 'loss');
            this.advanceToNextHand();
        } else if (hand.doubledDown || hand.getScore() === 21) {
            this.stand(handIndex); // a doubled hand is done, and there is no reason to hit on 21
        }
        this.updateUI();
        this.updateShoeDisplay();
    }

    stand(handIndex) {
        this.player.hands[handIndex].done = true;
        this.advanceToNextHand();
    }

    // Moves to the next hand that still needs playing. When there is none, the
    // dealer plays if any hand is still live; otherwise the round is over.
    advanceToNextHand() {
        const next = this.player.hands.findIndex((hand, index) => index > this.currentHandIndex && !hand.settled);
        if (next !== -1) {
            this.currentHandIndex = next;
            this.updateUI();
        } else if (this.player.hands.some(hand => !hand.settled)) {
            this.dealerPlay();
        } else {
            this.finishRound();
        }
    }

    doubleDown(handIndex) {
        if (!this.canDouble(handIndex)) {
            setMessage("Cannot double down. Insufficient funds or more than two cards in hand.");
            return;
        }
        this.player.doubleDown(handIndex);
        this.drawToHand(handIndex);
    }

    split(handIndex) {
        if (!this.canSplit(handIndex)) {
            setMessage("Cannot split. Cards must match, you need funds for the extra bet, and four hands is the limit.");
            return;
        }
        this.player.split(handIndex);
        const { card: card1, isLastHand: isLastHand1 } = this.deck.deal();
        const { card: card2, isLastHand: isLastHand2 } = this.deck.deal();
        this.player.hands[handIndex].addCard(card1);
        this.player.hands[handIndex + 1].addCard(card2);
        this.noteCutCard(isLastHand1 || isLastHand2);
        this.standOnTwentyOne();
        this.updateUI();
        this.updateShoeDisplay();
    }

    // After a split a hand can land on 21; skip past any such hands automatically.
    standOnTwentyOne() {
        while (this.gamePhase === 'playerTurn' && this.player.hands[this.currentHandIndex].getScore() === 21) {
            this.stand(this.currentHandIndex);
        }
    }

    surrender() {
        if (!this.canSurrender()) {
            setMessage("You can only surrender on your first action.");
            return;
        }
        const handIndex = this.currentHandIndex;
        this.player.hands[handIndex].done = true;
        this.settleHand(handIndex, 'surrender');
        this.advanceToNextHand();
    }

    // Called once the initial deal is complete. The dealer's blackjack is only
    // checked after the player has had the chance to take (or decline) insurance.
    beginPlay() {
        if (this.canOfferInsurance()) {
            this.gamePhase = 'insurance';
            setMessage("Dealer's up card is an Ace. Would you like to buy insurance?");
            this.updateUI();
        } else {
            this.resolveOpeningHands();
        }
    }

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

    buyInsurance() {
        if (!this.canInsurance()) {
            return;
        }
        const insuranceAmount = this.insuranceStake();
        this.player.placeInsurance(insuranceAmount);
        this.roundMessages.push(`Insurance bought for $${insuranceAmount}.`);
        this.resolveOpeningHands();
    }

    declineInsurance() {
        if (!this.canDeclineInsurance()) {
            return;
        }
        this.resolveOpeningHands();
    }

    settleInsurance(dealerHasBlackjack) {
        const stake = this.player.insurance;
        if (dealerHasBlackjack) {
            this.player.winInsurance();
            recordStats({ net: stake * 2 });
            this.roundMessages.push(`Dealer has Blackjack. Insurance pays 2:1 (+$${stake * 2}).`);
        } else {
            this.player.loseInsurance();
            recordStats({ net: -stake });
            this.roundMessages.push(`Dealer does not have Blackjack. Insurance lost (-$${stake}).`);
        }
    }

    // Checks both sides for blackjack (after any insurance decision) and either
    // settles the round immediately or hands control to the player.
    resolveOpeningHands() {
        const hand = this.player.hands[0];
        const playerBlackjack = hand.getScore() === 21;
        const dealerBlackjack = this.dealer.getScore() === 21;

        if (this.player.insurance > 0) {
            this.settleInsurance(dealerBlackjack);
        }

        if (playerBlackjack && dealerBlackjack) {
            this.showBlackjackPopup("Double Blackjack!");
            this.settleHand(0, 'push', "Both have Blackjack! It's a push.");
        } else if (playerBlackjack) {
            this.showBlackjackPopup("Blackjack!");
            this.settleHand(0, 'blackjack');
        } else if (dealerBlackjack) {
            this.showBlackjackPopup("Dealer Blackjack!");
            this.settleHand(0, 'loss', "Dealer has Blackjack! You lose.");
        } else {
            this.gamePhase = 'playerTurn';
            this.currentHandIndex = 0;
            this.updateUI();
            return;
        }
        hand.done = true;
        this.finishRound();
    }

    dealerPlay() {
        this.gamePhase = 'dealerTurn';
        this.updateUI();
        this.updateShoeDisplay();
    
        // Reveal the dealer's hidden card first
        const hiddenCard = document.querySelector('#dealer-cards .card-back');
        if (hiddenCard) {
            hiddenCard.className = 'card';
            hiddenCard.innerHTML = this.createCardInnerHTML(this.dealer.cards[1]);
            playSound(cardSound);
        }
    
        setTimeout(() => {
            const dealerPlaySequence = async () => {
                while (this.dealer.getScore() < 17) {
                    await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
                    const { card, isLastHand } = this.deck.deal();
                    this.dealer.addCard(card);
                    this.animateDealCard(this.dealer, card, true, this.dealer.cards.length - 1);
                    this.noteCutCard(isLastHand);
                    this.updateUI();
                }
                this.determineWinner();
            };
    
            dealerPlaySequence();
        }, 1000); // 1 second delay before starting to draw new cards
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
        this.finishRound();
    }

    showBlackjackPopup(message) {
        const popup = document.createElement('div');
        popup.className = 'blackjack-popup';
        popup.textContent = message;
        document.body.appendChild(popup);

        // Play a special sound for Blackjack
        const blackjackSound = new Audio('sounds/blackjack.mp3');
        blackjackSound.play();

        setTimeout(() => {
            popup.style.animation = 'none'; // Stop the animation
            popup.offsetHeight; // Trigger reflow
            popup.style.animation = null; // Remove the animation property
            popup.style.opacity = '0';
            popup.style.transform = 'translate(-50%, -50%) scale(0.5)';
            popup.style.transition = 'opacity 0.3s, transform 0.3s';

            setTimeout(() => {
                popup.remove();
            }, 300);
        }, 3000);
    }

    // Pays and records ONE hand, exactly once. It does not end the round: other
    // split hands may still be in play (see advanceToNextHand / finishRound).
    settleHand(handIndex, outcome, customMessage = null) {
        const settlement = this.player.settle(handIndex, outcome);
        if (!settlement) {
            return;
        }
        const { wager, net } = settlement;
        let text = '';
        let popupMessage = '';

        switch (outcome) {
            case 'win':
                text = `You win $${net}!`;
                popupMessage = `WIN<br>$${net}`;
                playSound(winSound);
                this.streakCounter = Math.max(0, this.streakCounter + 1);
                break;
            case 'loss':
                text = `You lose $${wager}.`;
                popupMessage = `LOSE<br>$${wager}`;
                playSound(loseSound);
                this.streakCounter = Math.min(0, this.streakCounter - 1);
                break;
            case 'push':
                text = "It's a push. Your bet is returned.";
                popupMessage = 'PUSH';
                playSound(drawSound);
                break;
            case 'blackjack':
                text = `Blackjack! You win $${net}!`;
                popupMessage = `BLACKJACK<br>$${net}`;
                this.streakCounter = Math.max(0, this.streakCounter + 1);
                break;
            case 'surrender':
                text = `You surrendered. $${settlement.payout} of your $${wager} bet is returned.`;
                popupMessage = `SURRENDER<br>$${settlement.payout} returned`;
                playSound(drawSound);
                this.streakCounter = 0;
                break;
        }

        recordStats({ net, hands: 1, won: (outcome === 'win' || outcome === 'blackjack') ? 1 : 0 });
        this.roundMessages.push(customMessage || `Hand ${handIndex + 1}: ${text}`);
        setMessage(this.roundMessages.join(' '));
        this.pendingPopups.push({ message: popupMessage, handIndex });
        this.checkHotStreak();
    }

    // Ends the round once every hand has been settled.
    finishRound() {
        this.gamePhase = 'gameOver';
        if (this.lastHandBeforeReshuffle) {
            this.reshuffleShoe();
        }
        if (this.isBroke()) {
            this.roundMessages.push("You're out of money!");
        }
        setMessage(this.roundMessages.join(' '));
        this.updateUI();
        document.getElementById('next-hand').style.display = this.isBroke() ? 'none' : 'inline-block';
    }

    // Out of money at the end of a round: there is nothing left to bet.
    isBroke() {
        return this.gamePhase === 'gameOver' && this.player.balance < 1;
    }

    restart() {
        if (!this.isBroke()) {
            return;
        }
        this.player.balance = STARTING_BALANCE;
        this.streakCounter = 0;
        this.lastBet = 0;
        this.prepareNextHand();
        setMessage(`New game. You start again with $${STARTING_BALANCE}.`);
    }

    reshuffleShoe() {
        this.roundMessages.push("Reshuffling the deck for the next hand.");
        this.deck.reset();
        this.lastHandBeforeReshuffle = false;
        // Animate shoe being reshuffled
        this.animateReshuffle();
    }

    updateShoeDisplay() {
        const totalCards = this.deck.numDecks * 52;
        const remainingCards = this.deck.cardsRemaining();
        const fillPercentage = (remainingCards / totalCards) * 100;

        const shoeFill = document.getElementById('shoe-fill');
        shoeFill.style.height = `${fillPercentage}%`;

        document.getElementById('cards-remaining').textContent = `Cards in shoe: ${remainingCards}`;
    }

    animateReshuffle() {
        const shoeElement = document.getElementById('shoe');
        shoeElement.classList.add('reshuffling');
        setTimeout(() => {
            shoeElement.classList.remove('reshuffling');
            this.updateShoeDisplay();
        }, 2000);
    }

    showPopupMessage(message, handIndex) {
        const handElement = document.querySelectorAll('.hand')[handIndex];
        if (!handElement) {
            console.error(`Hand element not found for index ${handIndex}`);
            return;
        }
        const popup = document.createElement('div');
        popup.className = 'result-popup';
        popup.innerHTML = message;
        handElement.appendChild(popup);

        setTimeout(() => {
            popup.remove();
        }, 3000);
    }

    checkHotStreak() {
        if (this.streakCounter === 3) {
            this.showHotStreakAnimation();
        } else if (this.streakCounter === -3) {
            this.showColdStreakAnimation();
        }
    }

    showHotStreakAnimation() {
        const gameContainer = document.getElementById('game-container');
        const streakMsg = document.createElement('div');
        streakMsg.className = 'streak-message hot-streak';
        streakMsg.textContent = "You're on fire! 🔥";
        gameContainer.appendChild(streakMsg);

        setTimeout(() => {
            streakMsg.remove();
        }, 3000);
    }

    showColdStreakAnimation() {
        const gameContainer = document.getElementById('game-container');
        const streakMsg = document.createElement('div');
        streakMsg.className = 'streak-message cold-streak';
        streakMsg.textContent = "Chilly streak! ❄️";
        gameContainer.appendChild(streakMsg);

        setTimeout(() => {
            streakMsg.remove();
        }, 3000);
    }

    updateUI() {
        // The phase drives which parts of the table are shown (betting circle vs hands,
        // and which control-dock panel); see the [data-phase] rules in styles.css.
        document.getElementById('game-container').dataset.phase = this.gamePhase;
        document.getElementById('bet-label').textContent =
            this.currentBet > 0 ? `Bet: $${this.currentBet}` : 'Place your bet';
        document.getElementById('balance').textContent = `Balance: $${this.player.balance}`;
        document.getElementById('bet').textContent = `Current Bet: $${this.currentBet}`;
        document.getElementById('cards-remaining').textContent = `Cards in shoe: ${this.deck.cardsRemaining()}`;

        let dealerCardsEl = document.getElementById('dealer-cards');
        const holeCardHidden = this.gamePhase === 'playerTurn' || this.gamePhase === 'insurance';
        dealerCardsEl.innerHTML = this.dealer.cards.map((card, index) => 
            holeCardHidden && index === 1 ? this.createCardElement({value: '?', suit: '?'}) : this.createCardElement(card)
        ).join('');
        this.fitCards(dealerCardsEl, dealerCardsEl.clientWidth);
        
        if (!holeCardHidden) {
            document.getElementById('dealer-hand').querySelector('.hand-title').textContent = `Dealer's Hand (Score: ${this.dealer.getScore()})`;
        } else {
            document.getElementById('dealer-hand').querySelector('.hand-title').textContent = "Dealer's Hand";
        }

        let playerHandsEl = document.getElementById('player-hands');
        if (this.player.hands.length > 0 && this.gamePhase !== 'betting') {
            playerHandsEl.innerHTML = this.player.hands.map((hand, index) => `
                <div class="hand ${index === this.currentHandIndex && this.gamePhase === 'playerTurn' ? 'active-hand' : ''}">
                    <div class="hand-title">Hand ${index + 1} (Score: ${hand.getScore()})</div>
                    <div class="hand-cards">${hand.cards.map(card => this.createCardElement(card)).join('')}</div>
                    <div class="hand-bet">Bet: $${hand.bet}</div>
                    <div class="hand-status">${this.handStatusLabel(hand)}</div>
                </div>
            `).join('');
            // Each hand gets an equal share of the row, less its margin and padding.
            const widthPerHand = playerHandsEl.clientWidth / this.player.hands.length - 40;
            playerHandsEl.querySelectorAll('.hand-cards').forEach(row => this.fitCards(row, widthPerHand));
        } else {
            playerHandsEl.innerHTML = ''; // Clear the player hands area if no hands or in betting phase
        }

        this.updateActionButtons();
        this.updateChips();
        this.flushPopups();
    }

    // Result popups are queued when a hand is settled and shown after the next
    // render, because updateUI rebuilds the hand elements they attach to.
    flushPopups() {
        const popups = this.pendingPopups;
        this.pendingPopups = [];
        popups.forEach(({ message, handIndex }) => this.showPopupMessage(message, handIndex));
    }

    handStatusLabel(hand) {
        if (!hand.settled) {
            return '';
        }
        if (hand.result === 'loss' && hand.getScore() > 21) {
            return 'BUST';
        }
        return hand.result.toUpperCase();
    }

    // Keeps a row of cards on one line: when the cards would be wider than the space
    // available, each card after the first overlaps the previous one just enough to fit.
    fitCards(rowEl, availableWidth) {
        const cards = rowEl.querySelectorAll('.card');
        if (cards.length < 2) {
            return;
        }
        const cardMargin = 5; // .card has a 5px right margin
        const step = cards[0].offsetWidth + cardMargin;
        const needed = step * cards.length - cardMargin;
        if (!(needed > availableWidth)) {
            return;
        }
        const minVisible = 22; // always leave the corner value readable
        const overlap = Math.min(step - minVisible, (needed - availableWidth) / (cards.length - 1));
        for (let i = 1; i < cards.length; i++) {
            cards[i].style.marginLeft = `-${overlap}px`;
        }
    }

    updateActionButtons() {
        const actions = ['hit', 'stand', 'double', 'split', 'surrender'];
        actions.forEach(action => {
            const button = document.getElementById(action);
            const isEnabled = this[`can${action.charAt(0).toUpperCase() + action.slice(1)}`]();
            button.disabled = !isEnabled;
            button.classList.toggle('enabled', isEnabled);
        });
        document.getElementById('deal').disabled = this.gamePhase !== 'betting' || this.currentBet === 0;
        document.getElementById('insurance').style.display = this.canInsurance() ? 'inline-block' : 'none';
        document.getElementById('decline-insurance').style.display = this.canDeclineInsurance() ? 'inline-block' : 'none';
        document.getElementById('clear-bet').disabled = this.gamePhase !== 'betting';
        document.getElementById('rebet').disabled = !this.canRebet();
        document.getElementById('set-bet').disabled = this.gamePhase !== 'betting';
        document.getElementById('bet-amount').disabled = this.gamePhase !== 'betting';
        document.getElementById('restart').style.display = this.isBroke() ? 'inline-block' : 'none';
    }

    updateChips() {
        const chipContainer = document.getElementById('chip-container');
        chipContainer.innerHTML = '';
        this.availableChips.forEach(chipValue => {
            const chip = document.createElement('div');
            const usable = this.gamePhase === 'betting' && chipValue <= this.player.balance;
            chip.className = `chip chip-${chipValue}${usable ? '' : ' locked'}`;
            chip.innerHTML = `
                <span class="chip-value">$${chipValue}</span>
            `;
            chip.onclick = () => this.placeBet(chipValue);
            chipContainer.appendChild(chip);
        });
    
        const betChips = document.getElementById('bet-chips');
        betChips.innerHTML = this.chipsInPot.map(chip => `
            <div class="chip chip-${chip}${this.gamePhase === 'betting' ? '' : ' locked'}" onclick="game.removeBet(${chip})">
                <span class="chip-value">$${chip}</span>
            </div>
        `).join('');
    }

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

    // Insurance is a one-time decision made in its own phase, before the dealer's
    // hole card is checked. Once decided, the phase moves on and it cannot recur.
    canInsurance() {
        return this.gamePhase === 'insurance' && this.player.balance >= this.insuranceStake();
    }

    canDeclineInsurance() {
        return this.gamePhase === 'insurance';
    }

    createCardElement(card) {
        const suitSymbols = {
            '♠': '&spades;',
            '♥': '&hearts;',
            '♦': '&diams;',
            '♣': '&clubs;'
        };
        
        let color = (card.suit === '♥' || card.suit === '♦') ? 'red' : 'black';
        let symbol = suitSymbols[card.suit] || card.suit;
        
        if (card.value === '?') {
            return `<div class="card card-back"></div>`;
        }
        
        return `
            <div class="card ${color}">
                <div class="card-corner top-left">
                    <div class="card-value">${card.value}</div>
                    <div class="card-suit">${symbol}</div>
                </div>
                <div class="card-center-suit">${symbol}</div>
                <div class="card-corner bottom-right">
                    <div class="card-value">${card.value}</div>
                    <div class="card-suit">${symbol}</div>
                </div>
            </div>
        `;
    }

    animateChip(amount) {
        const chipElement = document.querySelector(`#chip-container .chip-${amount}`);
        const betDisplay = document.getElementById('bet-display');
        
        if (!chipElement || !betDisplay) {
            console.error('Required elements for chip animation not found');
            return;
        }

        const clone = chipElement.cloneNode(true);
        const rect = chipElement.getBoundingClientRect();
        const betRect = betDisplay.getBoundingClientRect();

        clone.style.position = 'fixed';
        clone.style.left = `${rect.left}px`;
        clone.style.top = `${rect.top}px`;
        clone.style.zIndex = '1000';
        document.body.appendChild(clone);

        const animationDuration = 500; // ms
        clone.animate([
            { transform: 'scale(1)', top: `${rect.top}px`, left: `${rect.left}px` },
            { transform: 'scale(0.5)', top: `${betRect.top + betRect.height / 2}px`, left: `${betRect.left + betRect.width / 2}px` }
        ], {
            duration: animationDuration,
            easing: 'ease-in-out'
        });

        setTimeout(() => {
            clone.remove();
            this.updateChips();
        }, animationDuration);
    }

    prepareNextHand() {
        this.gamePhase = 'betting';
        this.currentHandIndex = 0;
        this.currentBet = 0;
        this.chipsInPot = [];
        this.player.hands = [new Hand()];
        this.dealer = new Hand();
        document.getElementById('next-hand').style.display = 'none';
        this.updateUI();
        setMessage("Place your bet for the next hand.");
    }

    changeTheme() {
        this.currentTheme = (this.currentTheme + 1) % this.themes.length;
        document.body.className = this.themes[this.currentTheme];
    }
}

// Function to set message (place this outside the Game class)
function setMessage(msg) {
    document.getElementById('message').textContent = msg;
}

// Create the game instance
let game = new Game(STARTING_BALANCE);

// Event Listeners
document.getElementById('deal').addEventListener('click', () => game.deal());
document.getElementById('hit').addEventListener('click', () => game.hit(game.currentHandIndex));
document.getElementById('stand').addEventListener('click', () => game.stand(game.currentHandIndex));
document.getElementById('double').addEventListener('click', () => game.doubleDown(game.currentHandIndex));
document.getElementById('split').addEventListener('click', () => game.split(game.currentHandIndex));
document.getElementById('surrender').addEventListener('click', () => game.surrender());
document.getElementById('insurance').addEventListener('click', () => game.buyInsurance());
document.getElementById('decline-insurance').addEventListener('click', () => game.declineInsurance());
document.getElementById('next-hand').addEventListener('click', () => game.prepareNextHand());
document.getElementById('clear-bet').addEventListener('click', () => game.clearBet());
document.getElementById('rebet').addEventListener('click', () => game.rebet());
document.getElementById('restart').addEventListener('click', () => game.restart());

const betAmountInput = document.getElementById('bet-amount');
function applyBetAmount() {
    if (game.setBet(Number(betAmountInput.value))) {
        betAmountInput.value = '';
    }
}
document.getElementById('set-bet').addEventListener('click', applyBetAmount);
betAmountInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        applyBetAmount();
    }
});
document.getElementById('change-theme').addEventListener('click', () => game.changeTheme());

// Keyboard shortcuts
document.addEventListener('keydown', (event) => {
    if (event.target && event.target.tagName === 'INPUT') {
        return; // typing a bet amount must not trigger game shortcuts
    }
    if (game.gamePhase === 'playerTurn') {
        switch(event.key.toLowerCase()) {
            case 'h': if (game.canHit()) game.hit(game.currentHandIndex); break;
            case 's': if (game.canStand()) game.stand(game.currentHandIndex); break;
            case 'd': if (game.canDouble()) game.doubleDown(game.currentHandIndex); break;
            case 'p': if (game.canSplit()) game.split(game.currentHandIndex); break;
            case 'r': if (game.canSurrender()) game.surrender(); break;
        }
    } else if (game.gamePhase === 'betting' && event.key === 'Enter') {
        game.deal();
    }
});

// Initial UI update
game.updateUI();
game.updateShoeDisplay();

// Add tooltips to explain keyboard shortcuts
const tooltips = [
    { id: 'hit', text: 'Hit (Keyboard: H)' },
    { id: 'stand', text: 'Stand (Keyboard: S)' },
    { id: 'double', text: 'Double Down (Keyboard: D)' },
    { id: 'split', text: 'Split (Keyboard: P)' },
    { id: 'surrender', text: 'Surrender (Keyboard: R)' },
    { id: 'deal', text: 'Deal (Keyboard: Enter)' }
];

tooltips.forEach(tooltip => {
    const element = document.getElementById(tooltip.id);
    if (element) {
        element.title = tooltip.text;
    }
});
