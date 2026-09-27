# Chess Vision Overlay (Brave / Chromium extension)

Reads the chess board that is on your screen and draws faint lines over it:

- **Blue lines** – every legal move for your pieces (dot = quiet move, ring = capture, dashed = castling).
- **Red lines** – every legal move your opponent could play right now.
- **Rings** – red: your piece is hanging (attacked, undefended). Orange: attacked but defended. Green: an opponent piece you can take for free.
- **Hover** a piece to spotlight only its moves.

Colours, opacity and which side to show are adjustable in the popup.

## How it sees the board

Two piece sources, switchable in the popup:

1. **Screenshot (visual, default).** The extension screenshots the tab, cuts the board into 64 cells and matches each
   cell against templates it learned from the standard starting position. It works on any site with a 2D board
   (chess.com, lichess, chesstempo, YouTube videos, PDFs of games, …). You calibrate **once per site / piece set**:
   show the starting position, open the popup, click **Calibrate from starting position**. Templates are stored per
   hostname. Recalibrate if you change the piece set or board theme.
2. **Page DOM.** On chess.com and lichess the pieces are HTML elements, so the position can be read exactly with no
   calibration. Pick this when you only play on those two sites.

The board itself is located automatically (known selectors on chess.com / lichess, otherwise the largest square element
on the page). If that guesses wrong, click **Select board region** and drag a box over the board.

Board orientation (who sits at the bottom) comes from the page when available, otherwise it is inferred whenever a
starting position is seen, and can be forced with **I am playing → White / Black**.

## Install

1. Open `brave://extensions`, turn on **Developer mode** (top right).
2. **Load unpacked** → choose this folder.
3. Open a game on chess.com or lichess. The overlay activates automatically there. On any other page, open the
   popup and click **Activate on this page**.
4. Visual mode: with the starting position on screen, open the popup and click **Calibrate from starting position**.

## Files

| File | Purpose |
| --- | --- |
| `manifest.json` | MV3 manifest. Host permissions cover only chess.com and lichess (where the overlay auto-runs). Elsewhere, opening the popup grants `activeTab`, which is enough for `captureVisibleTab` on that tab. |
| `background.js` | Service worker. Only job: take the tab screenshot for the content script. |
| `content.js` | Board detection, screenshot → cell features → template matching, DOM reader, orientation, overlay drawing, region picker. |
| `engine.js` | Legal-move generator over a screen-oriented 8×8 board (checks, pins, castling). No en passant (needs move history). |
| `popup.html/js` | Settings UI and the calibrate / region / activate actions. |

## Known limits

- Visual mode needs a plain 2D board; 3D boards and heavily animated pieces will misread.
- Squares under the cursor while dragging, arrows drawn on the board, or premove hints can be read as pieces for a frame.
- En passant is not shown, and castling is shown whenever king and rook are on their home squares with a clear path (the
  extension cannot know whether they have moved before).
- Screenshots are limited to about 2 per second by the browser, so the overlay refreshes ~1 s after a move in visual mode.
  DOM mode updates instantly.

## Debugging

From the extension's service-worker console:

```js
const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
await chrome.tabs.sendMessage(t.id, { type: 'dump' });       // the position as the extension sees it
await chrome.tabs.sendMessage(t.id, { type: 'debugCells' }); // per-cell foreground % + a PNG grid of the 64 cells
```
