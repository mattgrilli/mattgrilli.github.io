'use strict';

// The page for Matt's Baccarat: renders the engine's state, plays sounds, keeps
// statistics and remembers a couple of preferences. All of the rules live in
// baccarat-engine.js. The engine works in integer cents; this page shows dollars.

// ---- Sounds (shared with the other games) ----

const chipSound = new Audio('sounds/chip.wav');
const cardSound = new Audio('sounds/card.wav');
const winSound = new Audio('sounds/win.mp3');
const loseSound = new Audio('sounds/lose.mp3');
const pushSound = new Audio('sounds/draw.wav');
const bigWinSound = new Audio('sounds/blackjack.mp3');
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

let soundMuted = readStorage('baccaratMuted') === '1';

function updateMuteButton() {
    const button = document.getElementById('mute');
    button.textContent = soundMuted ? 'Sound: Off' : 'Sound: On';
    button.setAttribute('aria-pressed', String(!soundMuted));
}

function toggleMute() {
    soundMuted = !soundMuted;
    writeStorage('baccaratMuted', soundMuted ? '1' : '0');
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

// ---- Money: the engine counts cents ----

function formatMoney(cents) {
    const sign = cents < 0 ? '-' : '';
    const abs = Math.abs(Math.round(cents));
    const dollars = Math.floor(abs / 100).toLocaleString('en-US');
    const rest = abs % 100;
    return rest === 0 ? `${sign}$${dollars}` : `${sign}$${dollars}.${String(rest).padStart(2, '0')}`;
}

// ---- Statistics (cents): lifetime persists; session resets on every load ----

function freshPageStats() {
    return { handsPlayed: 0, totalWagered: 0, totalWon: 0, biggestWin: 0 };
}

function loadStats() {
    const fresh = freshPageStats();
    try {
        const saved = JSON.parse(readStorage('baccaratStats'));
        const valid = saved && Object.keys(fresh).every(key => Number.isFinite(saved[key]));
        return valid ? { ...fresh, ...saved } : fresh;
    } catch (error) {
        return fresh; // missing or corrupt data
    }
}

function saveStats() {
    writeStorage('baccaratStats', JSON.stringify(gameStats));
}

let gameStats = loadStats();
let sessionStats = freshPageStats();

// `biggestWin` defaults to `won`, which is right for one hand. A fast-forward run spans
// many hands and passes its own largest single hand explicitly - not the run's total.
function recordStats({ handsPlayed = 0, wagered = 0, won = 0, biggestWin = won }) {
    for (const stats of [gameStats, sessionStats]) {
        stats.handsPlayed += handsPlayed;
        stats.totalWagered += wagered;
        stats.totalWon += won;
        stats.biggestWin = Math.max(stats.biggestWin, biggestWin);
    }
    saveStats();
    updateStatsDisplay();
}

function updateStatsDisplay() {
    const line = (label, stats) =>
        `${label}: ${stats.handsPlayed} hands, wagered ${formatMoney(stats.totalWagered)}, won ${formatMoney(stats.totalWon)}, net ${formatMoney(stats.totalWon - stats.totalWagered)}`;
    document.getElementById('stats').textContent = `${line('Session', sessionStats)}  |  ${line('Lifetime', gameStats)}`;
}

// ---- Small DOM helpers (the same pattern as the other games) ----

function setText(element, text) {
    if (element.textContent !== text) {
        element.textContent = text;
    }
}

function clearChildren(element) {
    while (element.lastChild) {
        element.removeChild(element.lastChild);
    }
}

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

// ---- The table ----

const CHIP_VALUES = [1, 5, 25, 100, 500]; // dollars
const SPOT_INFO = {
    player: { label: 'Player', pays: 'pays 1:1' },
    tie: { label: 'Tie', pays: 'pays 8:1' },
    banker: { label: 'Banker', pays: 'pays 0.95:1' }
};
const SPOT_ORDER = ['player', 'tie', 'banker'];
const SIDE_NAMES = { player: 'Player', banker: 'Banker', tie: 'Tie' };
const SUIT_NAMES = { '♠': 'spades', '♥': 'hearts', '♦': 'diamonds', '♣': 'clubs' };
const RANK_NAMES = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack' };

const MAX_FASTFORWARD_HANDS = 100_000;
const FASTFORWARD_CHUNK_BUDGET_MS = 20;

class BaccaratTable {
    constructor(engine) {
        this.engine = engine;
        this.selectedAmount = 5; // dollars
        this.lastBets = null;    // the previous hand's bets, for "Same Bets Again"
        this.fastForwarding = false;
        this.spots = {};
        engine.subscribe(event => this.handleEvent(event));
        document.getElementById('paytable').hidden = true;
        document.getElementById('game-container').dataset.fastforward = 'false';
        this.buildSpots();
        this.buildPaytable();
        this.updateUI();
    }

    handleEvent(event) {
        // Fast-forward drives the engine directly and tracks its own totals; reacting to
        // every simulated hand here too would mean a sound and a re-render per hand.
        if (this.fastForwarding) {
            return;
        }
        switch (event.type) {
            case 'betPlaced':
            case 'betsCleared':
                playSound(chipSound);
                break;
            case 'coupResolved':
                this.reportCoup(event);
                break;
        }
    }

    reportCoup(coup) {
        recordStats({ handsPlayed: 1, wagered: coup.wagered, won: coup.totalWon });

        const winnerText = coup.winner === 'tie'
            ? `Tie at ${coup.playerTotal}.`
            : `${SIDE_NAMES[coup.winner]} wins${coup.natural ? ' with a natural' : ''}, ${Math.max(coup.playerTotal, coup.bankerTotal)} to ${Math.min(coup.playerTotal, coup.bankerTotal)}.`;
        const net = coup.totalWon - coup.wagered;
        const moneyText = net > 0 ? `You won ${formatMoney(net)}.` : net < 0 ? `You lost ${formatMoney(-net)}.` : 'Your bets came back even.';
        setMessage(`${winnerText} ${moneyText}`);

        playSound(cardSound);
        if (coup.results.some(r => r.spot === 'tie' && r.outcome === 'won')) {
            playSound(bigWinSound);
        } else if (net > 0) {
            playSound(winSound);
        } else if (net === 0) {
            playSound(pushSound);
        } else {
            playSound(loseSound);
        }
        this.updateUI();
    }

    // ---- Bankroll ----

    setBankroll(dollars) {
        if (this.fastForwarding) {
            return false;
        }
        if (!Number.isInteger(dollars)) {
            setMessage('Enter a whole-dollar amount of at least $1.');
            return false;
        }
        const result = this.engine.setBalance(dollars * 100);
        if (!result.ok) {
            setMessage(result.reason === 'invalid'
                ? 'Enter a whole-dollar amount of at least $1.'
                : 'You can only set your starting balance before placing bets.');
            return false;
        }
        setMessage(`Starting balance set to ${formatMoney(dollars * 100)}.`);
        this.updateUI();
        return true;
    }

    // ---- Betting ----

    selectAmount(dollars) {
        this.selectedAmount = dollars;
        this.updateChips();
    }

    placeBet(spot) {
        if (this.fastForwarding) {
            return false;
        }
        const result = this.engine.placeBet(spot, this.selectedAmount * 100);
        if (!result.ok) {
            setMessage(this.betFailureMessage(result.reason));
            return false;
        }
        document.getElementById('fastforward-summary').hidden = true;
        this.updateUI();
        return true;
    }

    betFailureMessage(reason) {
        if (reason === 'insufficient') return 'Not enough balance for that bet.';
        if (reason === 'invalid') return 'That bet is not valid.';
        return 'Bets are locked once the cards are dealt.';
    }

    clearBets() {
        if (this.fastForwarding) {
            return;
        }
        if (this.engine.clearBets().ok) {
            setMessage('Bets cleared.');
            this.updateUI();
        }
    }

    // ---- Dealing ----

    deal() {
        if (this.fastForwarding) {
            return;
        }
        const bets = { ...this.engine.bets };
        const result = this.engine.deal();
        if (!result.ok) {
            setMessage(result.reason === 'nobets' ? 'Place a bet first.' : 'The cards are already dealt.');
            return;
        }
        this.lastBets = bets;
        this.updateUI();
    }

    nextRound() {
        if (this.fastForwarding) {
            return false;
        }
        if (this.engine.nextRound()) {
            setMessage('Place your bets.');
            this.updateUI();
            return true;
        }
        return false;
    }

    // Starts the next hand with the same bets as the last one, as far as the balance allows.
    rebet() {
        if (this.fastForwarding || !this.lastBets) {
            return false;
        }
        if (this.engine.phase === 'results' && !this.engine.nextRound()) {
            return false;
        }
        let placed = 0;
        for (const spot of SPOT_ORDER) {
            if (this.lastBets[spot] > 0 && this.engine.placeBet(spot, this.lastBets[spot]).ok) {
                placed++;
            }
        }
        setMessage(placed > 0 ? 'Same bets placed. Deal when ready.' : 'Not enough balance to repeat those bets.');
        this.updateUI();
        return placed > 0;
    }

    canRebet() {
        if (this.fastForwarding || !this.lastBets || this.engine.phase !== 'results') {
            return false;
        }
        const total = this.lastBets.player + this.lastBets.banker + this.lastBets.tie;
        return total > 0 && this.engine.balance >= total;
    }

    restart() {
        if (this.fastForwarding) {
            return;
        }
        if (this.engine.restart()) {
            this.lastBets = null;
            setMessage(`New game. You start again with ${formatMoney(this.engine.startingBalance)}.`);
            this.updateUI();
        }
    }

    // ---- Fast-forward: many real hands with the same bets ----

    canFastForward() {
        return !this.fastForwarding && this.engine.phase === 'betting' && this.engine.totalWagered() > 0;
    }

    runFastForward(hands) {
        if (!this.canFastForward()) {
            return;
        }
        if (!Number.isInteger(hands) || hands < 1 || hands > MAX_FASTFORWARD_HANDS) {
            setMessage(`Enter a number of hands from 1 to ${MAX_FASTFORWARD_HANDS.toLocaleString('en-US')}.`);
            return;
        }
        const pattern = { ...this.engine.bets };
        this.engine.clearBets(); // refund the preview; each simulated hand places it fresh

        this.fastForwarding = true;
        this.ff = {
            target: hands, pattern, handsRun: 0, wagered: 0, won: 0, biggestWin: 0,
            playerWins: 0, bankerWins: 0, ties: 0, stoppedEarly: false, outOfMoney: false
        };
        document.getElementById('game-container').dataset.fastforward = 'true';
        document.getElementById('fastforward-summary').hidden = true;
        this.updateFastForwardProgress();
        this.updateUI(); // lock the spots and controls now, not once the first chunk runs
        setTimeout(() => this.fastForwardChunk(), 0);
    }

    stopFastForward() {
        if (this.fastForwarding && this.ff) {
            this.ff.stoppedEarly = true;
        }
    }

    fastForwardChunk() {
        const ff = this.ff;
        const engine = this.engine;
        const chunkStart = Date.now();

        while (ff.handsRun < ff.target && !ff.stoppedEarly) {
            const needed = ff.pattern.player + ff.pattern.banker + ff.pattern.tie;
            if (engine.balance < needed) {
                ff.outOfMoney = true;
                break;
            }
            for (const spot of SPOT_ORDER) {
                if (ff.pattern[spot] > 0) {
                    engine.placeBet(spot, ff.pattern[spot]);
                }
            }
            const { coup } = engine.deal();
            ff.handsRun += 1;
            ff.wagered += coup.wagered;
            ff.won += coup.totalWon;
            if (coup.totalWon > ff.biggestWin) {
                ff.biggestWin = coup.totalWon;
            }
            if (coup.winner === 'player') ff.playerWins += 1;
            else if (coup.winner === 'banker') ff.bankerWins += 1;
            else ff.ties += 1;
            engine.nextRound();

            if (Date.now() - chunkStart > FASTFORWARD_CHUNK_BUDGET_MS) {
                break;
            }
        }

        this.updateFastForwardProgress();
        if (ff.handsRun >= ff.target || ff.stoppedEarly || ff.outOfMoney) {
            this.finishFastForward();
        } else {
            setTimeout(() => this.fastForwardChunk(), 0);
        }
    }

    updateFastForwardProgress() {
        const ff = this.ff;
        const pct = ff.target > 0 ? Math.round((ff.handsRun / ff.target) * 100) : 0;
        document.getElementById('ff-progress').setAttribute('aria-valuenow', String(pct));
        document.getElementById('ff-progress-fill').style.width = `${pct}%`;
        setText(document.getElementById('ff-progress-label'),
            `Simulating... ${ff.handsRun.toLocaleString('en-US')} / ${ff.target.toLocaleString('en-US')} hands`);
    }

    finishFastForward() {
        const ff = this.ff;
        this.fastForwarding = false;
        this.lastBets = { ...ff.pattern };
        document.getElementById('game-container').dataset.fastforward = 'false';
        recordStats({ handsPlayed: ff.handsRun, wagered: ff.wagered, won: ff.won, biggestWin: ff.biggestWin });

        const net = ff.won - ff.wagered;
        const pct = count => (ff.handsRun > 0 ? `${(count / ff.handsRun * 100).toFixed(1)}%` : '-');
        const exact = computeExactOdds();
        const summary = document.getElementById('fastforward-summary');
        summary.hidden = false;
        clearChildren(summary);
        const heading = document.createElement('h3');
        heading.textContent = ff.stoppedEarly ? 'Stopped early' : (ff.outOfMoney ? 'Ran out of money' : 'Simulation complete');
        const lines = document.createElement('div');
        lines.innerHTML =
            `Hands played: ${ff.handsRun.toLocaleString('en-US')}<br>` +
            `Wagered: ${formatMoney(ff.wagered)} &middot; Won back: ${formatMoney(ff.won)} &middot; Net: ${formatMoney(net)}` +
            (ff.wagered > 0 ? ` (${(net / ff.wagered * 100).toFixed(2)}% of what you bet)` : '') + '<br>' +
            `Banker won ${pct(ff.bankerWins)} (exact: ${(exact.banker * 100).toFixed(1)}%), ` +
            `Player ${pct(ff.playerWins)} (${(exact.player * 100).toFixed(1)}%), ` +
            `Tie ${pct(ff.ties)} (${(exact.tie * 100).toFixed(1)}%)<br>` +
            `Biggest single hand: ${formatMoney(ff.biggestWin)}`;
        summary.appendChild(heading);
        summary.appendChild(lines);

        setMessage(`Simulated ${ff.handsRun.toLocaleString('en-US')} hands. Net ${formatMoney(net)}.`);
        this.updateUI();
    }

    // ---- Rendering ----

    buildSpots() {
        const container = document.getElementById('bet-spots');
        for (const spot of SPOT_ORDER) {
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `bet-spot spot-${spot}`;
            const name = document.createElement('span');
            name.className = 'spot-name';
            name.textContent = SPOT_INFO[spot].label;
            const pays = document.createElement('span');
            pays.className = 'spot-pays';
            pays.textContent = SPOT_INFO[spot].pays;
            const badge = document.createElement('span');
            badge.className = 'spot-badge';
            el.appendChild(name);
            el.appendChild(pays);
            el.appendChild(badge);
            el.parts = { badge };
            el.onclick = () => this.placeBet(spot);
            container.appendChild(el);
            this.spots[spot] = el;
        }
    }

    updateUI() {
        const engine = this.engine;
        const container = document.getElementById('game-container');
        container.dataset.phase = engine.phase;
        document.getElementById('balance').textContent = `Balance: ${formatMoney(engine.balance)}`;
        document.getElementById('wagered').textContent = `Wagered: ${formatMoney(engine.totalWagered())}`;
        this.renderShoe();
        this.renderHands();
        this.renderSpots();
        this.renderScoreboard();
        this.updateChips();
        this.updateButtons();
    }

    renderShoe() {
        const shoe = this.engine.shoe;
        const total = shoe.numDecks * 52;
        document.getElementById('shoe-fill').style.height = `${(shoe.cards.length / total) * 100}%`;
        setText(document.getElementById('cards-remaining'), `${shoe.cards.length} cards`);
    }

    renderHands() {
        const coup = this.engine.phase === 'results' ? this.engine.lastCoup : null;
        for (const side of ['player', 'banker']) {
            const row = document.getElementById(`${side}-cards`);
            const score = document.getElementById(`${side}-score`);
            const panel = document.getElementById(`${side}-panel`);
            if (!coup) {
                clearChildren(row);
                score.hidden = true;
                panel.classList.remove('winner');
                continue;
            }
            // Each card animates in at its place in the real dealing order (P, B, P, B, ...).
            const cardsWithOrder = coup[side].map(card => ({ card, order: coup.order.findIndex(o => o.card === card) }));
            syncChildren(row, cardsWithOrder,
                ({ card }, index) => `${index}:${card.rank}${card.suit}`,
                ({ card, order }) => this.buildCard(card, order));
            score.hidden = false;
            setText(score, String(side === 'player' ? coup.playerTotal : coup.bankerTotal));
            panel.classList.toggle('winner', coup.winner === side);
        }
    }

    buildCard(card, order) {
        const el = document.createElement('div');
        const red = card.suit === '♥' || card.suit === '♦';
        el.className = `card ${red ? 'red' : 'black'} deal-in`;
        el.style.animationDelay = `${order * 180}ms`;
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', `${RANK_NAMES[card.rank] || card.rank} of ${SUIT_NAMES[card.suit]}`);
        el.innerHTML =
            `<div class="card-corner top-left"><div class="card-value">${card.rank}</div><div class="card-suit">${card.suit}</div></div>` +
            `<div class="card-center-suit">${card.suit}</div>` +
            `<div class="card-corner bottom-right"><div class="card-value">${card.rank}</div><div class="card-suit">${card.suit}</div></div>`;
        return el;
    }

    renderSpots() {
        const engine = this.engine;
        const results = engine.phase === 'results' ? engine.lastCoup.results : [];
        for (const spot of SPOT_ORDER) {
            const el = this.spots[spot];
            const amount = engine.phase === 'results'
                ? (results.find(r => r.spot === spot) || { stake: 0 }).stake
                : engine.bets[spot];
            setText(el.parts.badge, amount > 0 ? formatMoney(amount) : '');
            el.classList.toggle('has-bet', amount > 0);
            const outcome = (results.find(r => r.spot === spot) || {}).outcome || null;
            el.classList.toggle('bet-won', outcome === 'won');
            el.classList.toggle('bet-lost', outcome === 'lost');
            el.classList.toggle('bet-push', outcome === 'push');
            el.disabled = this.fastForwarding || engine.phase !== 'betting';
        }
    }

    renderScoreboard() {
        const history = this.engine.history;
        syncChildren(document.getElementById('bead-road'), history,
            (winner, index) => `${index}:${winner}`,
            winner => {
                const bead = document.createElement('span');
                bead.className = `bead bead-${winner}`;
                bead.textContent = winner === 'player' ? 'P' : winner === 'banker' ? 'B' : 'T';
                bead.title = SIDE_NAMES[winner];
                return bead;
            });
        const s = this.engine.stats;
        setText(document.getElementById('scoreboard-counts'), s.handsPlayed > 0
            ? `Since you sat down: Banker ${s.bankerWins} · Player ${s.playerWins} · Tie ${s.ties}`
            : 'Recent results appear here. Past results never change the odds of the next hand.');
    }

    updateChips() {
        syncChildren(document.getElementById('chip-container'), CHIP_VALUES,
            value => `${value}:${this.selectedAmount === value ? 1 : 0}`,
            value => this.buildChip(value));
    }

    buildChip(value) {
        const chip = document.createElement('div');
        chip.className = `chip chip-${value}${this.selectedAmount === value ? ' selected' : ''}`;
        chip.setAttribute('role', 'button');
        chip.setAttribute('aria-label', `Bet in units of $${value}`);
        chip.tabIndex = 0;
        const label = document.createElement('span');
        label.className = 'chip-value';
        label.textContent = `$${value}`;
        chip.appendChild(label);
        chip.onclick = () => this.selectAmount(value);
        chip.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.selectAmount(value);
            }
        };
        return chip;
    }

    updateButtons() {
        const engine = this.engine;
        const ff = this.fastForwarding;
        document.getElementById('clear-bets').disabled = ff || !(engine.phase === 'betting' && engine.totalWagered() > 0);
        document.getElementById('custom-amount').disabled = ff;
        document.getElementById('set-custom-amount').disabled = ff;
        document.getElementById('deal-button').disabled = ff || !engine.canDeal();
        document.getElementById('rebet').disabled = !this.canRebet();
        document.getElementById('restart').style.display = !ff && engine.isBroke() ? 'inline-block' : 'none';
        document.getElementById('bankroll-amount').disabled = ff || !engine.canSetBalance();
        document.getElementById('set-bankroll').disabled = ff || !engine.canSetBalance();
        document.getElementById('ff-hands').disabled = !this.canFastForward();
        document.getElementById('fast-forward-button').disabled = !this.canFastForward();
    }

    buildPaytable() {
        syncChildren(document.getElementById('paytable-body'), computeOddsTable(),
            row => row.key,
            () => {
                const tr = document.createElement('tr');
                const parts = [0, 1, 2, 3].map(() => document.createElement('td'));
                parts.forEach(td => tr.appendChild(td));
                tr.parts = parts;
                return tr;
            },
            (tr, row) => {
                setText(tr.parts[0], row.label);
                setText(tr.parts[1], row.payoutLabel);
                setText(tr.parts[2], `${(row.winProbability * 100).toFixed(2)}%`);
                setText(tr.parts[3], `${row.houseEdgePct.toFixed(2)}%`);
            });
    }

    togglePaytable() {
        const panel = document.getElementById('paytable');
        panel.hidden = !panel.hidden;
        document.getElementById('toggle-paytable').setAttribute('aria-pressed', String(!panel.hidden));
        playSound(clickSound);
    }
}

// ---- Wiring ----

const engine = new BaccaratEngine();
const table = new BaccaratTable(engine);

document.getElementById('mute').addEventListener('click', toggleMute);
updateMuteButton();
updateStatsDisplay();

document.getElementById('toggle-paytable').addEventListener('click', () => table.togglePaytable());
document.getElementById('clear-bets').addEventListener('click', () => table.clearBets());
document.getElementById('deal-button').addEventListener('click', () => table.deal());
document.getElementById('next-round').addEventListener('click', () => table.nextRound());
document.getElementById('rebet').addEventListener('click', () => table.rebet());
document.getElementById('restart').addEventListener('click', () => table.restart());

const bankrollInput = document.getElementById('bankroll-amount');
function applyBankroll() {
    if (table.setBankroll(Number(bankrollInput.value))) {
        bankrollInput.value = '';
    }
}
document.getElementById('set-bankroll').addEventListener('click', applyBankroll);
bankrollInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        applyBankroll();
    }
});

const customAmountInput = document.getElementById('custom-amount');
function applyCustomAmount() {
    const value = Number(customAmountInput.value);
    if (Number.isInteger(value) && value >= 1) {
        table.selectAmount(value);
        customAmountInput.value = '';
        setMessage(`Chip set to $${value}. Click Player, Banker or Tie to bet it.`);
    } else {
        setMessage('Enter a whole-dollar chip amount, at least $1.');
    }
}
document.getElementById('set-custom-amount').addEventListener('click', applyCustomAmount);
customAmountInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        applyCustomAmount();
    }
});

document.getElementById('fast-forward-button').addEventListener('click', () => {
    table.runFastForward(Number(document.getElementById('ff-hands').value));
});
document.getElementById('ff-stop-button').addEventListener('click', () => table.stopFastForward());

document.addEventListener('keydown', event => {
    if (event.target && event.target.tagName === 'INPUT') {
        return;
    }
    if (event.key !== 'Enter') {
        return;
    }
    if (engine.phase === 'betting' && engine.canDeal()) {
        table.deal();
    } else if (engine.phase === 'results') {
        table.nextRound();
    }
});
