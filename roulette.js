'use strict';

// The page for Matt's Roulette: renders the engine's state, plays sounds, keeps
// statistics and remembers a couple of preferences. All of the rules live in
// roulette-engine.js.

// ---- Sounds (reused from the blackjack project's asset folder) ----

const chipSound = new Audio('sounds/chip.wav');
const winSound = new Audio('sounds/win.mp3');
const loseSound = new Audio('sounds/lose.mp3');
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

let soundMuted = readStorage('rouletteMuted') === '1';

function updateMuteButton() {
    const button = document.getElementById('mute');
    button.textContent = soundMuted ? 'Sound: Off' : 'Sound: On';
    button.setAttribute('aria-pressed', String(!soundMuted));
}

function toggleMute() {
    soundMuted = !soundMuted;
    writeStorage('rouletteMuted', soundMuted ? '1' : '0');
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
    const fresh = { spinsPlayed: 0, betsPlaced: 0, totalWagered: 0, totalWon: 0, biggestWin: 0 };
    try {
        const saved = JSON.parse(readStorage('rouletteStats'));
        const valid = saved && Object.keys(fresh).every(key => Number.isFinite(saved[key]));
        return valid ? { ...fresh, ...saved } : fresh;
    } catch (error) {
        return fresh; // missing or corrupt data
    }
}

function saveStats() {
    writeStorage('rouletteStats', JSON.stringify(gameStats));
}

let gameStats = loadStats();
let sessionStats = { spinsPlayed: 0, betsPlaced: 0, totalWagered: 0, totalWon: 0, biggestWin: 0 };

// `biggestWin` defaults to `won`, correct for a single settled spin (its own total is
// also the biggest single win in it). A fast-forward run spans many spins, so it passes
// its own largest single-spin payout explicitly - not `won`, which is the sum across the
// whole run and would otherwise inflate this figure.
function recordStats({ spinsPlayed = 0, betsPlaced = 0, wagered = 0, won = 0, biggestWin = won }) {
    for (const stats of [gameStats, sessionStats]) {
        stats.spinsPlayed += spinsPlayed;
        stats.betsPlaced += betsPlaced;
        stats.totalWagered += wagered;
        stats.totalWon += won;
        stats.biggestWin = Math.max(stats.biggestWin, biggestWin);
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
        `${label}: ${stats.spinsPlayed} spins, ${stats.betsPlaced} bets, wagered ${formatMoney(stats.totalWagered)}, won ${formatMoney(stats.totalWon)}, net ${formatMoney(stats.totalWon - stats.totalWagered)}`;
    document.getElementById('stats').textContent = `${line('Session', sessionStats)}  |  ${line('Lifetime', gameStats)}`;
}

// ---- Small DOM helpers (mirrors the pattern used throughout this project) ----

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

// ---- Table layout ----

const CHIP_VALUES = [1, 5, 10, 25, 100];

// The outside bets, in the order they're shown: each row of the real table layout.
const OUTSIDE_BETS = [
    { type: 'dozen1', label: '1st 12' }, { type: 'dozen2', label: '2nd 12' }, { type: 'dozen3', label: '3rd 12' },
    { type: 'low', label: '1 to 18' }, { type: 'even', label: 'Even' },
    { type: 'red', label: 'Red' }, { type: 'black', label: 'Black' },
    { type: 'odd', label: 'Odd' }, { type: 'high', label: '19 to 36' },
    { type: 'column1', label: '2 to 1' }, { type: 'column2', label: '2 to 1' }, { type: 'column3', label: '2 to 1' }
];

// A UI-level cap on how many spins a single fast-forward run can simulate.
const MAX_FASTFORWARD_SPINS = 100_000;
const FASTFORWARD_CHUNK_BUDGET_MS = 20;

class RouletteTable {
    constructor(engine) {
        this.engine = engine;
        this.selectedAmount = 5;
        this.fastForwarding = false;
        engine.subscribe(event => this.handleEvent(event));
        document.getElementById('paytable').hidden = true;
        document.getElementById('game-container').dataset.fastforward = 'false';
        this.buildTable();
        this.buildPaytable();
        this.updateUI();
    }

    handleEvent(event) {
        // See the matching comment in lottery.js's Kiosk: fast-forward drives the engine
        // directly and tracks its own totals, so reacting to every simulated spin's
        // events here too would mean a sound and a full re-render per spin.
        if (this.fastForwarding) {
            return;
        }
        switch (event.type) {
            case 'betPlaced':
                playSound(chipSound);
                break;
            case 'betsCleared':
                playSound(chipSound);
                break;
            case 'spinResolved':
                this.reportSpin(event);
                break;
        }
    }

    reportSpin(spin) {
        recordStats({
            spinsPlayed: 1,
            betsPlaced: spin.results.length,
            wagered: spin.wagered,
            won: spin.totalWon
        });

        const winners = spin.results.filter(r => r.won);
        if (spin.totalWon > 0) {
            setMessage(`${spin.pocket} ${spin.color}. You won ${formatMoney(spin.totalWon)}!`);
        } else {
            setMessage(`${spin.pocket} ${spin.color}. No winners this spin.`);
        }

        if (winners.some(r => BET_IS_BIG(r.bet))) {
            playSound(bigWinSound);
        } else if (spin.totalWon > 0) {
            playSound(winSound);
        } else {
            playSound(loseSound);
        }

        this.updateUI();
    }

    // ---- Bankroll ----

    setBankroll(amount) {
        if (this.fastForwarding) {
            return false;
        }
        const result = this.engine.setBalance(amount);
        if (!result.ok) {
            setMessage(result.reason === 'invalid'
                ? `Enter a whole-dollar amount of at least $${RouletteEngine.MIN_BET}.`
                : 'You can only set your starting balance before placing bets.');
            return false;
        }
        setMessage(`Starting balance set to ${formatMoney(amount)}.`);
        this.updateUI();
        return true;
    }

    // ---- Placing bets ----

    selectAmount(amount) {
        this.selectedAmount = amount;
        this.updateChips();
    }

    placeBet(type, selection) {
        if (this.fastForwarding) {
            return false;
        }
        const result = this.engine.placeBet(type, selection, this.selectedAmount);
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
        if (reason === 'toomany') return `You can place at most ${RouletteEngine.MAX_BETS_PER_SPIN} bets in one spin.`;
        if (reason === 'invalid') return 'That bet is not valid.';
        return 'Bets are locked once the wheel is spinning.';
    }

    clearBets() {
        if (this.fastForwarding) {
            return;
        }
        const result = this.engine.clearBets();
        if (!result.ok) {
            return;
        }
        setMessage('Bets cleared.');
        this.updateUI();
    }

    // ---- Spinning ----

    spin() {
        if (this.fastForwarding) {
            return;
        }
        const result = this.engine.spin();
        if (!result.ok) {
            setMessage(result.reason === 'nobets' ? 'Place at least one bet first.' : 'The wheel already spun.');
            return;
        }
        this.updateUI();
    }

    nextRound() {
        if (this.fastForwarding) {
            return;
        }
        if (this.engine.nextRound()) {
            setMessage('Place your bets for the next spin.');
            this.updateUI();
        }
    }

    restart() {
        if (this.fastForwarding) {
            return;
        }
        if (this.engine.restart()) {
            setMessage(`New game. You start again with ${formatMoney(this.engine.startingBalance)}.`);
            this.updateUI();
        }
    }

    // ---- Fast-forward: simulate many real, independent spins with the same bets ----

    canFastForward() {
        return !this.fastForwarding && this.engine.phase === 'betting' && this.engine.bets.length > 0;
    }

    runFastForward(spins) {
        if (!this.canFastForward()) {
            return;
        }
        if (!Number.isInteger(spins) || spins < 1 || spins > MAX_FASTFORWARD_SPINS) {
            setMessage(`Enter a number of spins from 1 to ${MAX_FASTFORWARD_SPINS.toLocaleString('en-US')}.`);
            return;
        }
        const pattern = this.engine.bets.map(bet => ({ type: bet.type, selection: bet.selection, amount: bet.amount }));
        this.engine.clearBets(); // refund the "preview" placement; the loop re-places it fresh each round

        this.fastForwarding = true;
        this.ff = {
            target: spins,
            pattern,
            spinsRun: 0,
            wagered: 0,
            won: 0,
            biggestWin: 0,
            stoppedEarly: false,
            outOfMoney: false
        };
        document.getElementById('game-container').dataset.fastforward = 'true';
        document.getElementById('fastforward-summary').hidden = true;
        this.updateFastForwardProgress();
        this.updateButtons();
        setTimeout(() => this.fastForwardChunk(), 0);
    }

    stopFastForward() {
        if (!this.fastForwarding || !this.ff) {
            return;
        }
        this.ff.stoppedEarly = true;
    }

    fastForwardChunk() {
        const ff = this.ff;
        const engine = this.engine;
        const chunkStart = Date.now();

        while (ff.spinsRun < ff.target && !ff.stoppedEarly) {
            let placedOk = true;
            for (const bet of ff.pattern) {
                const r = engine.placeBet(bet.type, bet.selection, bet.amount);
                if (!r.ok) {
                    placedOk = false;
                    break;
                }
            }
            if (!placedOk) {
                engine.clearBets();
                ff.outOfMoney = true;
                break;
            }
            const result = engine.spin();
            ff.spinsRun += 1;
            ff.wagered += result.spin.wagered;
            ff.won += result.spin.totalWon;
            if (result.spin.totalWon > ff.biggestWin) {
                ff.biggestWin = result.spin.totalWon;
            }
            engine.nextRound();

            if (Date.now() - chunkStart > FASTFORWARD_CHUNK_BUDGET_MS) {
                break;
            }
        }

        this.updateFastForwardProgress();

        if (ff.spinsRun >= ff.target || ff.stoppedEarly || ff.outOfMoney) {
            this.finishFastForward();
        } else {
            setTimeout(() => this.fastForwardChunk(), 0);
        }
    }

    updateFastForwardProgress() {
        const ff = this.ff;
        const pct = ff.target > 0 ? Math.round((ff.spinsRun / ff.target) * 100) : 0;
        document.getElementById('ff-progress').setAttribute('aria-valuenow', String(pct));
        document.getElementById('ff-progress-fill').style.width = `${pct}%`;
        setText(document.getElementById('ff-progress-label'),
            `Simulating... ${ff.spinsRun.toLocaleString('en-US')} / ${ff.target.toLocaleString('en-US')} spins`);
    }

    finishFastForward() {
        const ff = this.ff;
        this.fastForwarding = false;
        document.getElementById('game-container').dataset.fastforward = 'false';

        recordStats({ spinsPlayed: ff.spinsRun, betsPlaced: ff.spinsRun * ff.pattern.length, wagered: ff.wagered, won: ff.won, biggestWin: ff.biggestWin });

        const net = ff.won - ff.wagered;
        const summary = document.getElementById('fastforward-summary');
        summary.hidden = false;
        clearChildren(summary);
        const heading = document.createElement('h3');
        heading.textContent = ff.stoppedEarly ? 'Stopped early' : (ff.outOfMoney ? 'Ran out of money' : 'Simulation complete');
        const lines = document.createElement('div');
        lines.innerHTML =
            `Spins run: ${ff.spinsRun.toLocaleString('en-US')}<br>` +
            `Bets placed: ${(ff.spinsRun * ff.pattern.length).toLocaleString('en-US')}<br>` +
            `Wagered: ${formatMoney(ff.wagered)}<br>` +
            `Won: ${formatMoney(ff.won)}<br>` +
            `Net: ${formatMoney(net)}<br>` +
            `Biggest single-spin win: ${formatMoney(ff.biggestWin)}`;
        summary.appendChild(heading);
        summary.appendChild(lines);

        setMessage(`Simulated ${ff.spinsRun.toLocaleString('en-US')} spins. Net ${formatMoney(net)}.`);
        this.updateUI();
    }

    // ---- Rendering ----

    buildTable() {
        const zeroRow = document.getElementById('zero-row');
        ['0', '00'].forEach(pocket => zeroRow.appendChild(this.buildBetSpot('straight', pocket, pocket)));

        const grid = document.getElementById('numbers-grid');
        for (let n = 1; n <= 36; n++) {
            grid.appendChild(this.buildBetSpot('straight', String(n), String(n)));
        }

        const outside = document.getElementById('outside-bets');
        OUTSIDE_BETS.forEach(({ type, label }) => outside.appendChild(this.buildBetSpot(type, null, label)));
    }

    buildBetSpot(type, selection, label) {
        const spot = document.createElement('button');
        spot.type = 'button';
        const color = type === 'straight' ? colorOf(selection) : null;
        spot.className = `bet-spot${color ? ` ${color}` : ''}`;
        spot.dataset.type = type;
        if (selection !== null) {
            spot.dataset.selection = selection;
        }
        const text = document.createElement('span');
        text.className = 'bet-spot-label';
        text.textContent = label;
        const badge = document.createElement('span');
        badge.className = 'bet-spot-badge';
        spot.appendChild(text);
        spot.appendChild(badge);
        spot.parts = { badge };
        spot.onclick = () => this.placeBet(type, selection);
        return spot;
    }

    spotsFor(type, selection) {
        const selector = selection === null
            ? `.bet-spot[data-type="${type}"]:not([data-selection])`
            : `.bet-spot[data-type="${type}"][data-selection="${selection}"]`;
        return Array.from(document.querySelectorAll(selector));
    }

    updateUI() {
        const engine = this.engine;
        document.getElementById('game-container').dataset.phase = engine.phase;
        document.getElementById('balance').textContent = `Balance: ${formatMoney(engine.balance)}`;
        document.getElementById('wagered').textContent = `Wagered: ${formatMoney(engine.totalWagered())}`;

        this.renderResult();
        this.renderSpots();
        this.renderBetsSummary();
        this.updateChips();
        this.updateButtons();
        this.buildPaytable();
    }

    renderResult() {
        const container = document.getElementById('result-pocket');
        const spin = this.engine.phase === 'results' ? this.engine.lastSpin : null;
        if (!spin) {
            clearChildren(container);
            return;
        }
        if (container.children.length !== 1 || container.children[0].dataset.key !== spin.pocket) {
            clearChildren(container);
            const ball = document.createElement('div');
            ball.className = `pocket-ball ${spin.color}`;
            ball.textContent = spin.pocket;
            ball.dataset.key = spin.pocket;
            container.appendChild(ball);
        }
    }

    // Shows each bet spot's cumulative wager this round, and (once settled) whether it won.
    renderSpots() {
        const engine = this.engine;
        const totals = new Map(); // "type:selection" -> amount
        engine.bets.forEach(bet => {
            const key = `${bet.type}:${bet.selection ?? ''}`;
            totals.set(key, (totals.get(key) || 0) + bet.amount);
        });
        const results = engine.phase === 'results' ? engine.lastSpin.results : null;
        const outcomeFor = (type, selection) => {
            if (!results) {
                return null;
            }
            const match = results.find(r => r.bet.type === type && r.bet.selection === selection);
            return match ? match.won : null;
        };

        document.querySelectorAll('.bet-spot').forEach(spot => {
            const type = spot.dataset.type;
            const selection = spot.dataset.selection ?? null;
            const key = `${type}:${selection ?? ''}`;
            const amount = totals.get(key) || 0;
            setText(spot.parts.badge, amount > 0 ? `$${amount}` : '');
            spot.classList.toggle('has-bet', amount > 0);
            const won = outcomeFor(type, selection);
            spot.classList.toggle('bet-won', won === true);
            spot.classList.toggle('bet-lost', won === false);
        });
    }

    renderBetsSummary() {
        const engine = this.engine;
        const el = document.getElementById('bets-summary');
        if (engine.bets.length === 0) {
            setText(el, '');
            return;
        }
        const noun = engine.bets.length === 1 ? 'bet' : 'bets';
        setText(el, engine.phase === 'betting'
            ? `${engine.bets.length} ${noun} placed, ${formatMoney(engine.totalWagered())} wagered.`
            : `${engine.bets.length} ${noun} played.`);
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
        document.getElementById('clear-bets').disabled = ff || !(engine.phase === 'betting' && engine.bets.length > 0);
        document.getElementById('custom-amount').disabled = ff;
        document.getElementById('set-custom-amount').disabled = ff;
        document.getElementById('spin-button').disabled = ff || !engine.canSpin();
        document.getElementById('restart').style.display = !ff && engine.isBroke() ? 'inline-block' : 'none';
        document.getElementById('bankroll-amount').disabled = ff || !engine.canSetBalance();
        document.getElementById('set-bankroll').disabled = ff || !engine.canSetBalance();
        document.getElementById('ff-spins').disabled = !this.canFastForward();
        document.getElementById('fast-forward-button').disabled = !this.canFastForward();
        document.querySelectorAll('.bet-spot').forEach(spot => {
            spot.disabled = ff || engine.phase !== 'betting';
        });
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
        const parts = [document.createElement('td'), document.createElement('td'), document.createElement('td'), document.createElement('td')];
        parts.forEach(cell => row.appendChild(cell));
        row.parts = parts;
        return row;
    }

    updatePaytableRow(row, tier) {
        setText(row.parts[0], tier.label);
        setText(row.parts[1], `${tier.payout}:1`);
        setText(row.parts[2], tier.oddsLabel);
        setText(row.parts[3], `${tier.houseEdgePct.toFixed(2)}%`);
    }

    togglePaytable() {
        const panel = document.getElementById('paytable');
        const button = document.getElementById('toggle-paytable');
        panel.hidden = !panel.hidden;
        button.setAttribute('aria-pressed', String(!panel.hidden));
        playSound(clickSound);
    }
}

// A "big win" worth the fanfare sound: a straight-up hit, which pays 35:1.
function BET_IS_BIG(bet) {
    return bet.type === 'straight';
}

// ---- Wiring ----

const engine = new RouletteEngine();
const table = new RouletteTable(engine);

document.getElementById('mute').addEventListener('click', toggleMute);
updateMuteButton();
updateStatsDisplay();

document.getElementById('toggle-paytable').addEventListener('click', () => table.togglePaytable());
document.getElementById('clear-bets').addEventListener('click', () => table.clearBets());
document.getElementById('spin-button').addEventListener('click', () => table.spin());
document.getElementById('next-round').addEventListener('click', () => table.nextRound());
document.getElementById('restart').addEventListener('click', () => table.restart());

const bankrollInput = document.getElementById('bankroll-amount');
function applyBankroll() {
    const value = Number(bankrollInput.value);
    if (table.setBankroll(value)) {
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
    if (Number.isInteger(value) && value >= RouletteEngine.MIN_BET) {
        table.selectAmount(value);
        customAmountInput.value = '';
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
    table.runFastForward(Number(document.getElementById('ff-spins').value));
});
document.getElementById('ff-stop-button').addEventListener('click', () => table.stopFastForward());

document.addEventListener('keydown', event => {
    if (event.target && event.target.tagName === 'INPUT') {
        return;
    }
    if (engine.phase === 'betting' && event.key === 'Enter' && engine.canSpin()) {
        table.spin();
    } else if (engine.phase === 'results' && event.key === 'Enter') {
        table.nextRound();
    }
});
