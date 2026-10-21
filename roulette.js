'use strict';

// The page for Matt's Roulette: the wheel, the betting table, chips, sounds and
// statistics. All of the rules live in roulette-engine.js.

// ---- Sounds (shared with the other games) ----

const chipSound = new Audio('sounds/chip.wav');
const spinSound = new Audio('sounds/card.wav');
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

// The ball's roll is synthesized rather than a recording so it can last exactly as long
// as the wheel turns: a whir that slows and fades, then the ball rattling over the frets
// with longer and longer gaps, then the clack of it dropping into the pocket.
let audioContext = null;

function getAudioContext() {
    if (!audioContext) {
        const Context = typeof AudioContext === 'function' ? AudioContext
            : (typeof webkitAudioContext === 'function' ? webkitAudioContext : null);
        if (!Context) {
            return null;
        }
        audioContext = new Context();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
    return audioContext;
}

function noiseBuffer(ctx, seconds) {
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
    }
    return buffer;
}

// One short, bright knock - the ball hitting a fret or the pocket wall.
function scheduleTick(ctx, buffer, when, volume, pitch) {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = pitch;
    filter.Q.value = 6;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(volume, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(when, Math.random() * 0.5, 0.06);
}

function playBallRoll(durationMs) {
    if (soundMuted) {
        return;
    }
    const ctx = getAudioContext();
    if (!ctx) {
        playSound(spinSound);
        return;
    }
    const seconds = durationMs / 1000;
    const start = ctx.currentTime + 0.02;
    const end = start + seconds;
    const buffer = noiseBuffer(ctx, Math.max(1, seconds));

    // The whir: filtered noise whose pitch falls as the ball slows down.
    if (seconds > 1) {
        const roll = ctx.createBufferSource();
        roll.buffer = buffer;
        roll.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.Q.value = 1.2;
        filter.frequency.setValueAtTime(1400, start);
        filter.frequency.exponentialRampToValueAtTime(380, start + seconds * 0.7);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.16, start + 0.25);
        gain.gain.setValueAtTime(0.16, start + seconds * 0.35);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds * 0.78);
        roll.connect(filter).connect(gain).connect(ctx.destination);
        roll.start(start);
        roll.stop(start + seconds * 0.8);
    }

    // The rattle: ticks over the last part of the spin, spreading out as the ball settles.
    let t = start + seconds * (seconds > 1 ? 0.5 : 0);
    let gap = 0.045;
    while (t < end - 0.18) {
        scheduleTick(ctx, buffer, t, 0.35 + Math.random() * 0.25, 2600 + Math.random() * 1400);
        t += gap * (0.7 + Math.random() * 0.6);
        gap *= 1.16;
    }
    // The drop into the pocket: one louder, lower clack.
    scheduleTick(ctx, buffer, end - 0.08, 0.9, 1500);
}

// ---- Statistics: lifetime persists; session resets on every load ----

function freshPageStats() {
    return { spinsPlayed: 0, betsPlaced: 0, totalWagered: 0, totalWon: 0, biggestWin: 0 };
}

function loadStats() {
    const fresh = freshPageStats();
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
let sessionStats = freshPageStats();

// `biggestWin` defaults to `won`, right for a single spin. A fast-forward run passes its
// own largest single spin explicitly - not the run's total.
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

function formatSigned(amount) {
    return amount > 0 ? `+${formatMoney(amount)}` : formatMoney(amount);
}

function updateStatsDisplay() {
    const line = (label, stats) =>
        `${label}: ${stats.spinsPlayed} spin${stats.spinsPlayed === 1 ? '' : 's'}, wagered ${formatMoney(stats.totalWagered)}, won ${formatMoney(stats.totalWon)}, net ${formatMoney(stats.totalWon - stats.totalWagered)}`;
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

// ---- Table layout ----
//
// Everything on the table is placed on one logical grid, laid out like a real table:
//   column 1: 0 and 00;  columns 2-13: the twelve columns of numbers;  column 14: "2 to 1"
//   rows 1-6: the three rows of numbers (each number spans two half-rows, so 0 and 00
//             can each cover half the height, and a bet can sit exactly on a line);
//   row 7: dozens;  row 8: the even-money bets.
// Phones get the same grid turned on its side (see place()), so every split, corner and
// street still sits on the right line without a second layout to maintain.

const numberRow = n => (n % 3 === 0 ? 1 : n % 3 === 2 ? 3 : 5); // top row is 3, 6 ... 36
const numberCol = n => Math.ceil(n / 3) + 1;

function placementFor(bet) {
    const nums = bet.numbers.filter(p => p !== '0' && p !== '00').map(Number);
    switch (bet.kind) {
        case 'straight':
            if (bet.numbers[0] === '00') return { r: 1, rs: 3, c: 1, cs: 1 };
            if (bet.numbers[0] === '0') return { r: 4, rs: 3, c: 1, cs: 1 };
            return { r: numberRow(nums[0]), rs: 2, c: numberCol(nums[0]), cs: 1 };
        case 'split': {
            if (bet.key === 'split:0-00') return { r: 3, rs: 2, c: 1, cs: 1 };
            if (bet.key === 'split:0-1') return { r: 5, rs: 2, c: 1, cs: 2 };
            if (bet.key === 'split:00-3') return { r: 1, rs: 2, c: 1, cs: 2 };
            const [a, b] = nums;
            if (b === a + 1) return { r: numberRow(b) + 1, rs: 2, c: numberCol(a), cs: 1 }; // on the line between them
            return { r: numberRow(a), rs: 2, c: numberCol(a), cs: 2 };
        }
        case 'corner':
            return { r: numberRow(nums[0] + 1) + 1, rs: 2, c: numberCol(nums[0]), cs: 2 };
        case 'street':
            return { r: 6, rs: 2, c: numberCol(nums[0]), cs: 1 }; // on the outer edge of the row
        case 'sixline':
            return { r: 6, rs: 2, c: numberCol(nums[0]), cs: 2 };
        case 'trio':
            return bet.key === 'trio:0-1-2' ? { r: 4, rs: 2, c: 1, cs: 2 } : { r: 2, rs: 2, c: 1, cs: 2 };
        case 'basket':
            return { r: 6, rs: 2, c: 1, cs: 2 };
        case 'column':
            return { r: { column3: 1, column2: 3, column1: 5 }[bet.key], rs: 2, c: 14, cs: 1 };
        case 'dozen':
            return { r: 7, rs: 1, c: { dozen1: 2, dozen2: 6, dozen3: 10 }[bet.key], cs: 4 };
        default: // even money
            return { r: 8, rs: 1, c: { low: 2, even: 4, red: 6, black: 8, odd: 10, high: 12 }[bet.key], cs: 2 };
    }
}

function place(element, { r, rs, c, cs }) {
    element.style.setProperty('--dr', r);
    element.style.setProperty('--drs', rs);
    element.style.setProperty('--dc', c);
    element.style.setProperty('--dcs', cs);
    // Sideways for phones: logical columns run down the page, logical rows across, flipped
    // so the even-money and dozen bets end up on the left next to the 1, 4, 7 ... column.
    element.style.setProperty('--mr', c);
    element.style.setProperty('--mrs', cs);
    element.style.setProperty('--mc', 9 - (r + rs - 1));
    element.style.setProperty('--mcs', rs);
}

const OUTSIDE_LABELS = {
    dozen1: '1st 12', dozen2: '2nd 12', dozen3: '3rd 12',
    column1: '2 to 1', column2: '2 to 1', column3: '2 to 1',
    low: '1-18', even: 'EVEN', red: '', black: '', odd: 'ODD', high: '19-36'
};

const CHIP_VALUES = [1, 5, 25, 100, 500];
const MAX_FASTFORWARD_SPINS = 100_000;
const FASTFORWARD_CHUNK_BUDGET_MS = 20;
const reduceMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPIN_MS = reduceMotion ? 400 : 4300;
const POCKET_ANGLE = 360 / RouletteEngine.WHEEL_ORDER.length;
const COLOR_NAMES = { red: 'Red', black: 'Black', green: 'Green' };

function chipTier(amount) {
    return CHIP_VALUES.filter(v => v <= amount).pop() || CHIP_VALUES[0];
}

// ---- The wheel ----

function polar(radius, degrees) {
    const rad = (degrees * Math.PI) / 180;
    return `${(radius * Math.sin(rad)).toFixed(2)} ${(-radius * Math.cos(rad)).toFixed(2)}`;
}

// The wheel is a static SVG: pocket i is centred i * POCKET_ANGLE clockwise from the top,
// in the real American order. Spinning just rotates it.
function wheelSvg() {
    const fills = { red: '#c4202e', black: '#141414', green: '#14894a' };
    const outer = 96;
    const inner = 60;
    const parts = RouletteEngine.WHEEL_ORDER.map((pocket, i) => {
        const a0 = (i - 0.5) * POCKET_ANGLE;
        const a1 = (i + 0.5) * POCKET_ANGLE;
        const wedge = `<path d="M ${polar(inner, a0)} L ${polar(outer, a0)} A ${outer} ${outer} 0 0 1 ${polar(outer, a1)} L ${polar(inner, a1)} A ${inner} ${inner} 0 0 0 ${polar(inner, a0)} Z" fill="${fills[colorOf(pocket)]}" stroke="#d9b44a" stroke-width="0.6"/>`;
        const label = `<text transform="rotate(${(i * POCKET_ANGLE).toFixed(3)}) translate(0 -84)" text-anchor="middle" dominant-baseline="middle" font-size="7.5" font-weight="700" fill="#fff">${pocket}</text>`;
        return wedge + label;
    }).join('');
    return `<svg viewBox="-100 -100 200 200" role="presentation">` +
        `<circle r="99" fill="#3b2410" stroke="#d9b44a" stroke-width="2"/>` +
        parts +
        `<circle r="${inner}" fill="#24150a" stroke="#d9b44a" stroke-width="1.2"/>` +
        `<circle r="44" fill="none" stroke="rgba(217,180,74,0.35)" stroke-width="1"/>` +
        `</svg>`;
}

class RouletteTable {
    constructor(engine) {
        this.engine = engine;
        this.selectedAmount = 5;
        this.spinning = false;
        this.fastForwarding = false;
        this.wheelAngle = 0;
        this.locations = new Map();   // bet key -> its spot on the table
        this.numberCells = new Map(); // pocket -> its cell
        engine.subscribe(event => this.handleEvent(event));
        document.getElementById('paytable').hidden = true;
        document.getElementById('game-container').dataset.fastforward = 'false';
        document.getElementById('wheel-rotor').innerHTML = wheelSvg();
        this.buildTable();
        this.buildPaytable();
        this.updateUI();
    }

    handleEvent(event) {
        // Fast-forward drives the engine directly and tracks its own totals; a spin's
        // result is reported once the wheel stops (see finishSpin), not when it is decided.
        if (this.fastForwarding) {
            return;
        }
        if (event.type === 'betPlaced' || event.type === 'betRemoved' || event.type === 'betsCleared') {
            playSound(chipSound);
        }
    }

    // ---- Building the table ----

    buildTable() {
        const tableEl = document.getElementById('betting-table');
        // Cells first, then the line spots, so the line spots sit on top of the cells.
        const cells = [];
        const lines = [];
        for (const bet of RouletteEngine.BETS.values()) {
            (bet.kind === 'straight' || ['dozen', 'column', 'evenmoney'].includes(bet.kind) ? cells : lines).push(bet);
        }
        cells.forEach(bet => tableEl.appendChild(this.buildCell(bet)));
        lines.forEach(bet => tableEl.appendChild(this.buildLineSpot(bet)));
    }

    buildCell(bet) {
        const el = document.createElement('button');
        el.type = 'button';
        const pocket = bet.kind === 'straight' ? bet.numbers[0] : null;
        el.className = `bet-location cell ${pocket ? `number ${colorOf(pocket)}` : `outside outside-${bet.key}`}`;
        const label = document.createElement('span');
        label.className = 'cell-label';
        label.textContent = pocket || OUTSIDE_LABELS[bet.key];
        el.appendChild(label);
        if (pocket) {
            this.numberCells.set(pocket, el);
        }
        return this.finishLocation(el, bet);
    }

    buildLineSpot(bet) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `bet-location line-spot line-${bet.kind}`;
        el.tabIndex = -1; // dozens of these; mouse and touch only
        return this.finishLocation(el, bet);
    }

    finishLocation(el, bet) {
        el.dataset.key = bet.key;
        const description = `${bet.label}, pays ${bet.payout} to 1`;
        el.title = description;
        el.setAttribute('aria-label', description);
        const chip = document.createElement('span');
        chip.className = 'table-chip';
        el.appendChild(chip);
        el.parts = { chip };
        place(el, placementFor(bet));
        el.onclick = () => this.placeBet(bet.key);
        el.oncontextmenu = event => {
            event.preventDefault();
            this.removeBet(bet.key);
        };
        el.onmouseenter = () => this.preview(bet.key);
        el.onmouseleave = () => this.preview(null);
        this.locations.set(bet.key, el);
        return el;
    }

    // Lights up the numbers a spot covers while hovering it.
    preview(key) {
        const covered = key ? new Set(RouletteEngine.BETS.get(key).numbers) : new Set();
        this.numberCells.forEach((cell, pocket) => cell.classList.toggle('covered', covered.has(pocket)));
    }

    // ---- Betting ----

    selectAmount(amount) {
        this.selectedAmount = amount;
        this.updateChips();
    }

    canBet() {
        return !this.fastForwarding && !this.spinning && this.engine.phase === 'betting';
    }

    placeBet(key) {
        if (!this.canBet()) {
            return false;
        }
        const result = this.engine.placeBet(key, this.selectedAmount);
        if (!result.ok) {
            setMessage(result.reason === 'insufficient'
                ? `Not enough balance for a ${formatMoney(this.selectedAmount)} chip.`
                : 'That bet is not available.');
            return false;
        }
        document.getElementById('fastforward-summary').hidden = true;
        setMessage(`${RouletteEngine.BETS.get(key).label}: ${formatMoney(this.engine.bets[key])}`);
        this.updateUI();
        return true;
    }

    removeBet(key) {
        if (!this.canBet()) {
            return false;
        }
        if (this.engine.removeBet(key).ok) {
            setMessage(`Took back the bet on ${RouletteEngine.BETS.get(key).label}.`);
            this.updateUI();
            return true;
        }
        return false;
    }

    undo() {
        if (this.canBet() && this.engine.undo().ok) {
            setMessage('Took back the last chip.');
            this.updateUI();
        }
    }

    clearBets() {
        if (this.canBet() && this.engine.clearBets().ok) {
            setMessage('Table cleared.');
            this.updateUI();
        }
    }

    doubleBets() {
        if (!this.canBet()) {
            return;
        }
        setMessage(this.engine.doubleBets().ok ? 'Every bet doubled.' : 'Not enough balance to double.');
        this.updateUI();
    }

    rebet() {
        if (!this.canBet()) {
            return false;
        }
        const placed = this.engine.rebet().ok;
        setMessage(placed ? 'Last spin\'s bets are back on the table.' : 'Not enough balance to repeat those bets.');
        this.updateUI();
        return placed;
    }

    setBankroll(dollars) {
        if (!this.canBet()) {
            return false;
        }
        const result = this.engine.setBalance(dollars);
        if (!result.ok) {
            setMessage(result.reason === 'invalid'
                ? 'Enter a whole-dollar amount of at least $1.'
                : 'You can only set your starting balance with an empty table.');
            return false;
        }
        setMessage(`Starting balance set to ${formatMoney(dollars)}.`);
        this.updateUI();
        return true;
    }

    // ---- Spinning ----

    // `forced` fixes the result - only ever passed by tests.
    spin(forced = null) {
        if (!this.canBet()) {
            return false;
        }
        const result = this.engine.spin(forced);
        if (!result.ok) {
            setMessage('Place a bet first.');
            return false;
        }
        this.spinning = true;
        playBallRoll(SPIN_MS);
        this.rotateWheelTo(result.spin.pocket);
        setMessage('No more bets.');
        this.updateUI();
        setTimeout(() => this.finishSpin(), SPIN_MS);
        return true;
    }

    // Turns the wheel at least five full times and lands the winning pocket under the
    // pointer at the top, a little off-centre so it doesn't look mechanical.
    rotateWheelTo(pocket) {
        const index = RouletteEngine.WHEEL_ORDER.indexOf(pocket);
        const target = ((-index * POCKET_ANGLE) % 360 + 360) % 360;
        let angle = Math.floor(this.wheelAngle / 360) * 360 + target;
        while (angle < this.wheelAngle + 5 * 360) {
            angle += 360;
        }
        angle += (Math.random() - 0.5) * POCKET_ANGLE * 0.5;
        this.wheelAngle = angle;
        document.getElementById('wheel-rotor').style.transform = `rotate(${angle.toFixed(2)}deg)`;
    }

    finishSpin() {
        this.spinning = false;
        const spin = this.engine.lastSpin;
        recordStats({ spinsPlayed: 1, betsPlaced: spin.results.length, wagered: spin.wagered, won: spin.totalWon });

        const winners = spin.results.filter(r => r.won);
        const net = spin.totalWon - spin.wagered;
        if (winners.length === 0) {
            setMessage(`No winning bets. ${formatSigned(net)}.`);
        } else {
            const names = winners.slice(0, 3).map(r => r.label).join(', ') + (winners.length > 3 ? ` and ${winners.length - 3} more` : '');
            setMessage(`Winning: ${names}. Paid ${formatMoney(spin.totalWon)}, net ${formatSigned(net)}.`);
        }
        if (winners.some(r => r.kind === 'straight')) {
            playSound(bigWinSound);
        } else if (net > 0) {
            playSound(winSound);
        } else {
            playSound(loseSound);
        }
        this.updateUI();
    }

    nextRound() {
        if (this.fastForwarding || this.spinning || !this.engine.nextRound()) {
            return false;
        }
        setMessage('Place your bets.');
        this.updateUI();
        return true;
    }

    canRepeat() {
        const total = Object.values(this.engine.lastRoundBets).reduce((sum, a) => sum + a, 0);
        return !this.fastForwarding && !this.spinning && this.engine.phase === 'results' && total > 0 && this.engine.balance >= total;
    }

    sameBets() {
        if (!this.canRepeat()) {
            return false;
        }
        this.nextRound();
        return this.rebet();
    }

    sameBetsAndSpin() {
        return this.sameBets() && this.spin();
    }

    restart() {
        if (this.fastForwarding || this.spinning || !this.engine.restart()) {
            return;
        }
        setMessage(`New game. You start again with ${formatMoney(this.engine.startingBalance)}.`);
        this.updateUI();
    }

    // ---- Fast-forward: many real spins with the bets on the table ----

    canFastForward() {
        return this.canBet() && this.engine.totalWagered() > 0;
    }

    runFastForward(spins) {
        if (!this.canFastForward()) {
            return;
        }
        if (!Number.isInteger(spins) || spins < 1 || spins > MAX_FASTFORWARD_SPINS) {
            setMessage(`Enter a number of spins from 1 to ${MAX_FASTFORWARD_SPINS.toLocaleString('en-US')}.`);
            return;
        }
        const pattern = { ...this.engine.bets };
        this.engine.clearBets(); // refund the preview; each simulated spin places it fresh

        this.fastForwarding = true;
        this.ff = { target: spins, pattern, spinsRun: 0, wagered: 0, won: 0, biggestWin: 0, hits: 0, stoppedEarly: false, outOfMoney: false };
        document.getElementById('game-container').dataset.fastforward = 'true';
        document.getElementById('fastforward-summary').hidden = true;
        this.updateFastForwardProgress();
        this.updateUI();
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
        const needed = Object.values(ff.pattern).reduce((sum, a) => sum + a, 0);
        const chunkStart = Date.now();

        while (ff.spinsRun < ff.target && !ff.stoppedEarly) {
            if (engine.balance < needed) {
                ff.outOfMoney = true;
                break;
            }
            for (const [key, amount] of Object.entries(ff.pattern)) {
                engine.placeBet(key, amount);
            }
            const { spin } = engine.spin();
            ff.spinsRun += 1;
            ff.wagered += spin.wagered;
            ff.won += spin.totalWon;
            if (spin.totalWon > 0) ff.hits += 1;
            if (spin.totalWon > ff.biggestWin) ff.biggestWin = spin.totalWon;
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
        recordStats({ spinsPlayed: ff.spinsRun, betsPlaced: ff.spinsRun * Object.keys(ff.pattern).length, wagered: ff.wagered, won: ff.won, biggestWin: ff.biggestWin });

        const net = ff.won - ff.wagered;
        const summary = document.getElementById('fastforward-summary');
        summary.hidden = false;
        clearChildren(summary);
        const heading = document.createElement('h3');
        heading.textContent = ff.stoppedEarly ? 'Stopped early' : (ff.outOfMoney ? 'Ran out of money' : 'Simulation complete');
        const lines = document.createElement('div');
        lines.innerHTML =
            `Spins: ${ff.spinsRun.toLocaleString('en-US')} &middot; something paid on ${ff.spinsRun ? (ff.hits / ff.spinsRun * 100).toFixed(1) : 0}% of them<br>` +
            `Wagered ${formatMoney(ff.wagered)} &middot; paid back ${formatMoney(ff.won)} &middot; net ${formatSigned(net)}` +
            (ff.wagered > 0 ? ` (${(net / ff.wagered * 100).toFixed(2)}% of what you bet &mdash; the house edge on these bets is ${this.patternEdge(ff.pattern).toFixed(2)}%)` : '') + '<br>' +
            `Biggest single spin: ${formatMoney(ff.biggestWin)}`;
        summary.appendChild(heading);
        summary.appendChild(lines);

        setMessage(`Simulated ${ff.spinsRun.toLocaleString('en-US')} spins. Net ${formatSigned(net)}.`);
        this.updateUI();
    }

    // The stake-weighted house edge of a set of bets.
    patternEdge(pattern) {
        let total = 0;
        let weighted = 0;
        for (const [key, amount] of Object.entries(pattern)) {
            total += amount;
            weighted += amount * houseEdgePct(RouletteEngine.BETS.get(key));
        }
        return total > 0 ? weighted / total : 0;
    }

    // ---- Rendering ----

    displayPhase() {
        return this.spinning ? 'spinning' : this.engine.phase;
    }

    updateUI() {
        const engine = this.engine;
        document.getElementById('game-container').dataset.phase = this.displayPhase();
        document.getElementById('balance').textContent = `Balance: ${formatMoney(engine.balance)}`;
        // Once the ball has landed the bets are settled, so the pill says what was bet rather
        // than claiming the chips still on show are at risk.
        const settled = !this.spinning && engine.phase === 'results';
        const onTable = this.spinning || settled ? (engine.lastSpin ? engine.lastSpin.wagered : 0) : engine.totalWagered();
        document.getElementById('wagered').textContent = `${settled ? 'Bet this spin' : 'On the table'}: ${formatMoney(onTable)}`;
        this.renderTable();
        this.renderResult();
        this.renderHistory();
        this.updateChips();
        this.updateButtons();
    }

    renderTable() {
        const engine = this.engine;
        const settled = engine.phase === 'results' && !this.spinning ? engine.lastSpin : null;
        const outcomes = new Map(settled ? settled.results.map(r => [r.key, r]) : []);
        const amounts = settled ? Object.fromEntries(settled.results.map(r => [r.key, r.amount])) : (engine.phase === 'results' ? engine.lastRoundBets : engine.bets);
        const locked = !this.canBet();

        this.locations.forEach((el, key) => {
            const amount = amounts[key] || 0;
            const chip = el.parts.chip;
            setText(chip, amount > 0 ? formatMoney(amount) : '');
            chip.className = amount > 0 ? `table-chip chip-${chipTier(amount)}` : 'table-chip';
            el.classList.toggle('has-bet', amount > 0);
            const outcome = outcomes.get(key);
            el.classList.toggle('bet-won', !!outcome && outcome.won);
            el.classList.toggle('bet-lost', !!outcome && !outcome.won);
            el.disabled = locked;
        });
        this.numberCells.forEach((cell, pocket) => cell.classList.toggle('winning', !!settled && settled.pocket === pocket));
    }

    renderResult() {
        const el = document.getElementById('result-number');
        const spin = this.engine.lastSpin;
        if (this.spinning) {
            el.className = 'spinning';
            setText(el, '');
            return;
        }
        if (this.engine.phase !== 'results' || !spin) {
            el.className = '';
            setText(el, '');
            return;
        }
        el.className = `pocket-${spin.color}`;
        setText(el, `${spin.pocket} ${COLOR_NAMES[spin.color]}`);
    }

    renderHistory() {
        // While the wheel is still turning, don't give the result away in the history.
        const history = this.spinning ? this.engine.history.slice(0, -1) : this.engine.history;
        const recent = [...history].reverse();
        syncChildren(document.getElementById('history'), recent,
            (pocket, index) => `${index}:${pocket}`,
            pocket => {
                const dot = document.createElement('span');
                dot.className = `history-pocket pocket-${colorOf(pocket)}`;
                dot.textContent = pocket;
                return dot;
            });
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
        chip.setAttribute('aria-label', `Use $${value} chips`);
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
        const canBet = this.canBet();
        document.getElementById('undo-button').disabled = !canBet || engine.placements.length === 0;
        document.getElementById('clear-bets').disabled = !canBet || engine.totalWagered() === 0;
        document.getElementById('double-button').disabled = !canBet || !engine.canDouble();
        document.getElementById('rebet-button').disabled = !canBet || !engine.canRebet();
        document.getElementById('spin-button').disabled = !canBet || !engine.canSpin();
        document.getElementById('custom-amount').disabled = !canBet;
        document.getElementById('set-custom-amount').disabled = !canBet;
        document.getElementById('bankroll-amount').disabled = !canBet || !engine.canSetBalance();
        document.getElementById('set-bankroll').disabled = !canBet || !engine.canSetBalance();
        document.getElementById('ff-spins').disabled = !this.canFastForward();
        document.getElementById('fast-forward-button').disabled = !this.canFastForward();
        document.getElementById('same-bets').disabled = !this.canRepeat();
        document.getElementById('same-bets-spin').disabled = !this.canRepeat();
        document.getElementById('restart').style.display = !this.fastForwarding && !this.spinning && engine.isBroke() ? 'inline-block' : 'none';
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
                setText(tr.parts[1], `${row.payout}:1`);
                setText(tr.parts[2], `${(row.winProbability * 100).toFixed(2)}%`);
                setText(tr.parts[3], `${row.houseEdgePct.toFixed(2)}%`);
                tr.classList.toggle('worse-edge', row.houseEdgePct > 6);
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

const engine = new RouletteEngine();
const table = new RouletteTable(engine);

document.getElementById('mute').addEventListener('click', toggleMute);
updateMuteButton();
updateStatsDisplay();
setMessage('Pick a chip, then place your bets.');

const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);
on('toggle-paytable', () => table.togglePaytable());
on('undo-button', () => table.undo());
on('clear-bets', () => table.clearBets());
on('double-button', () => table.doubleBets());
on('rebet-button', () => table.rebet());
on('spin-button', () => table.spin());
on('next-round', () => table.nextRound());
on('same-bets', () => table.sameBets());
on('same-bets-spin', () => table.sameBetsAndSpin());
on('restart', () => table.restart());
on('ff-stop-button', () => table.stopFastForward());
on('fast-forward-button', () => table.runFastForward(Number(document.getElementById('ff-spins').value)));

const bankrollInput = document.getElementById('bankroll-amount');
function applyBankroll() {
    if (table.setBankroll(Number(bankrollInput.value))) {
        bankrollInput.value = '';
    }
}
on('set-bankroll', applyBankroll);
bankrollInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') applyBankroll();
});

const customAmountInput = document.getElementById('custom-amount');
function applyCustomAmount() {
    const value = Number(customAmountInput.value);
    if (Number.isInteger(value) && value >= RouletteEngine.MIN_BET) {
        table.selectAmount(value);
        customAmountInput.value = '';
        setMessage(`Using ${formatMoney(value)} chips.`);
    } else {
        setMessage('Enter a whole-dollar chip amount, at least $1.');
    }
}
on('set-custom-amount', applyCustomAmount);
customAmountInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') applyCustomAmount();
});

document.addEventListener('keydown', event => {
    // Keys typed into a field, or pressed on a focused button, spot or chip, belong to that
    // control: Enter there must not also spin or start a new round.
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'BUTTON' ||
        (target.getAttribute && target.getAttribute('role') === 'button'))) {
        return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        table.undo();
    } else if (event.key === 'Enter') {
        if (engine.phase === 'betting') {
            table.spin();
        } else {
            table.nextRound();
        }
    }
});
