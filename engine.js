// engine.js — minimal legal-move generator over a *screen-oriented* 8x8 board.
//
// board[row][col] = null | { c: 'w'|'b', t: 'p'|'n'|'b'|'r'|'q'|'k' }
// row 0 is the TOP of the screen, col 0 is the LEFT. No a1/h8 naming needed:
// `bottomColor` tells us whose pawns march upward (toward row 0).
//
// Limitations (we only see a snapshot, no history): no en-passant, castling is
// shown whenever king + rook sit on their home squares with a clear path.
const ChessEngine = (() => {
  const inb = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;
  const N_D = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const K_D = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const B_D = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const R_D = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  const emptyBoard = () => Array.from({ length: 8 }, () => Array(8).fill(null));
  const cloneBoard = (b) => b.map((row) => row.slice());
  const pawnDir = (color, bottomColor) => (color === bottomColor ? -1 : 1);

  // Pseudo-legal moves for the piece at (r,c).
  // attacksMode=true: return every square the piece *attacks/defends*
  // (own-occupied squares included, pawn diagonals regardless of occupancy).
  function pseudoMoves(board, r, c, bottomColor, attacksMode = false) {
    const p = board[r][c];
    if (!p) return [];
    const out = [];
    const push = (tr, tc, extra) => {
      const q = board[tr][tc];
      out.push({ fr: r, fc: c, tr, tc, capture: !!(q && q.c !== p.c), ...(extra || {}) });
    };
    const consider = (tr, tc) => {
      // returns true if the ray should continue
      if (!inb(tr, tc)) return false;
      const q = board[tr][tc];
      if (!q) { push(tr, tc); return true; }
      if (q.c !== p.c || attacksMode) push(tr, tc);
      return false;
    };
    const slide = (dirs) => {
      for (const [dr, dc] of dirs) {
        let tr = r + dr, tc = c + dc;
        while (consider(tr, tc)) { tr += dr; tc += dc; }
      }
    };
    const step = (dirs) => { for (const [dr, dc] of dirs) consider(r + dr, c + dc); };

    switch (p.t) {
      case 'p': {
        const d = pawnDir(p.c, bottomColor);
        const startRow = d === -1 ? 6 : 1;
        for (const dc of [-1, 1]) {
          const tr = r + d, tc = c + dc;
          if (!inb(tr, tc)) continue;
          const q = board[tr][tc];
          if (attacksMode) push(tr, tc);
          else if (q && q.c !== p.c) push(tr, tc);
        }
        if (!attacksMode) {
          const tr = r + d;
          if (inb(tr, c) && !board[tr][c]) {
            push(tr, c);
            if (r === startRow && inb(tr + d, c) && !board[tr + d][c]) push(tr + d, c);
          }
        }
        break;
      }
      case 'n': step(N_D); break;
      case 'k': step(K_D); break;
      case 'b': slide(B_D); break;
      case 'r': slide(R_D); break;
      case 'q': slide(B_D); slide(R_D); break;
    }
    return out;
  }

  // Set of squares (r*8+c) attacked/defended by `color`.
  function attackMap(board, color, bottomColor) {
    const set = new Set();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p.c !== color) continue;
      for (const m of pseudoMoves(board, r, c, bottomColor, true)) set.add(m.tr * 8 + m.tc);
    }
    return set;
  }

  function isAttacked(board, r, c, byColor, bottomColor) {
    for (let rr = 0; rr < 8; rr++) for (let cc = 0; cc < 8; cc++) {
      const p = board[rr][cc];
      if (!p || p.c !== byColor) continue;
      for (const m of pseudoMoves(board, rr, cc, bottomColor, true)) if (m.tr === r && m.tc === c) return true;
    }
    return false;
  }

  function findKing(board, color) {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (p && p.c === color && p.t === 'k') return [r, c];
    }
    return null;
  }

  function makeMove(board, m) {
    const nb = cloneBoard(board);
    nb[m.tr][m.tc] = nb[m.fr][m.fc];
    nb[m.fr][m.fc] = null;
    if (m.castle) {
      nb[m.tr][m.rookTo] = nb[m.tr][m.rookFrom];
      nb[m.tr][m.rookFrom] = null;
    }
    return nb;
  }

  function castlingMoves(board, color, bottomColor) {
    const out = [];
    const homeRow = color === bottomColor ? 7 : 0;
    const kingCol = bottomColor === 'w' ? 4 : 3;
    const k = board[homeRow][kingCol];
    if (!k || k.c !== color || k.t !== 'k') return out;
    const opp = color === 'w' ? 'b' : 'w';
    if (isAttacked(board, homeRow, kingCol, opp, bottomColor)) return out;
    for (const rookCol of [0, 7]) {
      const rk = board[homeRow][rookCol];
      if (!rk || rk.c !== color || rk.t !== 'r') continue;
      const dir = rookCol > kingCol ? 1 : -1;
      let clear = true;
      for (let cc = kingCol + dir; cc !== rookCol; cc += dir) if (board[homeRow][cc]) { clear = false; break; }
      if (!clear) continue;
      const pass = [kingCol + dir, kingCol + 2 * dir];
      if (pass.some((cc) => isAttacked(board, homeRow, cc, opp, bottomColor))) continue;
      out.push({ fr: homeRow, fc: kingCol, tr: homeRow, tc: kingCol + 2 * dir, capture: false,
        castle: true, rookFrom: rookCol, rookTo: kingCol + dir });
    }
    return out;
  }

  // Fully legal moves for `color` (as if it were their turn).
  function legalMoves(board, color, bottomColor) {
    const opp = color === 'w' ? 'b' : 'w';
    const out = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = board[r][c];
      if (!p || p.c !== color) continue;
      for (const m of pseudoMoves(board, r, c, bottomColor, false)) {
        const nb = makeMove(board, m);
        const kp = findKing(nb, color);
        if (kp && isAttacked(nb, kp[0], kp[1], opp, bottomColor)) continue;
        out.push(m);
      }
    }
    out.push(...castlingMoves(board, color, bottomColor));
    return out;
  }

  function inCheck(board, color, bottomColor) {
    const kp = findKing(board, color);
    return !!kp && isAttacked(board, kp[0], kp[1], color === 'w' ? 'b' : 'w', bottomColor);
  }

  return { emptyBoard, cloneBoard, pseudoMoves, attackMap, isAttacked, legalMoves, inCheck, findKing, makeMove };
})();

if (typeof module !== 'undefined') module.exports = ChessEngine;
