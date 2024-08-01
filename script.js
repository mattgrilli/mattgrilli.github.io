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

// Update stats display
function updateStatsDisplay() {
    document.getElementById('stats').textContent = `Games Played: ${gameStats.gamesPlayed} | Games Won: ${gameStats.gamesWon} | Total Won/Lost: $${gameStats.totalMoney}`;
}

// Initial game statistics
let gameStats = loadStats();
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
        // Place cut card randomly in last quarter of the shoe
        const minPosition = Math.floor(this.cards.length * 0.75);
        const maxPosition = this.cards.length - 20; // Ensure at least 20 cards after cut card
        this.cutCard = Math.floor(Math.random() * (maxPosition - minPosition + 1)) + minPosition;
    }

    shuffle() {
        for (let i = this.cards.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.cards[i], this.cards[j]] = [this.cards[j], this.cards[i]];
        }
    }

    deal() {
        if (this.cards.length <= this.cutCard && !this.reshuffleNeeded) {
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
        this.surrendered = false;
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

    win(handIndex) {
        this.balance += this.hands[handIndex].bet * 2;
        this.hands[handIndex].bet = 0;
    }

    lose(handIndex) {
        this.hands[handIndex].bet = 0;
    }

    push(handIndex) {
        this.balance += this.hands[handIndex].bet;
        this.hands[handIndex].bet = 0;
    }

    blackjack(handIndex) {
        this.balance += this.hands[handIndex].bet * 2.5;
        this.hands[handIndex].bet = 0;
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

    surrender(handIndex) {
        this.balance += this.hands[handIndex].bet / 2;
        this.hands[handIndex].bet = 0;
        this.hands[handIndex].surrendered = true;
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
        const index = this.chipsInPot.indexOf(amount);
        if (index > -1) {
            this.chipsInPot.splice(index, 1);
            this.currentBet -= amount;
            this.player.balance += amount;
            this.updateUI();
            setMessage(`Removed $${amount} from the bet. Total bet: $${this.currentBet}`);
            playSound(chipSound);
        }
    }

    clearBet() {
        this.player.balance += this.currentBet;
        this.currentBet = 0;
        this.chipsInPot = [];
        this.updateUI();
        setMessage("Bet cleared.");
        playSound(chipSound);
    }

    deal() {
        if (this.currentBet === 0) {
            setMessage("Please place a bet first.");
            return;
        }

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
                        this.gamePhase = 'playerTurn';
                        this.currentHandIndex = 0;
                        this.checkForBlackjack();
                        this.updateUI();
                        this.updateShoeDisplay();
                        this.offerInsurance();
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

    hit(handIndex) {
        const { card, isLastHand } = this.deck.deal();
        this.player.hands[handIndex].addCard(card);
        if (isLastHand && !this.lastHandBeforeReshuffle) {
            this.lastHandBeforeReshuffle = true;
            this.showCutCard();
        }
        if (this.player.hands[handIndex].getScore() > 21) {
            this.endHand('loss', handIndex);
        } else if (this.player.hands[handIndex].doubledDown) {
            this.stand(handIndex);
        }
        this.updateUI();
        this.updateShoeDisplay();
    }

    stand(handIndex) {
        this.nextHand();
    }

    doubleDown(handIndex) {
        const hand = this.player.hands[handIndex];
        if (this.player.balance >= hand.bet && hand.cards.length === 2) {
            this.player.doubleDown(handIndex);
            this.hit(handIndex);
        } else {
            setMessage("Cannot double down. Insufficient funds or more than two cards in hand.");
        }
        this.updateUI();
    }

    split(handIndex) {
        const hand = this.player.hands[handIndex];
        if (this.player.balance >= hand.bet && hand.canSplit()) {
            this.player.split(handIndex);
            const { card: card1, isLastHand: isLastHand1 } = this.deck.deal();
            const { card: card2, isLastHand: isLastHand2 } = this.deck.deal();
            this.player.hands[handIndex].addCard(card1);
            this.player.hands[handIndex + 1].addCard(card2);
            if ((isLastHand1 || isLastHand2) && !this.lastHandBeforeReshuffle) {
                this.lastHandBeforeReshuffle = true;
                this.showCutCard();
            }
            this.updateUI();
        } else {
            setMessage("Cannot split. Insufficient funds or cards don't match.");
        }
    }

    surrender() {
        if (this.gamePhase === 'playerTurn' && this.player.hands[this.currentHandIndex].cards.length === 2) {
            this.player.surrender(this.currentHandIndex);
            this.endHand('surrender', this.currentHandIndex);
        } else {
            setMessage("You can only surrender on your first action.");
        }
    }

    offerInsurance() {
        if (this.allowInsurance && 
            this.gamePhase === 'playerTurn' && 
            this.dealer.cards[0].value === 'A' && 
            this.player.hands[0].cards.length === 2 && // Only offer on initial deal
            this.player.balance >= this.player.hands[0].bet / 2) {
            setMessage("Dealer's up card is an Ace. Would you like to buy insurance?");
            document.getElementById('insurance').style.display = 'inline-block';
        } else {
            document.getElementById('insurance').style.display = 'none';
        }
    }

    buyInsurance() {
        const insuranceAmount = this.player.hands[0].bet / 2;
        try {
            this.player.placeInsurance(insuranceAmount);
            setMessage("Insurance bought.");
            document.getElementById('insurance').style.display = 'none';
            if (this.dealer.getScore() === 21) {
                this.player.winInsurance();
                setMessage("Dealer has Blackjack. Insurance pays 2:1.");
                this.endHand('loss', 0);
            } else {
                this.player.loseInsurance();
                setMessage("Dealer does not have Blackjack. Insurance lost.");
            }
        } catch (error) {
            setMessage(error.message);
        }
        this.updateUI();
    }

    nextHand() {
        this.currentHandIndex++;
        if (this.currentHandIndex >= this.player.hands.length) {
            this.dealerPlay();
        } else {
            this.updateUI();
        }
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
                    if (isLastHand && !this.lastHandBeforeReshuffle) {
                        this.lastHandBeforeReshuffle = true;
                        this.showCutCard();
                    }
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
            if (hand.surrendered) {
                return;
            }
            const playerScore = hand.getScore();
            if (playerScore > 21) {
                this.endHand('loss', index);
            } else if (dealerScore > 21) {
                this.endHand('win', index);
            } else if (playerScore > dealerScore) {
                this.endHand('win', index);
            } else if (playerScore < dealerScore) {
                this.endHand('loss', index);
            } else {
                this.endHand('push', index);
            }
        });
    }

    checkForBlackjack() {
        const playerScore = this.player.hands[0].getScore();
        const dealerScore = this.dealer.getScore();
    
        const showBlackjackPopup = (message) => {
            const popup = document.createElement('div');
            popup.className = 'blackjack-popup';
            popup.textContent = message;
            document.body.appendChild(popup);
    
            // Play a special sound for Blackjack
            const blackjackSound = new Audio('sounds/blackjack.mp3'); // Make sure you have this sound file
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
        };
    
        if (playerScore === 21 && dealerScore === 21) {
            showBlackjackPopup("Double Blackjack!");
            this.endHand('push', 0, "Both have Blackjack! It's a push.");
        } else if (playerScore === 21) {
            showBlackjackPopup("Blackjack!");
            this.endHand('blackjack', 0);
        } else if (dealerScore === 21) {
            showBlackjackPopup("Dealer Blackjack!");
            this.endHand('loss', 0, "Dealer has Blackjack! You lose.");
        }
    }

    endHand(result, handIndex = 0, customMessage = null) {
        const hand = this.player.hands[handIndex];
        let amount = hand.bet;
        let message = customMessage || `Hand ${handIndex + 1}: `;
        let popupMessage = '';

        switch (result) {
            case 'win':
                this.player.balance += amount * 2;
                gameStats.totalMoney += amount;
                gameStats.gamesWon++;
                message += `You win $${amount}!`;
                popupMessage = `WIN<br>$${amount}`;
                playSound(winSound);
                this.streakCounter = Math.max(0, this.streakCounter + 1);
                break;
            case 'loss':
                gameStats.totalMoney -= amount;
                message += `You lose $${amount}.`;
                popupMessage = `LOSE<br>$${amount}`;
                playSound(loseSound);
                this.streakCounter = Math.min(0, this.streakCounter - 1);
                break;
            case 'push':
                this.player.balance += amount;
                message += "It's a push. Your bet is returned.";
                popupMessage = 'PUSH';
                playSound(drawSound);
                break;
                case 'blackjack':
                    const blackjackAmount = amount * 2.5;
                    this.player.balance += blackjackAmount;
                    gameStats.totalMoney += (blackjackAmount - amount);
                    gameStats.gamesWon++;
                    message += `Blackjack! You win $${blackjackAmount - amount}!`;
                    popupMessage = `BLACKJACK<br>$${blackjackAmount}`;
                    playSound(winSound);
                    this.streakCounter = Math.max(0, this.streakCounter + 1);
                    break;
            case 'surrender':
                this.player.balance += amount / 2;
                gameStats.totalMoney -= amount / 2;
                message += `You surrendered. Half of your bet ($${amount / 2}) is returned.`;
                popupMessage = `SURRENDER<br>$${amount / 2} returned`;
                playSound(drawSound);
                this.streakCounter = 0;
                break;
        }

        gameStats.gamesPlayed++;
        saveStats();
        updateStatsDisplay();
        this.showPopupMessage(popupMessage, handIndex);
        setMessage(message);
        this.gamePhase = 'gameOver';
        this.updateUI();
        document.getElementById('next-hand').style.display = 'inline-block';
        this.checkHotStreak();

        if (this.lastHandBeforeReshuffle) {
            this.reshuffleShoe();
        }
    }

    reshuffleShoe() {
        setMessage("Reshuffling the deck for the next hand.");
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
        document.getElementById('balance').textContent = `Balance: $${this.player.balance}`;
        document.getElementById('bet').textContent = `Current Bet: $${this.currentBet}`;
        document.getElementById('cards-remaining').textContent = `Cards in shoe: ${this.deck.cardsRemaining()}`;

        let dealerCardsEl = document.getElementById('dealer-cards');
        dealerCardsEl.innerHTML = this.dealer.cards.map((card, index) => 
            this.gamePhase === 'playerTurn' && index === 1 ? this.createCardElement({value: '?', suit: '?'}) : this.createCardElement(card)
        ).join('');
        
        if (this.gamePhase !== 'playerTurn') {
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
                </div>
            `).join('');
        } else {
            playerHandsEl.innerHTML = ''; // Clear the player hands area if no hands or in betting phase
        }

        this.updateActionButtons();
        this.updateChips();
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
    }

    updateChips() {
        const chipContainer = document.getElementById('chip-container');
        chipContainer.innerHTML = '';
        this.availableChips.forEach(chipValue => {
            const chip = document.createElement('div');
            chip.className = `chip chip-${chipValue}`;
            chip.innerHTML = `
                <span class="chip-value">$${chipValue}</span>
            `;
            chip.onclick = () => this.placeBet(chipValue);
            chipContainer.appendChild(chip);
        });
    
        const betChips = document.getElementById('bet-chips');
        betChips.innerHTML = this.chipsInPot.map(chip => `
            <div class="chip chip-${chip}" onclick="game.removeBet(${chip})">
                <span class="chip-value">$${chip}</span>
            </div>
        `).join('');
    }

    canHit() {
        return this.gamePhase === 'playerTurn' && !this.player.hands[this.currentHandIndex].doubledDown;
    }

    canStand() {
        return this.gamePhase === 'playerTurn';
    }

    canDouble() {
        const currentHand = this.player.hands[this.currentHandIndex];
        return this.gamePhase === 'playerTurn' && 
               (currentHand.cards.length === 2 || this.allowDoubleAfterSplit) && 
               this.player.balance >= currentHand.bet;
    }

    canSplit() {
        const currentHand = this.player.hands[this.currentHandIndex];
        return this.gamePhase === 'playerTurn' && 
               currentHand.cards.length === 2 && 
               (currentHand.cards[0].value === currentHand.cards[1].value ||
               (isNaN(currentHand.cards[0].value) && isNaN(currentHand.cards[1].value))) && // Allow splitting face cards
               this.player.balance >= currentHand.bet &&
               this.player.hands.length < 4; // Limit to 4 hands (3 splits)
    }

    canSurrender() {
        return this.allowSurrender && this.gamePhase === 'playerTurn' && this.player.hands[this.currentHandIndex].cards.length === 2;
    }

    canInsurance() {
        return this.allowInsurance && this.gamePhase === 'playerTurn' && this.dealer.cards[0].value === 'A' && this.player.balance >= this.player.hands[0].bet / 2;
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
        const chipElement = document.querySelector(`.chip-${amount}`);
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
let game = new Game(1000);

// Event Listeners
document.getElementById('deal').addEventListener('click', () => game.deal());
document.getElementById('hit').addEventListener('click', () => game.hit(game.currentHandIndex));
document.getElementById('stand').addEventListener('click', () => game.stand(game.currentHandIndex));
document.getElementById('double').addEventListener('click', () => game.doubleDown(game.currentHandIndex));
document.getElementById('split').addEventListener('click', () => game.split(game.currentHandIndex));
document.getElementById('surrender').addEventListener('click', () => game.surrender());
document.getElementById('insurance').addEventListener('click', () => game.buyInsurance());
document.getElementById('next-hand').addEventListener('click', () => game.prepareNextHand());
document.getElementById('clear-bet').addEventListener('click', () => game.clearBet());
document.getElementById('change-theme').addEventListener('click', () => game.changeTheme());

// Keyboard shortcuts
document.addEventListener('keydown', (event) => {
    if (game.gamePhase === 'playerTurn') {
        switch(event.key.toLowerCase()) {
            case 'h': game.hit(game.currentHandIndex); break;
            case 's': game.stand(game.currentHandIndex); break;
            case 'd': 
                if (!document.getElementById('double').disabled) {
                    game.doubleDown(game.currentHandIndex);
                }
                break;
            case 'p':
                if (!document.getElementById('split').disabled) {
                    game.split(game.currentHandIndex);
                }
                break;
            case 'r':
                if (!document.getElementById('surrender').disabled) {
                    game.surrender();
                }
                break;
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
