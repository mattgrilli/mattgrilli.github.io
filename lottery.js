'use strict';

// The page for Lucky Draw: renders the engine's state, plays sounds, keeps statistics
// and remembers a couple of preferences. All of the rules live in lottery-engine.js.

// ---- Sounds (reused from the blackjack project's asset folder) ----

const buySound = new Audio('sounds/chip.wav');
const winSound = new Audio('sounds/win.mp3');
const loseSound = new Audio('sounds/lose.mp3');
const jackpotSound = new Audio('sounds/blackjack.mp3');
const clickSound = new Audio('sounds/click.wav');

// localStorage can be unavailable (private windows, blocked site data), so every access
// goes through these and the game keeps working without persistence.
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

let soundMuted = readStorage('lotteryMuted') === '1';

function updateMuteButton() {
    const button = document.getElementById('mute');
    button.textContent = soundMuted ? 'Sound: Off' : 'Sound: On';
    button.setAttribute('aria-pressed', String(!soundMuted));
}

function toggleMute() {
    soundMuted = !soundMuted;
    writeStorage('lotteryMuted', soundMuted ? '1' : '0');
    updateMuteButton();
}

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

// ---- Statistics: lifetime persists; session resets with the bankroll on every load ----

function loadStats() {
    const fresh = { drawsPlayed: 0, ticketsBought: 0, totalSpent: 0, totalWon: 0, biggestWin: 0 };
    try {
        const saved = JSON.parse(readStorage('lotteryStats'));
        const valid = saved && Object.keys(fresh).every(key => Number.isFinite(saved[key]));
        return valid ? { ...fresh, ...saved } : fresh;
    } catch (error) {
        return fresh; // missing or corrupt data
    }
}

function saveStats() {
    writeStorage('lotteryStats', JSON.stringify(gameStats));
}

let gameStats = loadStats();
let sessionStats = { drawsPlayed: 0, ticketsBought: 0, totalSpent: 0, totalWon: 0, biggestWin: 0 };

function recordStats({ drawsPlayed = 0, ticketsBought = 0, spent = 0, won = 0 }) {
    for (const stats of [gameStats, sessionStats]) {
        stats.drawsPlayed += drawsPlayed;
        stats.ticketsBought += ticketsBought;
        stats.totalSpent += spent;
        stats.totalWon += won;
        stats.biggestWin = Math.max(stats.biggestWin, won);
    }
    saveStats();
    updateStatsDisplay();
}

function formatMoney(amount) {
    const sign = amount < 0 ? '-' : '';
    return `${sign}$${Math.abs(Math.round(amount)).toLocaleString('en-US')}`;
}

function updateStatsDisplay() {
    const line = (label, stats) =>
        `${label}: ${stats.drawsPlayed} drawings, ${stats.ticketsBought} tickets, spent ${formatMoney(stats.totalSpent)}, won ${formatMoney(stats.totalWon)}, net ${formatMoney(stats.totalWon - stats.totalSpent)}`;
    document.getElementById('stats').textContent = `${line('Session', sessionStats)}  |  ${line('Lifetime', gameStats)}`;
}

// ---- Small DOM helpers (mirrors the same pattern used in the blackjack project) ----

function setText(element, text) {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

// Unlike element.innerHTML assignment, this doesn't rely on the browser parsing an
// (empty) HTML string - it just removes each child directly, so it behaves the same
// in every environment, including a plain mocked-out DOM used for testing.
function clearChildren(element) {
    while (element.lastChild) {
        element.removeChild(element.lastChild);
    }
}

// Reconciles a container's children with a list of items, touching only what changed.
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

function setMessage(msg) {
    document.getElementById('message').textContent = msg;
}

// ---- The kiosk: renders the engine and reacts to what it reports ----

const QUANTITIES = [1, 5, 10, 25, 50];

// Buying (or winning with) a huge number of tickets is exactly the kind of thing this
// game is for - seeing just how rarely any of them hit. But building a DOM row per
// ticket (each with 6 more elements for its numbers) stops being reasonable long before
// "huge": tens of thousands of rows can make the whole page freeze while the browser
// lays them out. The underlying numbers (balance, statistics, total winnings) are always
// exact regardless; only the detailed, per-ticket list is capped, with a note showing how
// many aren't shown.
const MAX_TICKET_ROWS = 300;
const MAX_WINNER_ROWS = 200;

class Kiosk {
    constructor(engine) {
        this.engine = engine;
        engine.subscribe(event => this.handleEvent(event));
        // The paytable starts hidden. The HTML already says so (a `hidden` attribute, so
        // there's no flash of it before this script runs), but setting it here too means
        // the page doesn't depend on that markup default for its actual behaviour.
        document.getElementById('paytable').hidden = true;
        this.buildPaytable();
        this.updateUI();
    }

    handleEvent(event) {
        switch (event.type) {
            case 'ticketsBought':
                playSound(buySound);
                break;
            case 'ticketsCleared':
                playSound(buySound);
                break;
            case 'drawResolved':
                this.reportDraw(event);
                break;
        }
    }

    reportDraw(draw) {
        recordStats({
            drawsPlayed: 1,
            ticketsBought: draw.results.length,
            spent: draw.results.length * this.engine.ticketPrice,
            won: draw.totalWon
        });

        const winners = draw.results.filter(r => r.tier).sort((a, b) => b.prize - a.prize);
        const loserCount = draw.results.length - winners.length;
        const parts = [];
        if (draw.totalWon > 0) {
            parts.push(`You won ${formatMoney(draw.totalWon)}!`);
        } else {
            parts.push("No winners this time.");
        }
        if (draw.jackpotWon) {
            parts.push(`🎉 JACKPOT! ${formatMoney(draw.jackpotBefore)}!`);
        } else if (draw.results.length > 0) {
            parts.push(`Jackpot rolls over to ${formatMoney(draw.jackpotAfter)}.`);
        }
        setMessage(parts.join(' '));

        if (draw.jackpotWon) {
            playSound(jackpotSound);
            this.showJackpotPopup(draw.jackpotBefore);
        } else if (draw.totalWon > 0) {
            playSound(winSound);
        } else {
            playSound(loseSound);
        }

        this.updateUI();
        void loserCount; // shown in the winners list itself, not needed further here
    }

    showJackpotPopup(amount) {
        const popup = document.createElement('div');
        popup.className = 'jackpot-popup';
        popup.innerHTML = `JACKPOT!<br>${formatMoney(amount)}`;
        document.body.appendChild(popup);
        setTimeout(() => popup.remove(), 4000);
    }

    // ---- Bankroll ----

    setBankroll(amount) {
        const result = this.engine.setBalance(amount);
        if (!result.ok) {
            if (result.reason === 'invalid') {
                setMessage(`Enter a whole-dollar amount of at least $${this.engine.ticketPrice}.`);
            } else {
                setMessage('You can only set your starting balance before buying tickets.');
            }
            return false;
        }
        setMessage(`Starting balance set to ${formatMoney(amount)}.`);
        this.updateUI();
        return true;
    }

    // ---- Buying ----

    buy(quantity) {
        const result = this.engine.buyTickets(quantity);
        if (!result.ok) {
            setMessage(this.buyFailureMessage(result.reason));
            return false;
        }
        // Tickets aren't recorded as spent until the drawing happens (see reportDraw):
        // Clear Tickets can still undo a purchase before then, with nothing to reverse.
        setMessage(`Bought ${quantity} ticket${quantity === 1 ? '' : 's'} for ${formatMoney(quantity * this.engine.ticketPrice)}.`);
        this.updateUI();
        return true;
    }

    buyFailureMessage(reason) {
        if (reason === 'insufficient') return 'Not enough balance for that many tickets.';
        if (reason === 'invalid') return 'Enter a whole number of tickets, at least 1.';
        return 'Tickets are locked once the drawing is in.';
    }

    buyMax() {
        const quantity = this.engine.maxAffordable();
        if (quantity < 1) {
            setMessage('Not enough balance to buy a ticket.');
            return;
        }
        this.buy(quantity);
    }

    clearTickets() {
        const result = this.engine.clearTickets();
        if (!result.ok) {
            return;
        }
        setMessage('Tickets cleared.');
        this.updateUI();
    }

    draw() {
        const result = this.engine.draw();
        if (!result.ok) {
            setMessage(result.reason === 'notickets' ? 'Buy at least one ticket first.' : 'The drawing is already in.');
            return;
        }
        this.updateUI();
    }

    nextRound() {
        if (this.engine.nextRound()) {
            setMessage('Buy your tickets for the next drawing.');
            this.updateUI();
        }
    }

    restart() {
        if (this.engine.restart()) {
            setMessage(`New game. You start again with ${formatMoney(this.engine.startingBalance)}.`);
            this.updateUI();
        }
    }

    // ---- Rendering ----

    updateUI() {
        const engine = this.engine;
        document.getElementById('game-container').dataset.phase = engine.phase;
        document.getElementById('balance').textContent = `Balance: ${formatMoney(engine.balance)}`;
        document.getElementById('jackpot').textContent = `Jackpot: ${formatMoney(engine.jackpot)}`;

        this.renderDrawnBalls();
        this.renderTickets();
        this.renderWinners();
        this.updateQuantityChips();
        this.updateButtons();
        this.buildPaytable(); // the jackpot row's amount can have changed
    }

    renderDrawnBalls() {
        const container = document.getElementById('drawn-balls');
        const draw = this.engine.phase === 'results' ? this.engine.lastDraw : null;
        const balls = draw ? [...draw.winningWhites.map(n => ({ n, red: false })), { n: draw.winningRed, red: true }] : [];
        syncChildren(container, balls,
            (ball, index) => `${index}:${ball.n}:${ball.red}`,
            (ball, index) => this.buildBall(ball, index));
    }

    buildBall(ball, index) {
        const el = document.createElement('div');
        el.className = `ball ${ball.red ? 'red' : 'white'}`;
        el.textContent = String(ball.n);
        el.style.animationDelay = `${index * 120}ms`;
        return el;
    }

    renderTickets() {
        const engine = this.engine;
        const summary = document.getElementById('tickets-summary');
        const details = document.getElementById('ticket-details');
        const list = document.getElementById('ticket-list');

        if (engine.tickets.length === 0) {
            setText(summary, '');
            details.hidden = true;
            clearChildren(list); // clear any rows left from before
            return;
        }

        details.hidden = false;
        const noun = engine.tickets.length === 1 ? 'ticket' : 'tickets';
        setText(summary, engine.phase === 'buying'
            ? `You have ${engine.tickets.length} ${noun} in this drawing.`
            : `${engine.tickets.length} ${noun} played.`);

        const draw = engine.phase === 'results' ? engine.lastDraw : null;
        const shown = engine.tickets.slice(0, MAX_TICKET_ROWS);
        syncChildren(list, shown,
            (ticket, index) => `${index}:${ticket.whites.join(',')}:${ticket.red}`,
            () => this.buildTicketRow(),
            (row, ticket, index) => this.updateTicketRow(row, ticket, index, draw));

        const hiddenCount = engine.tickets.length - shown.length;
        setText(document.getElementById('ticket-list-note'),
            hiddenCount > 0 ? `+ ${hiddenCount.toLocaleString('en-US')} more not shown (still fully counted above).` : '');
    }

    buildTicketRow() {
        const row = document.createElement('div');
        row.className = 'ticket-row';
        const label = document.createElement('span');
        label.className = 'ticket-label';
        const balls = document.createElement('span');
        balls.className = 'ticket-balls';
        row.appendChild(label);
        row.appendChild(balls);
        row.parts = { label, balls };
        return row;
    }

    updateTicketRow(row, ticket, index, draw) {
        setText(row.parts.label, `#${index + 1}`);
        const winningWhites = draw ? draw.winningWhites : [];
        const winningRed = draw ? draw.winningRed : null;
        const numbers = [...ticket.whites.map(n => ({ n, red: false })), { n: ticket.red, red: true }];
        clearChildren(row.parts.balls);
        numbers.forEach(({ n, red }) => {
            const mini = document.createElement('span');
            const hit = red ? n === winningRed : winningWhites.includes(n);
            mini.className = `mini-ball ${red ? 'red' : 'white'}${hit ? ' hit' : ''}`;
            mini.textContent = String(n);
            row.parts.balls.appendChild(mini);
        });
    }

    renderWinners() {
        const container = document.getElementById('winners-list');
        const draw = this.engine.phase === 'results' ? this.engine.lastDraw : null;
        if (!draw) {
            clearChildren(container);
            return;
        }
        const winners = draw.results
            .map((result, index) => ({ result, index }))
            .filter(entry => entry.result.tier)
            .sort((a, b) => b.result.prize - a.result.prize);
        const loserCount = draw.results.length - winners.length;

        clearChildren(container);
        if (winners.length === 0) {
            const p = document.createElement('p');
            p.className = 'no-winners';
            p.textContent = draw.results.length === 1 ? 'That ticket did not win.' : 'No winning tickets this drawing.';
            container.appendChild(p);
            return;
        }
        const shownWinners = winners.slice(0, MAX_WINNER_ROWS);
        const list = document.createElement('div');
        list.className = 'winner-rows';
        shownWinners.forEach(({ result, index }) => {
            const row = document.createElement('div');
            row.className = 'winner-row';
            const ticket = document.createElement('span');
            ticket.className = 'winner-ticket';
            ticket.textContent = `Ticket #${index + 1}`;
            const tier = document.createElement('span');
            tier.className = 'winner-tier';
            tier.textContent = result.tierLabel;
            const prize = document.createElement('span');
            prize.className = 'winner-prize';
            prize.textContent = formatMoney(result.prize);
            row.appendChild(ticket);
            row.appendChild(tier);
            row.appendChild(prize);
            list.appendChild(row);
        });
        container.appendChild(list);
        const hiddenWinners = winners.length - shownWinners.length;
        if (hiddenWinners > 0) {
            const p = document.createElement('p');
            p.className = 'no-winners';
            p.textContent = `+ ${hiddenWinners.toLocaleString('en-US')} more winning tickets not shown (still fully counted above).`;
            container.appendChild(p);
        }
        if (loserCount > 0) {
            const p = document.createElement('p');
            p.className = 'no-winners';
            p.textContent = `${loserCount.toLocaleString('en-US')} other ticket${loserCount === 1 ? '' : 's'} did not win.`;
            container.appendChild(p);
        }
    }

    updateQuantityChips() {
        const engine = this.engine;
        const buying = engine.phase === 'buying';
        const values = [...QUANTITIES, 'max'];
        syncChildren(document.getElementById('quantity-container'), values,
            value => `${value}:${buying && this.affordable(value) ? 1 : 0}`,
            value => this.buildQuantityChip(value, buying && this.affordable(value)));
    }

    affordable(value) {
        if (value === 'max') {
            return this.engine.maxAffordable() >= 1;
        }
        return this.engine.balance >= value * this.engine.ticketPrice;
    }

    buildQuantityChip(value, usable) {
        const chip = document.createElement('div');
        const label = value === 'max' ? 'Max' : `${value}`;
        chip.className = `chip qty-chip${value === 'max' ? ' qty-max' : ''}${usable ? '' : ' locked'}`;
        chip.setAttribute('role', 'button');
        chip.setAttribute('aria-label', value === 'max' ? 'Buy as many tickets as you can afford' : `Buy ${value} ticket${value === 1 ? '' : 's'}`);
        chip.tabIndex = usable ? 0 : -1;
        const span = document.createElement('span');
        span.className = 'chip-value';
        span.textContent = label;
        chip.appendChild(span);
        const act = () => (value === 'max' ? this.buyMax() : this.buy(value));
        chip.onclick = act;
        chip.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                act();
            }
        };
        return chip;
    }

    updateButtons() {
        const engine = this.engine;
        document.getElementById('clear-tickets').disabled = !(engine.phase === 'buying' && engine.tickets.length > 0);
        document.getElementById('quantity-amount').disabled = engine.phase !== 'buying';
        document.getElementById('buy-custom').disabled = engine.phase !== 'buying';
        document.getElementById('draw-button').disabled = !engine.canDraw();
        document.getElementById('restart').style.display = engine.isBroke() ? 'inline-block' : 'none';
        document.getElementById('bankroll-amount').disabled = !engine.canSetBalance();
        document.getElementById('set-bankroll').disabled = !engine.canSetBalance();
    }

    buildPaytable() {
        const body = document.getElementById('paytable-body');
        const table = computeOddsTable();
        syncChildren(body, table,
            tier => tier.key,
            () => this.buildPaytableRow(),
            (row, tier) => this.updatePaytableRow(row, tier));
    }

    buildPaytableRow() {
        const row = document.createElement('tr');
        const parts = [document.createElement('td'), document.createElement('td'), document.createElement('td')];
        parts.forEach(cell => row.appendChild(cell));
        row.parts = parts;
        return row;
    }

    updatePaytableRow(row, tier) {
        const prizeText = tier.key === 'overall' ? '—' : (tier.prize === 'jackpot' ? formatMoney(this.engine.jackpot) + '+' : formatMoney(tier.prize));
        setText(row.parts[0], tier.label);
        setText(row.parts[1], prizeText);
        setText(row.parts[2], tier.oddsLabel);
        row.classList.toggle('overall-row', tier.key === 'overall');
    }

    togglePaytable() {
        const panel = document.getElementById('paytable');
        const button = document.getElementById('toggle-paytable');
        panel.hidden = !panel.hidden;
        button.setAttribute('aria-pressed', String(!panel.hidden));
        playSound(clickSound);
    }
}

// ---- Wiring ----

const engine = new LotteryEngine();
const kiosk = new Kiosk(engine);

document.getElementById('mute').addEventListener('click', toggleMute);
updateMuteButton();
updateStatsDisplay();

document.getElementById('toggle-paytable').addEventListener('click', () => kiosk.togglePaytable());
document.getElementById('clear-tickets').addEventListener('click', () => kiosk.clearTickets());
document.getElementById('draw-button').addEventListener('click', () => kiosk.draw());
document.getElementById('next-round').addEventListener('click', () => kiosk.nextRound());
document.getElementById('restart').addEventListener('click', () => kiosk.restart());

const bankrollInput = document.getElementById('bankroll-amount');
function applyBankroll() {
    const value = Number(bankrollInput.value);
    if (kiosk.setBankroll(value)) {
        bankrollInput.value = '';
    }
}
document.getElementById('set-bankroll').addEventListener('click', applyBankroll);
bankrollInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        applyBankroll();
    }
});

const quantityInput = document.getElementById('quantity-amount');
function applyQuantity() {
    const value = Number(quantityInput.value);
    if (kiosk.buy(value)) {
        quantityInput.value = '';
    }
}
document.getElementById('buy-custom').addEventListener('click', applyQuantity);
quantityInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        applyQuantity();
    }
});

document.addEventListener('keydown', event => {
    if (event.target && event.target.tagName === 'INPUT') {
        return;
    }
    if (engine.phase === 'buying' && event.key === 'Enter' && engine.canDraw()) {
        kiosk.draw();
    } else if (engine.phase === 'results' && event.key === 'Enter') {
        kiosk.nextRound();
    }
});
