# Privacy Policy — Chess Vision Overlay

_Last updated: 27 September 2026_

Chess Vision Overlay is a browser extension that draws legal chess moves and attacked pieces over a chess board shown in your browser tab.

## What the extension collects

Nothing. The extension has no server, no analytics, no accounts and no tracking. It does not collect, transmit or sell any personal data.

## What happens on your device

- **Screenshots.** In "Screenshot (visual)" mode the extension captures the visible tab in order to recognise the pieces on the board. The image is processed in memory inside your browser and discarded. It is never saved to disk or sent anywhere.
- **Page content.** On chess.com and lichess the extension reads the board's HTML elements to determine the position. It does not read chat, messages, account details or anything outside the board.
- **Settings.** Your colour, opacity and side preferences, and the piece templates created when you click "Calibrate from starting position", are stored locally using the browser's extension storage. They stay on your device and are removed when you uninstall the extension.

## Permissions

- `activeTab`, `tabs`, `scripting`: locate the board in the current tab and inject the overlay when you click "Activate on this page".
- `storage`: save your preferences and calibration templates locally.
- Host access to chess.com and lichess.org: run the overlay automatically on those sites.

## Third parties

None. No data is shared with anyone.

## Changes

If this policy changes, the updated version will be published at this URL with a new date.

## Contact

Open an issue at https://github.com/bhattji007/chess-vision-overlay/issues
