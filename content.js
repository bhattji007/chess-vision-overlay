// content.js — Chess Vision Overlay
// Finds the chess board on the page, reads the position (screenshot + template
// matching by default, DOM as an alternative), generates legal moves for both
// sides and draws faint lines over the board.
(() => {
  if (window.__chessVisionLoaded) return;
  window.__chessVisionLoaded = true;

  const HOST = location.hostname;
  const SITE_KEY = 'site:' + HOST;
  const N = 20;            // cells are downsampled to N x N before matching
  const FG_THRESH = 90;    // |dr|+|dg|+|db| above this = "not background"
  const MAX_DIST = 0.5;    // nearest-template distance above this = unknown
  const MIN_CAPTURE_GAP = 650; // ms between screenshots (API limit is 2/s)

  const DEFAULTS = {
    enabled: true, source: 'visual', showMine: true, showTheirs: true,
    showDanger: true, opacity: 0.35, myColor: 'auto',
    mineColor: '#3b9cff', theirsColor: '#ff5d5d',
  };

  let settings = { ...DEFAULTS };
  let site = { exemplars: null, rect: null, bottomColor: null };
  let boardEl = null, lastBoardSearch = 0;
  let overlay, ctx, curRect = null;
  let board = null, moves = { w: [], b: [] }, attacks = { w: new Set(), b: new Set() };
  let bottomColor = 'w', myColor = 'w';
  let status = 'starting…', unknownCount = 0, pieceCount = 0;
  let busy = false, pending = false, lastCapture = 0, detectTimer = null;
  let hover = null;

  const cellCanvas = document.createElement('canvas');
  cellCanvas.width = N; cellCanvas.height = N;
  const cctx = cellCanvas.getContext('2d', { willReadFrequently: true });
  cctx.imageSmoothingEnabled = true; cctx.imageSmoothingQuality = 'high';

  // ---------- storage ----------
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

  function saveSite() {
    const out = {
      rect: site.rect, bottomColor: site.bottomColor,
      exemplars: site.exemplars ? site.exemplars.map((e) => ({ l: e.l, f: b64(e.f) })) : null,
    };
    chrome.storage.local.set({ [SITE_KEY]: out });
  }
  async function loadAll() {
    const s = await chrome.storage.sync.get('settings');
    settings = { ...DEFAULTS, ...(s.settings || {}) };
    const l = await chrome.storage.local.get(SITE_KEY);
    const d = l[SITE_KEY];
    if (d) {
      site.rect = d.rect || null;
      site.bottomColor = d.bottomColor || null;
      site.exemplars = d.exemplars ? d.exemplars.map((e) => ({ l: e.l, f: unb64(e.f) })) : null;
    }
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) {
      settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
      if (!settings.enabled) { board = null; render(); } else scheduleDetect(50);
    }
  });

  // ---------- board location ----------
  const BOARD_SELECTORS = [
    'wc-chess-board', 'chess-board', 'cg-board', '.cg-board',
    '#board-layout-chessboard .board', '.board-layout-chessboard .board',
  ];
  function isSquareish(r, tol) { return r.width > 150 && Math.abs(r.width - r.height) <= r.width * tol; }
  function findBoardEl() {
    for (const sel of BOARD_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isSquareish(el.getBoundingClientRect(), 0.06)) return el;
    }
    // Generic fallback: the largest square-ish element on the page.
    let best = null, bestArea = 0;
    for (const el of document.querySelectorAll('div,canvas,section,img,svg,table')) {
      if (el === overlay) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 240 || !isSquareish(r, 0.03)) continue;
      const a = r.width * r.height;
      if (a > bestArea) { best = el; bestArea = a; }
    }
    return best;
  }
  function boardRect() {
    if (site.rect) {
      return { x: site.rect.x - window.scrollX, y: site.rect.y - window.scrollY, w: site.rect.w, h: site.rect.h };
    }
    const now = performance.now();
    if (!boardEl || !boardEl.isConnected || now - lastBoardSearch > 5000) {
      boardEl = findBoardEl(); lastBoardSearch = now; observeBoard();
    }
    if (!boardEl) return null;
    const r = boardEl.getBoundingClientRect();
    const s = Math.min(r.width, r.height);
    return { x: r.left, y: r.top, w: s, h: s };
  }

  // Which colour sits at the bottom, if the page tells us.
  function domBottomColor() {
    if (document.querySelector('wc-chess-board.flipped, chess-board.flipped, .cg-wrap.orientation-black')) return 'b';
    if (document.querySelector('wc-chess-board, chess-board, .cg-wrap.orientation-white')) return 'w';
    return null;
  }

  // ---------- screenshot + features ----------
  function captureViewport() {
    return new Promise((res, rej) => {
      chrome.runtime.sendMessage({ type: 'capture' }, (resp) => {
        if (chrome.runtime.lastError) return rej(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return rej(new Error((resp && resp.error) || 'capture failed'));
        res(resp.dataUrl);
      });
    });
  }
  const loadImage = (url) => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => rej(new Error('image decode failed')); im.src = url; });
  // Wait for the hidden overlay to actually leave the screen. rAF doesn't fire in
  // background tabs, so fall back to a plain timer.
  const settle = () => new Promise((r) => {
    let done = false; const fin = () => { if (!done) { done = true; setTimeout(r, 30); } };
    requestAnimationFrame(() => requestAnimationFrame(fin)); setTimeout(fin, 250);
  });

  // Feature = per pixel [isForeground(0|255), gray]. Background colour is the
  // median of the cell's border ring, so square colour / highlights drop out.
  function featurize(data) {
    const ring = [[], [], []];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      if (y === 0 || y === N - 1 || x === 0 || x === N - 1) {
        const i = (y * N + x) * 4;
        ring[0].push(data[i]); ring[1].push(data[i + 1]); ring[2].push(data[i + 2]);
      }
    }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const br = med(ring[0]), bg = med(ring[1]), bb = med(ring[2]);
    const f = new Uint8Array(N * N * 2);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 2) {
      const d = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb);
      f[j] = d > FG_THRESH ? 255 : 0;
      f[j + 1] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
    }
    return f;
  }
  function fgFraction(f) { let n = 0; for (let i = 0; i < f.length; i += 2) if (f[i]) n++; return n / (f.length / 2); }
  function dist(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i += 2) {
      if (a[i] !== b[i]) s += 255;
      else if (a[i]) s += Math.abs(a[i + 1] - b[i + 1]);
    }
    return s / (a.length / 2) / 255;
  }

  async function grabCells(rect) {
    overlay.style.visibility = 'hidden';
    let img;
    try {
      await settle();
      lastCapture = performance.now();
      const url = await captureViewport();
      if (window.__cvDebugCanvas) window.__cvLastCapture = url;
      img = await loadImage(url);
    } finally { overlay.style.visibility = ''; }
    const sx = img.naturalWidth / window.innerWidth, sy = img.naturalHeight / window.innerHeight;
    const cw = rect.w * sx / 8, ch = rect.h * sy / 8;
    const cells = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      cctx.clearRect(0, 0, N, N);
      cctx.drawImage(img, rect.x * sx + c * cw, rect.y * sy + r * ch, cw, ch, 0, 0, N, N);
      cells.push(featurize(cctx.getImageData(0, 0, N, N).data));
      if (window.__cvDebugCanvas) window.__cvDebugCanvas.getContext('2d').drawImage(cellCanvas, c * N, r * N);
    }
    return cells;
  }

  function classify(cells) {
    const b = ChessEngine.emptyBoard();
    unknownCount = 0; pieceCount = 0;
    for (let i = 0; i < 64; i++) {
      const f = cells[i];
      if (fgFraction(f) < 0.02) continue;
      let best = null, bd = Infinity;
      for (const e of site.exemplars) { const d = dist(f, e.f); if (d < bd) { bd = d; best = e.l; } }
      if (bd > MAX_DIST || !best || best === '--') { if (bd > MAX_DIST) unknownCount++; continue; }
      b[i >> 3][i & 7] = { c: best[0], t: best[1] };
      pieceCount++;
    }
    return b;
  }

  // Learn templates from the standard starting position currently on screen.
  async function calibrate() {
    const rect = boardRect();
    if (!rect) throw new Error('Board not found — use "Select board region" first.');
    positionOverlay(rect);
    const cells = await grabCells(rect);
    const rows = (rs) => rs.flatMap((r) => Array.from({ length: 8 }, (_, c) => r * 8 + c));
    const pieceIdx = rows([0, 1, 6, 7]), emptyIdx = rows([2, 3, 4, 5]);
    const avg = (idx, fn) => idx.reduce((s, i) => s + fn(cells[i]), 0) / idx.length;
    const pieceFg = avg(pieceIdx, fgFraction), emptyFg = avg(emptyIdx, fgFraction);
    if (pieceFg < 0.06 || emptyFg > 0.06 || pieceFg < emptyFg * 3) {
      throw new Error(`This doesn't look like the starting position (pieces ${Math.round(pieceFg * 100)}% / empties ${Math.round(emptyFg * 100)}% filled).`);
    }
    const lum = (idx) => { let s = 0, n = 0; for (const i of idx) { const f = cells[i]; for (let k = 0; k < f.length; k += 2) if (f[k]) { s += f[k + 1]; n++; } } return n ? s / n : 0; };
    const bottomIsWhite = lum(rows([6, 7])) > lum(rows([0, 1]));
    const bc = bottomIsWhite ? 'w' : 'b', tc = bottomIsWhite ? 'b' : 'w';
    const order = bottomIsWhite ? 'rnbqkbnr' : 'rnbkqbnr'; // same left→right order for both back ranks
    const ex = [];
    for (let c = 0; c < 8; c++) {
      ex.push({ l: tc + order[c], f: cells[c] });
      ex.push({ l: tc + 'p', f: cells[8 + c] });
      ex.push({ l: bc + 'p', f: cells[48 + c] });
      ex.push({ l: bc + order[c], f: cells[56 + c] });
    }
    for (const i of emptyIdx) ex.push({ l: '--', f: cells[i] });
    site.exemplars = ex; site.bottomColor = bc; saveSite();
    return `Calibrated: ${bottomIsWhite ? 'White' : 'Black'} at the bottom, 64 templates saved for ${HOST}.`;
  }

  // ---------- DOM reader (chess.com / lichess piece elements) ----------
  function readDomBoard(rect) {
    const b = ChessEngine.emptyBoard();
    let n = 0;
    for (const el of document.querySelectorAll('.piece, piece')) {
      const cls = typeof el.className === 'string' ? el.className : '';
      if (/\b(ghost|fading|dragging)\b/.test(cls)) continue;
      let label = null;
      const m = cls.match(/\b([wb])([pnbrqk])\b/);
      if (m) label = m[1] + m[2];
      else {
        const col = /\bwhite\b/.test(cls) ? 'w' : /\bblack\b/.test(cls) ? 'b' : null;
        const t = cls.match(/\b(pawn|knight|bishop|rook|queen|king)\b/);
        if (col && t) label = col + (t[1] === 'knight' ? 'n' : t[1][0]);
      }
      if (!label) continue;
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const c = Math.floor((r.left + r.width / 2 - rect.x) / rect.w * 8);
      const rr = Math.floor((r.top + r.height / 2 - rect.y) / rect.h * 8);
      if (c < 0 || c > 7 || rr < 0 || rr > 7) continue;
      b[rr][c] = { c: label[0], t: label[1] }; n++;
    }
    pieceCount = n; unknownCount = 0;
    return n ? b : null;
  }

  // ---------- orientation ----------
  function startPositionBottom(b) {
    const colorOfRows = (rs) => { let col = null; for (const r of rs) for (let c = 0; c < 8; c++) { const p = b[r][c]; if (!p) return null; if (col && p.c !== col) return null; col = p.c; } return col; };
    const top = colorOfRows([0, 1]), bot = colorOfRows([6, 7]);
    return top && bot && top !== bot ? bot : null;
  }
  function resolveOrientation() {
    if (settings.myColor === 'w' || settings.myColor === 'b') { bottomColor = myColor = settings.myColor; return; }
    const dom = domBottomColor();
    const start = board && startPositionBottom(board);
    if (start && site.bottomColor !== start) { site.bottomColor = start; saveSite(); }
    bottomColor = dom || start || site.bottomColor || 'w';
    myColor = bottomColor;
  }

  // ---------- detection loop ----------
  function scheduleDetect(ms) { clearTimeout(detectTimer); detectTimer = setTimeout(detect, ms); }
  async function detect() {
    if (!settings.enabled) return;
    if (busy) { pending = true; return; }
    busy = true;
    try {
      const rect = boardRect();
      if (!rect) { status = 'Board not found on this page.'; board = null; render(); return; }
      positionOverlay(rect);
      let b = null;
      if (settings.source === 'dom') {
        b = readDomBoard(rect);
        if (!b) status = 'DOM mode: no piece elements found (try Visual mode).';
      } else {
        if (!site.exemplars) { status = 'Not calibrated — show the starting position and click Calibrate.'; board = null; render(); return; }
        const gap = MIN_CAPTURE_GAP - (performance.now() - lastCapture);
        if (gap > 0) { scheduleDetect(gap); return; }
        b = classify(await grabCells(rect));
      }
      if (b) {
        board = b;
        resolveOrientation();
        moves = { w: ChessEngine.legalMoves(board, 'w', bottomColor), b: ChessEngine.legalMoves(board, 'b', bottomColor) };
        attacks = { w: ChessEngine.attackMap(board, 'w', bottomColor), b: ChessEngine.attackMap(board, 'b', bottomColor) };
        status = `${pieceCount} pieces · ${bottomColor === 'w' ? 'White' : 'Black'} at bottom · you: ${myColor === 'w' ? 'White' : 'Black'}`
          + (unknownCount ? ` · ${unknownCount} unrecognised square${unknownCount > 1 ? 's' : ''}` : '');
      }
      render();
    } catch (e) {
      status = 'Error: ' + e.message; render();
    } finally {
      busy = false;
      if (pending) { pending = false; scheduleDetect(150); }
    }
  }

  let observer = null, observedEl = null;
  function observeBoard() {
    const target = site.rect ? document.body : boardEl;
    if (!target || target === observedEl) return;
    if (observer) observer.disconnect();
    observedEl = target;
    observer = new MutationObserver(() => scheduleDetect(site.rect ? 300 : 120));
    observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: false });
  }

  // ---------- overlay ----------
  function positionOverlay(rect) {
    curRect = rect;
    const dpr = window.devicePixelRatio || 1;
    Object.assign(overlay.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
    const W = Math.round(rect.w * dpr), H = Math.round(rect.h * dpr);
    if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function render() {
    if (!ctx || !curRect) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, curRect.w, curRect.h);
    if (!board || !settings.enabled) return;
    const cs = curRect.w / 8;
    const cx = (c) => c * cs + cs / 2, cy = (r) => r * cs + cs / 2;
    const opp = myColor === 'w' ? 'b' : 'w';
    const hoverPiece = hover && board[hover.r] && board[hover.r][hover.c];
    const baseA = settings.opacity;

    const drawSide = (color, hex, isMine) => {
      const show = isMine ? settings.showMine : settings.showTheirs;
      if (!show && !hoverPiece) return;
      for (const m of moves[color]) {
        const isHovered = hoverPiece && m.fr === hover.r && m.fc === hover.c;
        if (!show && !isHovered) continue;
        let a = baseA;
        if (hoverPiece) a = isHovered ? Math.min(1, baseA * 2.5 + 0.35) : baseA * 0.25;
        ctx.strokeStyle = hexA(hex, a); ctx.fillStyle = hexA(hex, a);
        ctx.lineWidth = isHovered ? 2.5 : isMine ? 1.6 : 1.2;
        ctx.setLineDash(m.castle ? [4, 4] : []);
        const x1 = cx(m.fc), y1 = cy(m.fr), x2 = cx(m.tc), y2 = cy(m.tr);
        const L = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / L, uy = (y2 - y1) / L;
        const end = cs * 0.14;
        ctx.beginPath(); ctx.moveTo(x1 + ux * cs * 0.18, y1 + uy * cs * 0.18); ctx.lineTo(x2 - ux * end, y2 - uy * end); ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        if (m.capture) { ctx.lineWidth = isHovered ? 2.5 : 1.5; ctx.arc(x2, y2, cs * 0.3, 0, Math.PI * 2); ctx.stroke(); }
        else { ctx.arc(x2, y2, cs * 0.07, 0, Math.PI * 2); ctx.fill(); }
      }
    };
    drawSide(opp, settings.theirsColor, false);
    drawSide(myColor, settings.mineColor, true);

    if (settings.showDanger) {
      const ring = (r, c, color, w) => { ctx.strokeStyle = color; ctx.lineWidth = w; ctx.beginPath(); ctx.arc(cx(c), cy(r), cs * 0.44, 0, Math.PI * 2); ctx.stroke(); };
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const p = board[r][c]; if (!p) continue;
        const k = r * 8 + c;
        if (p.c === myColor) {
          const attacked = attacks[opp].has(k), defended = attacks[myColor].has(k);
          if (attacked && !defended) ring(r, c, 'rgba(255,60,60,0.85)', 3);       // hanging!
          else if (attacked) ring(r, c, 'rgba(255,160,40,0.6)', 1.5);             // attacked but covered
        } else {
          const attacked = attacks[myColor].has(k), defended = attacks[opp].has(k);
          if (attacked && !defended) ring(r, c, 'rgba(60,220,110,0.85)', 3);      // free piece for you
        }
      }
    }
  }

  // ---------- manual region selection ----------
  function startRegionSelect() {
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      Object.assign(ov.style, { position: 'fixed', inset: 0, zIndex: 2147483647, cursor: 'crosshair', background: 'rgba(0,0,0,0.25)' });
      const box = document.createElement('div');
      Object.assign(box.style, { position: 'fixed', border: '2px dashed #3b9cff', background: 'rgba(59,156,255,0.15)', display: 'none', pointerEvents: 'none' });
      const hint = document.createElement('div');
      hint.textContent = 'Drag a box over the chess board (Esc to cancel)';
      Object.assign(hint.style, { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', padding: '8px 14px', background: '#111', color: '#fff', font: '14px system-ui', borderRadius: '8px', pointerEvents: 'none' });
      ov.append(box, hint); document.documentElement.appendChild(ov);
      let sx = 0, sy = 0, dragging = false;
      const finish = (res) => { ov.remove(); document.removeEventListener('keydown', onKey, true); resolve(res); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish('Selection cancelled.'); } };
      document.addEventListener('keydown', onKey, true);
      ov.addEventListener('mousedown', (e) => { dragging = true; sx = e.clientX; sy = e.clientY; box.style.display = 'block'; });
      ov.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const s = Math.max(Math.abs(e.clientX - sx), Math.abs(e.clientY - sy));
        const x = e.clientX < sx ? sx - s : sx, y = e.clientY < sy ? sy - s : sy;
        Object.assign(box.style, { left: x + 'px', top: y + 'px', width: s + 'px', height: s + 'px' });
      });
      ov.addEventListener('mouseup', (e) => {
        if (!dragging) return;
        const s = Math.max(Math.abs(e.clientX - sx), Math.abs(e.clientY - sy));
        if (s < 100) return finish('Selection too small — try again.');
        const x = e.clientX < sx ? sx - s : sx, y = e.clientY < sy ? sy - s : sy;
        site.rect = { x: x + window.scrollX, y: y + window.scrollY, w: s, h: s };
        boardEl = null; saveSite(); observeBoard(); scheduleDetect(50);
        finish(`Board region saved (${s}px square).`);
      });
    });
  }

  // ---------- messages from the popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      switch (msg && msg.type) {
        case 'status':
          return { ok: true, host: HOST, status, calibrated: !!site.exemplars, hasRect: !!site.rect, bottomColor, myColor, pieces: pieceCount };
        case 'calibrate': {
          const text = await calibrate(); scheduleDetect(50); return { ok: true, text };
        }
        case 'selectRegion': return { ok: true, text: await startRegionSelect() };
        case 'clearRegion': site.rect = null; boardEl = null; saveSite(); scheduleDetect(50); return { ok: true, text: 'Using automatic board detection.' };
        case 'clearCalibration': site.exemplars = null; saveSite(); board = null; render(); scheduleDetect(50); return { ok: true, text: 'Templates cleared.' };
        case 'detect': scheduleDetect(0); return { ok: true };
        case 'debugCells': {
          const rect = boardRect();
          window.__cvDebugCanvas = document.createElement('canvas'); window.__cvDebugCanvas.width = window.__cvDebugCanvas.height = N * 8;
          const cells = await grabCells(rect);
          const grid = window.__cvDebugCanvas.toDataURL(); window.__cvDebugCanvas = null;
          return { ok: true, rect, fg: cells.map((f) => Math.round(fgFraction(f) * 100)), grid, cap: window.__cvLastCapture };
        }
        case 'dump': // debugging aid: the position as we currently see it (uppercase = white, top row first)
          return { ok: true, status, bottomColor, board: board ? board.map((row) => row.map((p) => !p ? '.' : p.c === 'w' ? p.t.toUpperCase() : p.t).join('')) : null };
        default: return { ok: false, error: 'unknown message' };
      }
    })().then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
    return true;
  });

  // ---------- boot ----------
  async function init() {
    overlay = document.createElement('canvas');
    overlay.id = 'chess-vision-overlay';
    Object.assign(overlay.style, { position: 'fixed', left: 0, top: 0, pointerEvents: 'none', zIndex: 2147483646 });
    document.documentElement.appendChild(overlay);
    ctx = overlay.getContext('2d');
    await loadAll();

    document.addEventListener('mousemove', (e) => {
      if (!curRect) return;
      const c = Math.floor((e.clientX - curRect.x) / curRect.w * 8), r = Math.floor((e.clientY - curRect.y) / curRect.h * 8);
      const h = (c >= 0 && c < 8 && r >= 0 && r < 8) ? { r, c } : null;
      if ((h && hover && h.r === hover.r && h.c === hover.c) || (!h && !hover)) return;
      hover = h; render();
    }, { passive: true });
    const reposition = () => { const rect = boardRect(); if (rect) { positionOverlay(rect); render(); } };
    window.addEventListener('scroll', reposition, { passive: true });
    window.addEventListener('resize', () => { reposition(); scheduleDetect(200); });
    setInterval(() => { if (settings.enabled) scheduleDetect(0); }, 2500);
    scheduleDetect(300);
  }
  init();
})();
