// Initialize sound effects
const cardSound = new Audio('sounds/card.wav');
const chipSound = new Audio('sounds/chip.wav');
const winSound = new Audio('sounds/win.mp3');
const loseSound = new Audio('sounds/lose.mp3');
const drawSound = new Audio('sounds/draw.wav');
const clickSound = new Audio('sounds/click.wav');

const blackjackSound = new Audio('sounds/blackjack.mp3');

// localStorage can be unavailable (private windows, blocked site data), so every
// access goes through these and the game keeps working without persistence.
function readStorage(key) {
    try {
        return localStorage.getItem(key);
    } catch (error) {
        return null;
    }
}

function writeStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (error) {
        // Not persisting is fine.
    }
}

let soundMuted = readStorage('blackjackMuted') === '1';

function updateMuteButton() {
    document.getElementById('mute').textContent = soundMuted ? 'Sound: Off' : 'Sound: On';
}

function toggleMute() {
    soundMuted = !soundMuted;
    writeStorage('blackjackMuted', soundMuted ? '1' : '0');
    updateMuteButton();
}

// Function to play sound
function playSound(sound) {
    if (soundMuted) {
        return;
    }
    sound.currentTime = 0;
    const playing = sound.play();
    if (playing && playing.catch) {
        playing.catch(() => {}); // browsers block audio until the first click; ignore that
    }
}

// Save and load statistics
function saveStats() {
    writeStorage('blackjackStats', JSON.stringify(gameStats));
}

function loadStats() {
    const fresh = { gamesPlayed: 0, gamesWon: 0, totalMoney: 0 };
    try {
        const saved = JSON.parse(readStorage('blackjackStats'));
        const valid = saved && ['gamesPlayed', 'gamesWon', 'totalMoney'].every(key => Number.isFinite(saved[key]));
        return valid ? { gamesPlayed: saved.gamesPlayed, gamesWon: saved.gamesWon, totalMoney: saved.totalMoney } : fresh;
    } catch (error) {
        return fresh; // missing or corrupt data
    }
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

const RANK_NAMES = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' };
const SUIT_NAMES = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };

// Screen-reader description, e.g. "Queen of hearts".
function describeCard(card) {
    return `${RANK_NAMES[card.value] || card.value} of ${SUIT_NAMES[card.suit] || card.suit}`;
}

function setText(element, text) {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

// Reconciles a container's children with a list of items, so the page only touches what
// changed. A child whose key is unchanged is kept as it is (its animation, hover state
// and keyboard focus survive), a changed one is replaced, and any extras are removed.
// createElementFor(item, index, isNew) builds a child (isNew is true when the item is
// past the end of what was there before, i.e. a genuinely new item); updateElement, if
// given, then brings every child, new or kept, up to date.
function syncChildren(container, items, keyOf, createElementFor, updateElement) {
    items.forEach((item, index) => {
        const key = keyOf(item, index);
        const existing = container.children[index];
        let element = existing;
        if (!existing || existing.dataset.key !== key) {
            element = createElementFor(item, index, !existing);
            element.dataset.key = key;
            if (existing) {
                container.replaceChild(element, existing);
            } else {
                container.appendChild(element);
            }
        }
        if (updateElement) {
            updateElement(element, item, index);
        }
    });
    while (container.children.length > items.length) {
        container.removeChild(container.lastChild);
    }
}

const BET_FAILURES = {
    locked: 'Bets are locked once dealing begins.',
    insufficient: 'Insufficient funds for this bet.',
    invalid: 'Enter a whole-dollar bet of at least $1.',
    nothing: 'Nothing to rebet.'
};

// The page: renders the engine's state and reacts to its events with sounds,
// animations, messages and statistics. All of the rules live in engine.js.
class Table {
    constructor(engine) {
        this.engine = engine;
        this.themes = ['theme1', 'theme2', 'theme3'];
        this.currentTheme = 0;
        this.roundMessages = [];   // result messages collected over the current round
        this.cutCardPending = false;
        this.revealed = { player: 0, dealer: 0 }; // opening cards shown so far while dealing
        this.lastOpening = null;   // result of the dealer's most recent blackjack check
        engine.subscribe(event => this.handleEvent(event));
        this.updateChips();
    }

    // ---- Reacting to the engine ----

    handleEvent(event) {
        switch (event.type) {
            case 'betChanged':
            case 'chips':
                playSound(chipSound);
                break;
            case 'cardDealt':
                // The opening deal plays each card's sound as the card animates in.
                if (this.engine.gamePhase !== 'dealing') {
                    playSound(cardSound);
                }
                break;
            case 'cutCard':
                if (this.engine.gamePhase === 'dealing') {
                    this.cutCardPending = true; // shown once the opening cards are revealed
                } else {
                    this.showCutCard();
                }
                break;
            case 'openingChecked':
                this.lastOpening = event;
                if (event.playerBlackjack && event.dealerBlackjack) {
                    this.showBlackjackPopup("Double Blackjack!");
                } else if (event.playerBlackjack) {
                    this.showBlackjackPopup("Blackjack!");
                } else if (event.dealerBlackjack) {
                    this.showBlackjackPopup("Dealer Blackjack!");
                }
                break;
            case 'insuranceBought':
                this.roundMessages.push(`Insurance bought for $${event.stake}.`);
                break;
            case 'insuranceSettled':
                recordStats({ net: event.net });
                this.roundMessages.push(event.won
                    ? `Dealer has Blackjack. Insurance pays 2:1 (+$${event.net}).`
                    : `Dealer does not have Blackjack. Insurance lost (-$${event.stake}).`);
                break;
            case 'settled':
                this.showSettlement(event);
                break;
            case 'streak':
                if (event.kind === 'hot') {
                    this.showHotStreakAnimation();
                } else {
                    this.showColdStreakAnimation();
                }
                break;
            case 'dealerTurn':
                this.runDealerTurn();
                break;
            case 'reshuffled':
                this.roundMessages.push("Reshuffling the deck for the next hand.");
                this.animateReshuffle();
                break;
            case 'roundOver':
                if (event.broke) {
                    this.roundMessages.push("You're out of money!");
                }
                setMessage(this.roundMessages.join(' '));
                this.updateUI();
                break;
        }
    }

    showSettlement({ handIndex, outcome, reason, wager, payout, net }) {
        let text = '';
        let popup = '';
        switch (outcome) {
            case 'win':
                text = `You win $${net}!`;
                popup = `WIN<br>$${net}`;
                playSound(winSound);
                break;
            case 'loss':
                text = `You lose $${wager}.`;
                popup = `LOSE<br>$${wager}`;
                playSound(loseSound);
                break;
            case 'push':
                text = "It's a push. Your bet is returned.";
                popup = 'PUSH';
                playSound(drawSound);
                break;
            case 'blackjack':
                text = `Blackjack! You win $${net}!`;
                popup = `BLACKJACK<br>$${net}`;
                break;
            case 'surrender':
                text = `You surrendered. $${payout} of your $${wager} bet is returned.`;
                popup = `SURRENDER<br>$${payout} returned`;
                playSound(drawSound);
                break;
        }

        let message = `Hand ${handIndex + 1}: ${text}`;
        if (reason === 'both-blackjack') {
            message = "Both have Blackjack! It's a push.";
        } else if (reason === 'dealer-blackjack') {
            const up = this.engine.dealer.cards[0].value;
            const upName = up === 'A' ? 'an Ace' : `a ${RANK_NAMES[up] || up}`;
            message = `Dealer showed ${upName} and peeked at the hole card: Blackjack! You lose.`;
        }

        recordStats({ net, hands: 1, won: (outcome === 'win' || outcome === 'blackjack') ? 1 : 0 });
        this.roundMessages.push(message);
        setMessage(this.roundMessages.join(' '));
        this.showPopupMessage(popup, handIndex);
    }

    // Tells the player what is expected of them once the opening blackjack check is done.
    announceTurn() {
        if (this.engine.gamePhase === 'insurance') {
            setMessage("Dealer's up card is an Ace. Would you like to buy insurance?");
        } else if (this.engine.gamePhase === 'playerTurn') {
            const parts = [...this.roundMessages];
            if (parts.length === 0 && this.lastOpening && this.lastOpening.peeked) {
                parts.push('Dealer peeked: no Blackjack.');
            }
            parts.push('Your move.');
            setMessage(parts.join(' '));
        }
    }

    refresh() {
        this.updateUI();
        this.updateShoeDisplay();
    }

    // ---- Betting ----

    placeBet(amount) {
        const result = this.engine.placeBet(amount);
        if (!result.ok) {
            setMessage(result.reason === 'locked' ? "You can only place bets before dealing." : BET_FAILURES[result.reason]);
            return false;
        }
        this.updateUI();
        setMessage(`Added $${amount} to the bet. Total bet: $${this.engine.currentBet}`);
        this.animateChip(amount);
        return true;
    }

    removeBet(amount) {
        const result = this.engine.removeBet(amount);
        if (!result.ok) {
            if (result.reason === 'locked') {
                setMessage(BET_FAILURES.locked);
            }
            return false;
        }
        this.updateUI();
        setMessage(`Removed $${amount} from the bet. Total bet: $${this.engine.currentBet}`);
        return true;
    }

    clearBet() {
        const result = this.engine.clearBet();
        if (!result.ok) {
            setMessage(BET_FAILURES[result.reason]);
            return false;
        }
        this.updateUI();
        setMessage("Bet cleared.");
        return true;
    }

    setBet(amount) {
        const result = this.engine.setBet(amount);
        if (!result.ok) {
            setMessage(BET_FAILURES[result.reason]);
            return false;
        }
        this.updateUI();
        setMessage(`Bet set to $${this.engine.currentBet}.`);
        return true;
    }

    rebet() {
        const result = this.engine.rebet();
        if (!result.ok) {
            setMessage(BET_FAILURES[result.reason]);
            return false;
        }
        this.updateUI();
        setMessage(`Bet set to $${this.engine.currentBet}.`);
        return true;
    }

    // ---- The round ----

    deal() {
        const started = this.engine.beginDeal();
        if (!started.ok) {
            if (started.reason === 'nobet') {
                setMessage("Please place a bet first.");
            }
            return;
        }
        this.roundMessages = [];
        this.lastOpening = null;
        this.revealed = { player: 0, dealer: 0 };
        this.updateUI();

        // The engine deals all four cards at once; the page reveals them half a second apart.
        const sequence = this.engine.dealInitialCards();
        sequence.forEach((deal, index) => {
            setTimeout(() => {
                playSound(cardSound);
                this.revealed[deal.target] += 1;
                this.updateUI();

                if (index === sequence.length - 1) {
                    setTimeout(() => {
                        this.updateShoeDisplay();
                        this.engine.beginPlay();
                        this.updateUI();
                        this.announceTurn();
                        if (this.cutCardPending) {
                            this.cutCardPending = false;
                            this.showCutCard();
                        }
                    }, 500);
                }
            }, index * 500);
        });

        // Update the UI to show remaining cards in the shoe
        document.getElementById('cards-remaining').textContent = `Cards in shoe: ${this.engine.deck.cardsRemaining()}`;
    }

    hit(handIndex) {
        this.engine.hit(handIndex);
        this.refresh();
    }

    stand(handIndex) {
        this.engine.stand(handIndex);
        this.refresh();
    }

    doubleDown(handIndex) {
        if (!this.engine.doubleDown(handIndex)) {
            setMessage("Cannot double down. Insufficient funds or more than two cards in hand.");
        }
        this.refresh();
    }

    split(handIndex) {
        if (!this.engine.split(handIndex)) {
            setMessage("Cannot split. Cards must match, you need funds for the extra bet, and four hands is the limit.");
        }
        this.refresh();
    }

    surrender() {
        if (!this.engine.surrender()) {
            setMessage("You can only surrender on your first action.");
        }
        this.refresh();
    }

    buyInsurance() {
        if (this.engine.buyInsurance()) {
            this.announceTurn();
            this.refresh();
        }
    }

    declineInsurance() {
        if (this.engine.declineInsurance()) {
            this.announceTurn();
            this.refresh();
        }
    }

    runDealerTurn() {
        this.updateUI();
        this.updateShoeDisplay();

        const step = () => {
            if (this.engine.dealerShouldDraw()) {
                setTimeout(() => {
                    this.engine.dealerDraw();
                    this.updateUI(); // the new card animates in
                    step();
                }, 1000);
            } else {
                this.engine.finishDealerTurn();
            }
        };
        setTimeout(step, 1000);
    }

    hint() {
        const hint = this.engine.getHint();
        if (!hint) {
            return;
        }
        if (hint === 'decline-insurance') {
            setMessage("Hint: basic strategy says to decline insurance. It loses money in the long run.");
            return;
        }
        const labels = { hit: 'Hit', stand: 'Stand', double: 'Double down', split: 'Split', surrender: 'Surrender' };
        setMessage(`Hint: basic strategy says ${labels[hint]}.`);
    }

    prepareNextHand() {
        if (this.engine.prepareNextHand()) {
            this.updateUI();
            setMessage("Place your bet for the next hand.");
        }
    }

    restart() {
        if (this.engine.restart()) {
            this.updateUI();
            setMessage(`New game. You start again with $${STARTING_BALANCE}.`);
        }
    }

    // ---- Rendering and animation ----

    showCutCard() {
        const cutCard = document.createElement('div');
        cutCard.className = 'cut-card';
        cutCard.textContent = 'RESHUFFLE';
        document.getElementById('dealer-hand').appendChild(cutCard);

        setTimeout(() => {
            cutCard.style.transform = 'translateX(-50%) translateY(-100%)';
        }, 100);

        setTimeout(() => {
            cutCard.remove();
        }, 3000);
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

    showBlackjackPopup(message) {
        const popup = document.createElement('div');
        popup.className = 'blackjack-popup';
        popup.textContent = message;
        document.body.appendChild(popup);

        playSound(blackjackSound);

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

    updateShoeDisplay() {
        const totalCards = this.engine.deck.numDecks * 52;
        const remainingCards = this.engine.deck.cardsRemaining();
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
        const engine = this.engine;
        // The phase drives which parts of the table are shown (betting circle vs hands,
        // and which control-dock panel); see the [data-phase] rules in styles.css.
        document.getElementById('game-container').dataset.phase = engine.gamePhase;
        document.getElementById('bet-label').textContent =
            engine.currentBet > 0 ? `Bet: $${engine.currentBet}` : 'Place your bet';
        document.getElementById('balance').textContent = `Balance: $${engine.player.balance}`;
        document.getElementById('bet').textContent = `Current Bet: $${engine.currentBet}`;
        document.getElementById('cards-remaining').textContent = `Cards in shoe: ${engine.deck.cardsRemaining()}`;

        this.renderDealer();
        this.renderHands();
        this.updateActionButtons();
        this.updateChips();
    }

    // While dealing, the engine already holds all four opening cards, but the page
    // reveals them one at a time, so only the first few are shown.
    visibleCards(hand, who) {
        return this.engine.gamePhase === 'dealing' ? hand.cards.slice(0, this.revealed[who]) : hand.cards;
    }

    scoreOf(cards) {
        const shown = new Hand();
        shown.cards = cards;
        return shown.getScore();
    }

    renderDealer() {
        const engine = this.engine;
        const phase = engine.gamePhase;
        const holeCardHidden = phase === 'dealing' || phase === 'insurance' || phase === 'playerTurn';
        const cards = this.visibleCards(engine.dealer, 'dealer');
        const row = document.getElementById('dealer-cards');
        this.renderCardRow(row, cards, holeCardHidden ? 1 : -1, row.clientWidth);

        const title = document.getElementById('dealer-hand').querySelector('.hand-title');
        setText(title, (holeCardHidden || cards.length === 0)
            ? "Dealer's Hand"
            : `Dealer's Hand (Score: ${this.scoreOf(cards)})`);
    }

    renderHands() {
        const engine = this.engine;
        const container = document.getElementById('player-hands');
        const hands = engine.gamePhase === 'betting' ? [] : engine.player.hands;
        // Each hand gets an equal share of the row, less its margin and padding.
        const widthPerHand = container.clientWidth / Math.max(hands.length, 1) - 40;
        syncChildren(container, hands,
            (hand, index) => `hand-${index}`,
            () => this.buildHandElement(),
            (element, hand, index) => this.updateHandElement(element, hand, index, widthPerHand));
    }

    buildHandElement() {
        const element = document.createElement('div');
        element.className = 'hand';
        const parts = {};
        for (const name of ['title', 'cards', 'bet', 'status']) {
            parts[name] = document.createElement('div');
            parts[name].className = name === 'cards' ? 'hand-cards' : `hand-${name}`;
            element.appendChild(parts[name]);
        }
        element.parts = parts;
        return element;
    }

    updateHandElement(element, hand, index, widthPerHand) {
        const engine = this.engine;
        const cards = this.visibleCards(hand, 'player');
        setText(element.parts.title, `Hand ${index + 1} (Score: ${this.scoreOf(cards)})`);
        element.classList.toggle('active-hand', index === engine.currentHandIndex && engine.gamePhase === 'playerTurn');
        this.renderCardRow(element.parts.cards, cards, -1, widthPerHand);
        setText(element.parts.bet, `Bet: $${hand.bet}`);
        setText(element.parts.status, this.handStatusLabel(hand));
    }

    // Shows a row of cards, keeping the elements of cards that haven't changed. A card
    // that is genuinely new animates in; one that merely turns face up does not.
    renderCardRow(rowEl, cards, hiddenIndex, availableWidth) {
        syncChildren(rowEl, cards,
            (card, index) => `${index}:${card.value}${card.suit}:${index === hiddenIndex ? 'back' : 'face'}`,
            (card, index, isNew) => this.buildCardElement(card, { hidden: index === hiddenIndex, animate: isNew }));
        this.fitCards(rowEl, availableWidth);
    }

    buildCardElement(card, { hidden = false, animate = false } = {}) {
        const element = document.createElement('div');
        if (hidden) {
            element.className = 'card card-back';
        } else {
            element.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : 'black'}`;
            element.setAttribute('role', 'img');
            element.setAttribute('aria-label', describeCard(card));
            element.innerHTML = this.createCardInnerHTML(card);
        }
        if (animate) {
            element.classList.add('deal-in');
        }
        return element;
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

    fitCards(rowEl, availableWidth) {
        const cards = Array.from(rowEl.children);
        cards.forEach(card => {
            card.style.marginLeft = ''; // undo any overlap from an earlier render
        });
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
            const isEnabled = this.engine[`can${action.charAt(0).toUpperCase() + action.slice(1)}`]();
            button.disabled = !isEnabled;
            button.classList.toggle('enabled', isEnabled);
        });
        document.getElementById('deal').disabled = this.engine.gamePhase !== 'betting' || this.engine.currentBet === 0;
        document.getElementById('insurance').style.display = this.engine.canInsurance() ? 'inline-block' : 'none';
        document.getElementById('decline-insurance').style.display = this.engine.canDeclineInsurance() ? 'inline-block' : 'none';
        document.getElementById('hint').disabled = !this.engine.canHint();
        document.getElementById('clear-bet').disabled = this.engine.gamePhase !== 'betting';
        document.getElementById('next-hand').style.display = this.engine.isBroke() ? 'none' : 'inline-block';
        document.getElementById('rebet').disabled = !this.engine.canRebet();
        document.getElementById('set-bet').disabled = this.engine.gamePhase !== 'betting';
        document.getElementById('bet-amount').disabled = this.engine.gamePhase !== 'betting';
        document.getElementById('restart').style.display = this.engine.isBroke() ? 'inline-block' : 'none';
    }

    updateChips() {
        const engine = this.engine;
        const betting = engine.gamePhase === 'betting';
        // The chip rack: only chips whose state changed are rebuilt, so keyboard focus isn't lost.
        syncChildren(document.getElementById('chip-container'), engine.chips,
            chip => `${chip}:${betting && chip <= engine.player.balance ? 1 : 0}`,
            chip => this.buildChipElement(chip, betting && chip <= engine.player.balance, false));
        // The chips in the betting circle.
        syncChildren(document.getElementById('bet-chips'), engine.chipsInPot,
            (chip, index) => `${index}:${chip}:${betting ? 1 : 0}`,
            chip => this.buildChipElement(chip, betting, true));
    }

    buildChipElement(value, usable, inPot) {
        const chip = document.createElement('div');
        chip.className = `chip chip-${value}${usable ? '' : ' locked'}`;
        chip.setAttribute('role', 'button');
        chip.setAttribute('aria-label', inPot ? `Remove a $${value} chip from your bet` : `Add a $${value} chip to your bet`);
        chip.tabIndex = usable ? 0 : -1;
        const label = document.createElement('span');
        label.className = 'chip-value';
        label.textContent = `$${value}`;
        chip.appendChild(label);
        const act = () => (inPot ? this.removeBet(value) : this.placeBet(value));
        chip.onclick = act;
        chip.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                act();
            }
        };
        return chip;
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
        }, animationDuration);
    }

    changeTheme() {
        this.currentTheme = (this.currentTheme + 1) % this.themes.length;
        document.body.className = this.themes[this.currentTheme];
    }
}

// Function to set message (place this outside the Table class)
function setMessage(msg) {
    document.getElementById('message').textContent = msg;
}

// Create the game instance. The page animates the dealer, so the engine must not auto-play it.
let game = new Table(new BlackjackEngine({ autoDealer: false }));

// Event Listeners
document.getElementById('deal').addEventListener('click', () => game.deal());
document.getElementById('hit').addEventListener('click', () => game.hit(game.engine.currentHandIndex));
document.getElementById('stand').addEventListener('click', () => game.stand(game.engine.currentHandIndex));
document.getElementById('double').addEventListener('click', () => game.doubleDown(game.engine.currentHandIndex));
document.getElementById('split').addEventListener('click', () => game.split(game.engine.currentHandIndex));
document.getElementById('surrender').addEventListener('click', () => game.surrender());
document.getElementById('insurance').addEventListener('click', () => game.buyInsurance());
document.getElementById('decline-insurance').addEventListener('click', () => game.declineInsurance());
document.getElementById('hint').addEventListener('click', () => game.hint());
document.getElementById('mute').addEventListener('click', toggleMute);
updateMuteButton();
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
    const engine = game.engine;
    if (engine.gamePhase === 'playerTurn') {
        switch(event.key.toLowerCase()) {
            case 'h': if (engine.canHit()) game.hit(engine.currentHandIndex); break;
            case 's': if (engine.canStand()) game.stand(engine.currentHandIndex); break;
            case 'd': if (engine.canDouble()) game.doubleDown(engine.currentHandIndex); break;
            case 'p': if (engine.canSplit()) game.split(engine.currentHandIndex); break;
            case 'r': if (engine.canSurrender()) game.surrender(); break;
        }
    } else if (engine.gamePhase === 'betting' && event.key === 'Enter') {
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
