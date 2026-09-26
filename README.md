# Advanced Blackjack Game

## ▶️ [Play Now](https://mattgrilli.github.io/blackjack.html)

No download or install needed. Just click the link above and play in your browser.

## Overview

This is an implementation of the classic casino game Blackjack, built with HTML, CSS, and JavaScript. The game features a sleek user interface, realistic chip betting, and adherence to standard Blackjack rules.

![Matt's Blackjack](screenshot.png)



## Features

- Realistic chip betting system with multiple denominations
- Type an exact bet amount, or hit **Rebet** to repeat your last wager
- Multi-hand support with splitting functionality
- Double down, surrender, and insurance
- Six-deck shoe with a randomly placed cut card
- Dealer AI that follows standard casino rules
- Animations for card dealing and chip movement
- A felt table with three color themes, and a layout that fits on one screen from phones to desktops
- Session and lifetime statistics tracking
- Hot and cold streak notifications
- **Hint** button that suggests the basic-strategy play (and advises declining insurance). Switch hints off with the **Hints** toggle and the button disappears; the setting is remembered
- Sound effects with a mute button (your choice is remembered)
- Keyboard-friendly: chips are focusable buttons, cards are labeled for screen readers, and results are announced
- Keyboard shortcuts: H (hit), S (stand), D (double), P (split), R (surrender), Enter (deal)

## Running Locally

To play online, use the [Play Now](https://mattgrilli.github.io/blackjack.html) link above. To run your own copy:

1. Clone the repository:
   ```
   git clone https://github.com/mattgrilli/mattgrilli.github.io.git
   ```
2. Navigate to the project directory:
   ```
   cd mattgrilli.github.io
   ```
3. Open `blackjack.html` in your web browser to start the game.

## How to Play

1. Place your bet by clicking on the chips at the bottom of the screen.
2. Click 'Deal' to start the hand.
3. Use the action buttons (Hit, Stand, Double Down, Split) to play your hand.
4. Try to beat the dealer by getting as close to 21 as possible without going over.

## Game Rules

- The dealer must hit on 16 and stand on 17.
- Blackjack pays 3:2, rounded down to a whole dollar.
- Players can split up to three times (four hands total). Only two cards of the same rank can be split.
- Players can double down on any two cards, including after a split.
- Insurance is offered when the dealer's up card is an Ace. It costs half your bet (rounded down, minimum $1) and pays 2:1.
- Surrender returns half your bet (rounded up). It is only available as your first action on an unsplit hand.
- A hand that reaches 21 stands automatically.
- If you run out of money, you can start a new game with $1000.
- Your bankroll resets to $1000 on page reload. Lifetime statistics and your sound and hints settings are saved in your browser; session statistics are not.
- The Hint button follows basic strategy for a multi-deck shoe where the dealer stands on all 17s.

## Technologies Used

- HTML5
- CSS3
- JavaScript (ES6+)

## How It's Built

- `engine.js` - the rules of blackjack (dealing, splitting, insurance, payouts, basic strategy). It has no browser code, so it can be tested in plain Node. It reports what happens through events.
- `script.js` - the page: draws the table, plays sounds and animations, writes the messages and keeps the statistics, all in reaction to the engine's events. Rendering is incremental: cards, hands and chips are keyed, so only what changed is touched and unchanged elements keep their animations and focus.
- `blackjack.html` and `styles.css` - the markup and styling.

## Testing

`blackjack_verify.cjs` tests the rules engine directly in Node and the page wiring in a mocked browser. It includes random-play tests that check money is never created or lost:

```
node blackjack_verify.cjs
```

## Future Improvements

- A protected "vault" balance that can't be bet
- More detailed statistics and an achievement system

---

## 🎟️ Also in This Repo: Matt's Lucky Draw

## ▶️ [Play Lucky Draw](https://mattgrilli.github.io/lottery.html)

A lottery-ticket simulator, play money only. Buy tickets in whatever quantity you like,
then watch a real drawing: 5 numbers from 1-69 plus one "red ball" from 1-26, matching the
format (and the real published odds) of a well-known multi-state drawing game. This
project is not affiliated with or endorsed by any lottery operator — there are no real
tickets, no real drawings and no real prizes.

### Features

- **Pick your own starting balance** before buying your first ticket &mdash; try $20 or
  $20,000,000 and see how the odds actually play out. It's also what you get back if you
  go broke and start over
- Buy tickets in quick amounts (1, 5, 10, 25, 50), an exact quantity, or hit **Max** to
  spend your whole balance
- A real drawing every time: the odds for every prize tier come from combinatorics, not a
  hardcoded table, and match the real game's published odds exactly (see Testing below)
- A jackpot that grows every drawing nobody wins it, and resets after someone does
- A built-in paytable showing every prize and its real odds
- Session and lifetime statistics; going broke offers a fresh $100 to start over
- Sound effects with a mute button, and a Paytable toggle

### Rules

- Tickets cost $2 each. Each one is quick-picked: 5 numbers from 1-69, plus one "red ball"
  from 1-26.
- Prizes range from $4 (matching just the red ball) up to $1,000,000 (matching all 5 white
  numbers), and the jackpot — starting at $20,000,000 — for matching all 6.
- The jackpot grows by $3,000,000 every drawing nobody wins it, and resets to $20,000,000
  after a win.

### How It's Built

- `lottery-engine.js` — the drawing mechanics and odds. No browser code, so it can be
  tested in plain Node; it reports what happens through events.
- `lottery.js` — the page: renders the ticket kiosk, plays sounds, and keeps statistics,
  all in reaction to the engine's events.
- `lottery.html` and `lottery-styles.css` — the markup and styling.

### Testing

`lottery_verify.cjs` checks that the engine's odds match the real game's published odds
exactly (down to the tier), plus the page wiring in a mocked browser, plus random-play
fuzz tests that check no money is ever created or lost:

```
node lottery_verify.cjs
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is open source and available under the [MIT License](LICENSE).

## Credits

Developed by Matt Grilli

## Contact

If you have any questions, feel free to reach out through GitHub [@mattgrilli](https://github.com/mattgrilli).
