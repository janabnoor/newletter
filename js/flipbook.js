/**
 * flipbook.js  — Professional Canvas Page-Curl Engine v4
 * ═══════════════════════════════════════════════════════════════════════
 *
 * WHAT'S NEW IN v4:
 *  ✦ Sound fires the INSTANT the animation frame begins (true sync)
 *  ✦ Real corner-fold: hover any corner to see a live fold preview
 *  ✦ Drag the corner: page follows your finger/mouse in real time
 *  ✦ Release → completes flip OR snaps back depending on distance
 *  ✦ Curved bezier fold-spine (not a flat line)
 *  ✦ Dynamic shadow & lighting that change with fold angle
 *  ✦ Arrow buttons mounted OUTSIDE the overlay (z:50, mobile-safe)
 *  ✦ Touch events on arrows use touchend + preventDefault (no ghost clicks)
 *
 * Public API
 *   Flipbook.init(canvases, container, onPageChange, onFlipStart)
 *   Flipbook.next() / prev() / first() / last() / goTo(index, skipAnim?)
 *   Flipbook.currentPage  (getter)
 *   Flipbook.totalPages   (getter)
 * ═══════════════════════════════════════════════════════════════════════
 */

const Flipbook = (() => {

  /* ── Private State ──────────────────────────────────────────────── */
  let _can      = [];      // rendered PDF canvases
  let _wrap     = null;    // #flipbook-container  (position:relative)
  let _ov       = null;    // overlay <canvas>
  let _ctx      = null;
  let _pages    = [];      // .fb-page <div> wrappers
  let _cur      = 0;       // current page index (0-based)
  let _tot      = 0;       // total pages
  let _busy     = false;   // animation lock
  let _onChange = null;    // (cur, tot) callback after flip
  let _onStart  = null;    // ()         callback AT flip start (sound)

  /* ── Animation config ───────────────────────────────────────────── */
  const AUTO_MS     = 850;   // auto-complete flip duration (ms)
  const SNAPBACK_MS = 420;   // snap-back duration when released early
  const CORNER_PX   = 100;   // corner hot-zone size (px)
  const SWIPE_PX    = 48;    // min swipe distance

  /* ── Drag state ─────────────────────────────────────────────────── */
  const drag = {
    active   : false,   // pointer is down
    live     : false,   // currently in a drag-flip (following finger)
    dir      : 0,       // +1 = fwd, -1 = bwd
    fromIdx  : 0,       // source page index
    toIdx    : 0,       // destination page index
    originX  : 0,       // drag start (container-relative)
    originY  : 0,
    curX     : 0,       // current pointer position
    curY     : 0,
    corner   : '',      // 'br' | 'bl' | ''
    soundFired: false,
  };

  /* ── Arrow refs ─────────────────────────────────────────────────── */
  let _arL = null, _arR = null;

  /* ════════════════════════════════════════════════════════════════
     HELPERS
  ════════════════════════════════════════════════════════════════ */

  function _W () { return _wrap.offsetWidth;  }
  function _H () { return _wrap.offsetHeight; }

  /** Container-relative pointer position */
  function _rel (e) {
    const r   = _wrap.getBoundingClientRect();
    const src = (e.touches && e.touches.length) ? e.touches[0]
              : (e.changedTouches && e.changedTouches.length) ? e.changedTouches[0]
              : e;
    return { x: src.clientX - r.left, y: src.clientY - r.top };
  }

  /** Which corner does this point fall in? Returns 'br','bl', or '' */
  function _cornerOf (x, y) {
    const W = _W(), H = _H();
    if (x > W - CORNER_PX && y > H - CORNER_PX) return 'br';
    if (x < CORNER_PX     && y > H - CORNER_PX) return 'bl';
    if (x > W - CORNER_PX && y < CORNER_PX)     return 'tr';
    if (x < CORNER_PX     && y < CORNER_PX)     return 'tl';
    return '';
  }

  function _showPage (i) {
    _pages.forEach((p, j) => { p.style.display = j === i ? 'block' : 'none'; });
  }

  function _syncOv () {
    _ov.width  = _W();
    _ov.height = _H();
  }

  /* ════════════════════════════════════════════════════════════════
     ARROWS  — built outside overlay so touch always hits them
  ════════════════════════════════════════════════════════════════ */

  function _buildArrows () {
    _arL = _mkArrow('◀', 'fb-arrow fb-arrow-left',  'Previous page');
    _arR = _mkArrow('▶', 'fb-arrow fb-arrow-right', 'Next page');
    _wrap.appendChild(_arL);
    _wrap.appendChild(_arR);
    _bindArrow(_arL, () => prev());
    _bindArrow(_arR, () => next());
    _refreshArrows();
  }

  function _mkArrow (sym, cls, label) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = sym;
    b.setAttribute('aria-label', label);
    return b;
  }

  function _bindArrow (btn, action) {
    // touchstart: stop the container seeing this as a swipe-start
    btn.addEventListener('touchstart', e => {
      e.stopPropagation();
    }, { passive: false });

    // touchend: fire action (preventDefault stops 300ms ghost click)
    btn.addEventListener('touchend', e => {
      e.stopPropagation();
      e.preventDefault();
      action();
    }, { passive: false });

    // desktop click
    btn.addEventListener('click', e => {
      e.stopPropagation();
      action();
    });
  }

  function _refreshArrows () {
    if (!_arL) return;
    _arL.style.display = (_cur > 0)          ? 'flex' : 'none';
    _arR.style.display = (_cur < _tot - 1)   ? 'flex' : 'none';
  }

  /* ════════════════════════════════════════════════════════════════
     EASING
  ════════════════════════════════════════════════════════════════ */

  /** Ease-in-out quartic — feels like heavy paper */
  function _ease (t) {
    return t < 0.5 ? 8*t*t*t*t : 1 - Math.pow(-2*t+2, 4)/2;
  }

  /** Ease-out cubic — snappy snap-back */
  function _easeOut (t) { return 1 - Math.pow(1-t, 3); }

  /* ════════════════════════════════════════════════════════════════
     CORE RENDER  — draws one frame of the page-curl
     t = 0 → page flat/untouched   t = 1 → page fully flipped
     fwd = true  → right-to-left (next page)
     fwd = false → left-to-right (prev page)
  ════════════════════════════════════════════════════════════════ */

  /**
   * @param {number}             t       0..1 progress
   * @param {boolean}            fwd     direction
   * @param {HTMLCanvasElement}  fromCv  page leaving
   * @param {HTMLCanvasElement}  toCv    page arriving
   */
  function _render (t, fwd, fromCv, toCv) {
    const W = _ov.width, H = _ov.height;
    _ctx.clearRect(0, 0, W, H);

    if (fwd) {
      _drawFlip(W, H, t, fromCv, toCv);
    } else {
      // Mirror the canvas for backward flip
      _ctx.save();
      _ctx.translate(W, 0);
      _ctx.scale(-1, 1);
      _drawFlip(W, H, t, fromCv, toCv);
      _ctx.restore();
    }
  }

  /**
   * Draws a right-to-left flip (forward direction).
   * The fold line travels from x=W (t=0) to x=0 (t=1).
   */
  function _drawFlip (W, H, t, fromCv, toCv) {
    /* ─ geometry ─────────────────────────────────────────────────
       foldX  : x-position of the fold crease
       leafW  : visible width of the folded leaf
       bendY  : vertical offset of the bezier control point
                (simulates paper curvature at peak of flip)          */
    const foldX  = W * (1 - t);
    const leafW  = Math.min(W - foldX, W * 0.6);
    // Bend peaks at t=0.5, giving a smooth arc shape to the spine
    const bend   = leafW * 0.22 * Math.sin(t * Math.PI);

    /* ── 1. Background: draw the DESTINATION page fully ─────────── */
    _ctx.drawImage(toCv, 0, 0, W, H);

    /* ── 2. Clip & draw the SOURCE page (left portion only) ──────── */
    _ctx.save();
    _ctx.beginPath();
    _ctx.rect(0, 0, foldX, H);
    _ctx.clip();
    _ctx.drawImage(fromCv, 0, 0, W, H);
    _ctx.restore();

    /* ── 3. Shadow on destination page near the fold ─────────────── */
    const shadowW = W * 0.18 * Math.sin(t * Math.PI);
    if (shadowW > 1) {
      const sg = _ctx.createLinearGradient(foldX, 0, foldX + shadowW, 0);
      sg.addColorStop(0,    'rgba(0,0,0,0.60)');
      sg.addColorStop(0.25, 'rgba(0,0,0,0.25)');
      sg.addColorStop(0.7,  'rgba(0,0,0,0.08)');
      sg.addColorStop(1,    'rgba(0,0,0,0.00)');
      _ctx.fillStyle = sg;
      _ctx.fillRect(foldX, 0, shadowW, H);
    }

    /* ── 4. The folded leaf ───────────────────────────────────────
       Shape: a quadrilateral with a bezier-curved left edge (spine).
       The curve gives the paper a bent look at peak animation.      */
    _ctx.save();

    // Build the leaf clipping path
    _ctx.beginPath();
    _ctx.moveTo(foldX,          0);
    _ctx.lineTo(foldX + leafW,  0);
    _ctx.lineTo(foldX + leafW,  H);
    _ctx.lineTo(foldX,          H);
    // Curved spine: bulges left to simulate bending paper
    _ctx.bezierCurveTo(
      foldX - bend,   H * 0.75,    // cp1
      foldX - bend,   H * 0.25,    // cp2
      foldX,          0            // end
    );
    _ctx.closePath();
    _ctx.clip();

    // Draw the BACK of the page (mirrored source content)
    _ctx.save();
    _ctx.translate(foldX + leafW, 0);
    _ctx.scale(-1, 1);
    _ctx.drawImage(fromCv, 0, 0, leafW, H);
    _ctx.restore();

    // Lighting gradient across the leaf
    // → bright at spine (where light hits the bent paper)
    // → very dark at the trailing edge
    const lg = _ctx.createLinearGradient(foldX, 0, foldX + leafW, 0);
    const spinePeak = Math.sin(t * Math.PI); // 0→1→0
    lg.addColorStop(0,    `rgba(255,255,255,${0.45 * spinePeak})`);
    lg.addColorStop(0.06, `rgba(255,255,255,${0.15 * spinePeak})`);
    lg.addColorStop(0.4,  'rgba(150,140,130,0.05)');
    lg.addColorStop(1,    `rgba(0,0,0,${0.55 * spinePeak})`);
    _ctx.fillStyle = lg;
    _ctx.fill();   // fill the clipped leaf region

    _ctx.restore();

    /* ── 5. Paper thickness / spine strip ───────────────────────── */
    const spineThick = 3 + 5 * Math.sin(t * Math.PI);
    _ctx.save();
    _ctx.beginPath();
    // Draw the bezier spine path
    _ctx.moveTo(foldX, 0);
    _ctx.bezierCurveTo(
      foldX - bend,   H * 0.25,
      foldX - bend,   H * 0.75,
      foldX,          H
    );
    _ctx.lineWidth   = spineThick;
    _ctx.strokeStyle = `rgba(40,25,10,${0.65 * Math.sin(t * Math.PI)})`;
    _ctx.stroke();
    _ctx.restore();

    /* ── 6. Bright highlight at crease ──────────────────────────── */
    _ctx.save();
    _ctx.beginPath();
    _ctx.moveTo(foldX + spineThick * 0.6, 0);
    _ctx.bezierCurveTo(
      foldX + spineThick * 0.6 - bend * 0.4, H * 0.25,
      foldX + spineThick * 0.6 - bend * 0.4, H * 0.75,
      foldX + spineThick * 0.6, H
    );
    _ctx.lineWidth   = 1.5;
    _ctx.strokeStyle = `rgba(255,255,255,${0.75 * Math.sin(t * Math.PI)})`;
    _ctx.stroke();
    _ctx.restore();

    /* ── 7. Cast shadow left of fold onto remaining source page ──── */
    const castW = W * 0.05 * (1 - t) * Math.sin(t * Math.PI * 0.8);
    if (castW > 1) {
      const cg = _ctx.createLinearGradient(foldX - castW, 0, foldX, 0);
      cg.addColorStop(0, 'rgba(0,0,0,0)');
      cg.addColorStop(1, 'rgba(0,0,0,0.25)');
      _ctx.fillStyle = cg;
      _ctx.fillRect(Math.max(0, foldX - castW), 0, castW, H);
    }
  }

  /* ════════════════════════════════════════════════════════════════
     CORNER FOLD PREVIEW  — live hover / drag from corner
  ════════════════════════════════════════════════════════════════ */

  /**
   * Draws a small triangular corner curl when hovering or dragging.
   * px, py = pointer position (container-relative)
   * corner = 'br' | 'bl'
   */
  function _drawCornerFold (px, py, corner) {
    const W = _ov.width, H = _ov.height;
    _ctx.clearRect(0, 0, W, H);

    if (corner === 'br' || corner === 'tr') {
      _drawCornerFoldRight(W, H, px, py, _can[drag.fromIdx], _can[drag.toIdx]);
    } else {
      // Mirror for left corners
      _ctx.save();
      _ctx.translate(W, 0);
      _ctx.scale(-1, 1);
      _drawCornerFoldRight(W, H, W - px, py, _can[drag.fromIdx], _can[drag.toIdx]);
      _ctx.restore();
    }
  }

  function _drawCornerFoldRight (W, H, px, py, fromCv, toCv) {
    /* The fold is a triangle whose hypotenuse goes from
       the right edge at some y (pY_edge) to the bottom edge at some x (pX_base).
       The fold amount is driven by how far left the pointer has moved. */

    // Map pointer x → fold progress (0 = no fold, 1 = full fold)
    const rawT = Math.max(0, Math.min(1, (W - px) / W * 1.8));
    if (rawT < 0.005) return; // nothing to draw yet

    // Triangle vertices
    const cornerX = W, cornerY = H;        // page corner
    const edgeY   = Math.max(H * 0.4, H - (W - px) * 1.5);  // right-edge lift point
    const baseX   = Math.max(W * 0.3,  W - (H - py) * 1.2); // bottom-edge fold point

    /* ── Destination page (only visible inside the fold triangle) ── */
    _ctx.save();
    _ctx.beginPath();
    _ctx.moveTo(W, edgeY);
    _ctx.lineTo(cornerX, cornerY);
    _ctx.lineTo(baseX,   H);
    _ctx.closePath();
    _ctx.clip();
    _ctx.drawImage(toCv, 0, 0, W, H);
    _ctx.restore();

    /* ── Folded leaf (triangle, mirrored fromCv) ─── */
    _ctx.save();
    _ctx.beginPath();
    _ctx.moveTo(W, edgeY);
    _ctx.lineTo(cornerX, cornerY);
    _ctx.lineTo(baseX, H);
    _ctx.closePath();
    _ctx.clip();

    // Reflect content inside the triangle
    _ctx.save();
    _ctx.translate(W, 0);
    _ctx.scale(-1, 1);
    _ctx.drawImage(fromCv, 0, 0, W, H);
    _ctx.restore();

    // Shade the fold
    const diag = Math.hypot(W - baseX, H - edgeY);
    const cg = _ctx.createLinearGradient(baseX, H, W, edgeY);
    cg.addColorStop(0,   'rgba(255,255,255,0.35)');
    cg.addColorStop(0.4, 'rgba(180,170,160,0.10)');
    cg.addColorStop(1,   'rgba(0,0,0,0.50)');
    _ctx.fillStyle = cg;
    _ctx.fill();
    _ctx.restore();

    /* ── Fold-line shadow on source page ─── */
    _ctx.save();
    _ctx.beginPath();
    _ctx.moveTo(W,    edgeY);
    _ctx.lineTo(baseX, H);
    _ctx.lineWidth   = 3;
    _ctx.strokeStyle = 'rgba(30,15,0,0.45)';
    _ctx.stroke();
    _ctx.restore();

    /* ── Crease highlight ─── */
    _ctx.save();
    _ctx.beginPath();
    _ctx.moveTo(W - 2,    edgeY);
    _ctx.lineTo(baseX - 2, H);
    _ctx.lineWidth   = 1.2;
    _ctx.strokeStyle = 'rgba(255,255,255,0.60)';
    _ctx.stroke();
    _ctx.restore();

    /* ── Shadow cast from fold onto source page ─── */
    const mid_x = (W + baseX) / 2;
    const mid_y = (edgeY + H) / 2;
    const sg = _ctx.createRadialGradient(mid_x, mid_y, 0, mid_x, mid_y, diag * 0.35);
    sg.addColorStop(0, 'rgba(0,0,0,0.22)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    _ctx.save();
    _ctx.beginPath();
    _ctx.rect(0, 0, W, H);
    _ctx.fillStyle = sg;
    _ctx.fill();
    _ctx.restore();
  }

  /* ════════════════════════════════════════════════════════════════
     AUTO-FLIP ANIMATION  (arrow / swipe / keyboard triggered)
  ════════════════════════════════════════════════════════════════ */

  function _autoFlip (fromIdx, toIdx, fwd) {
    if (_busy) return;
    _busy = true;

    // ★ Sound fires at the very first frame
    if (_onStart) _onStart();

    _showPage(fromIdx);
    _ov.style.display = 'block';
    _syncOv();

    const fromCv = _can[fromIdx];
    const toCv   = _can[toIdx];
    const t0     = performance.now();

    function tick (now) {
      const raw = Math.min((now - t0) / AUTO_MS, 1);
      const t   = _ease(raw);
      _render(t, fwd, fromCv, toCv);
      if (raw < 1) {
        requestAnimationFrame(tick);
      } else {
        _finish(toIdx);
      }
    }
    requestAnimationFrame(tick);
  }

  /* ════════════════════════════════════════════════════════════════
     DRAG-FLIP  (corner drag → follows pointer → auto-complete or snap-back)
  ════════════════════════════════════════════════════════════════ */

  /** Called every pointermove while dragging a corner */
  function _updateDragFrame () {
    if (!drag.live || _busy) return;
    _syncOv();
    _drawCornerFold(drag.curX, drag.curY, drag.corner);
  }

  /** Pointer released — decide: complete flip or snap back */
  function _releaseDrag () {
    if (!drag.live) return;
    drag.live   = false;
    drag.active = false;

    const W = _W();
    // How far has the user dragged? (fraction of page width)
    const progress = drag.dir === 1
      ? (drag.originX - drag.curX) / W
      : (drag.curX - drag.originX) / W;

    if (progress > 0.25 && !_busy) {
      // Enough drag → complete the flip
      _busy = true;
      if (!drag.soundFired && _onStart) { _onStart(); drag.soundFired = true; }

      const fromCv = _can[drag.fromIdx];
      const toCv   = _can[drag.toIdx];
      const fwd    = drag.dir === 1;
      const t0     = performance.now();
      const startT = progress; // start from where drag left off

      function tick (now) {
        const raw = Math.min(startT + (now - t0) / AUTO_MS * (1 - startT), 1);
        const t   = _ease(raw);
        _render(t, fwd, fromCv, toCv);
        if (raw < 1) {
          requestAnimationFrame(tick);
        } else {
          _finish(drag.toIdx);
        }
      }
      requestAnimationFrame(tick);

    } else {
      // Not enough drag → snap back
      const fromCv = _can[drag.fromIdx];
      const toCv   = _can[drag.toIdx];
      const fwd    = drag.dir === 1;
      const px0    = drag.curX, py0 = drag.curY;
      const t0     = performance.now();
      const corner = drag.corner;

      function snapTick (now) {
        const raw = Math.min((now - t0) / SNAPBACK_MS, 1);
        const et  = _easeOut(raw);
        // Animate pointer back to the original corner
        const W = _ov.width, H = _ov.height;
        const destX = corner.includes('r') ? W     : 0;
        const destY = corner.includes('b') ? H     : 0;
        const px = px0 + (destX - px0) * et;
        const py = py0 + (destY - py0) * et;
        _syncOv();
        if (raw < 0.92) {
          _drawCornerFold(px, py, corner);
          requestAnimationFrame(snapTick);
        } else {
          _ctx.clearRect(0, 0, _ov.width, _ov.height);
          _ov.style.display = 'none';
          _showPage(drag.fromIdx);
        }
      }
      _showPage(drag.fromIdx);
      requestAnimationFrame(snapTick);
    }
  }

  /** Finalise a completed flip */
  function _finish (toIdx) {
    _cur  = toIdx;
    _busy = false;
    _ctx.clearRect(0, 0, _ov.width, _ov.height);
    _ov.style.display = 'none';
    _showPage(_cur);
    _refreshArrows();
    if (_onChange) _onChange(_cur, _tot);
  }

  /* ════════════════════════════════════════════════════════════════
     HOVER CORNER PREVIEW  (desktop only)
  ════════════════════════════════════════════════════════════════ */

  let _hoverFrame = null;

  function _onHover (e) {
    if (_busy || drag.live) return;
    const p = _rel(e);
    const c = _cornerOf(p.x, p.y);

    if (!c) {
      if (_hoverFrame) {
        cancelAnimationFrame(_hoverFrame);
        _hoverFrame = null;
        _ctx.clearRect(0, 0, _ov.width, _ov.height);
        _ov.style.display = 'none';
      }
      _wrap.style.cursor = 'default';
      return;
    }

    // Which direction does this corner imply?
    const impliedDir = (c === 'br' || c === 'tr') ? 1 : -1;
    const wouldFlip  = (impliedDir === 1 && _cur < _tot - 1) ||
                       (impliedDir === -1 && _cur > 0);
    if (!wouldFlip) return;

    _wrap.style.cursor = 'pointer';
    _ov.style.display  = 'block';
    _syncOv();

    // Minimal hover fold at the corner
    const hoverToIdx = impliedDir === 1 ? _cur + 1 : _cur - 1;
    drag.fromIdx = _cur;
    drag.toIdx   = hoverToIdx;
    _drawCornerFold(p.x, p.y, c);
  }

  /* ════════════════════════════════════════════════════════════════
     POINTER DOWN  — start swipe or corner drag
  ════════════════════════════════════════════════════════════════ */

  function _onDown (e) {
    if (_busy) return;
    // Don't steal events from arrow buttons
    if (e.target === _arL || e.target === _arR) return;

    const p = _rel(e);
    drag.active     = true;
    drag.live       = false;
    drag.soundFired = false;
    drag.originX    = p.x;
    drag.originY    = p.y;
    drag.curX       = p.x;
    drag.curY       = p.y;
    drag.corner     = _cornerOf(p.x, p.y);

    if (drag.corner) {
      const impliedDir = (drag.corner === 'br' || drag.corner === 'tr') ? 1 : -1;
      const possible   = (impliedDir === 1 && _cur < _tot - 1) ||
                         (impliedDir === -1 && _cur > 0);
      if (possible) {
        drag.dir     = impliedDir;
        drag.fromIdx = _cur;
        drag.toIdx   = impliedDir === 1 ? _cur + 1 : _cur - 1;
        drag.live    = true;
        _ov.style.display = 'block';
        _syncOv();
      }
    }
  }

  /* ════════════════════════════════════════════════════════════════
     POINTER MOVE
  ════════════════════════════════════════════════════════════════ */

  function _onMove (e) {
    const p = _rel(e);
    if (drag.live && !_busy) {
      drag.curX = p.x;
      drag.curY = p.y;
      // Sound on first significant drag movement
      if (!drag.soundFired && Math.abs(p.x - drag.originX) > 15) {
        if (_onStart) _onStart();
        drag.soundFired = true;
      }
      _syncOv();
      _drawCornerFold(drag.curX, drag.curY, drag.corner);
    } else if (!drag.active && !_busy) {
      _onHover(e);  // desktop hover preview
    }
  }

  /* ════════════════════════════════════════════════════════════════
     POINTER UP
  ════════════════════════════════════════════════════════════════ */

  function _onUp (e) {
    if (!drag.active) return;

    if (drag.live) {
      _releaseDrag();
      return;
    }

    // Treat as a swipe if not a corner drag
    const p  = _rel(e);
    const dx = p.x - drag.originX;
    const dy = p.y - drag.originY;

    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy) * 1.4) {
      if (dx < 0) _go(_cur + 1, true);
      else        _go(_cur - 1, false);
    }

    drag.active = false;
    drag.live   = false;
  }

  /* ════════════════════════════════════════════════════════════════
     NAVIGATION (public-facing wrappers)
  ════════════════════════════════════════════════════════════════ */

  function _go (idx, fwd) {
    if (idx < 0 || idx >= _tot || idx === _cur) return;
    _autoFlip(_cur, idx, fwd);
  }

  function next  () { _go(_cur + 1, true);  }
  function prev  () { _go(_cur - 1, false); }
  function first () { _go(0, false); }
  function last  () { _go(_tot - 1, true); }

  function goTo (idx, skip = false) {
    if (idx < 0 || idx >= _tot || idx === _cur) return;
    if (skip) {
      _cur = idx;
      _showPage(_cur);
      _refreshArrows();
      if (_onChange) _onChange(_cur, _tot);
    } else {
      _go(idx, idx > _cur);
    }
  }

  /* ════════════════════════════════════════════════════════════════
     KEYBOARD
  ════════════════════════════════════════════════════════════════ */

  function _onKey (e) {
    const map = {
      ArrowRight: next, ArrowDown: next, PageDown: next, ' ': next,
      ArrowLeft: prev,  ArrowUp: prev,   PageUp: prev,
      Home: first, End: last,
    };
    if (map[e.key]) { e.preventDefault(); map[e.key](); }
  }

  /* ════════════════════════════════════════════════════════════════
     INIT
  ════════════════════════════════════════════════════════════════ */

  function init (canvases, container, onChange, onStart) {
    _can      = canvases;
    _wrap     = container;
    _tot      = canvases.length;
    _cur      = 0;
    _onChange = onChange;
    _onStart  = onStart;

    // Build page divs
    _pages = canvases.map((cv, i) => {
      const d = document.createElement('div');
      d.className     = 'fb-page';
      d.style.display = i === 0 ? 'block' : 'none';
      d.appendChild(cv);
      container.appendChild(d);
      return d;
    });

    // Overlay canvas
    _ov = document.createElement('canvas');
    _ov.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:20;display:none;';
    container.appendChild(_ov);
    _ctx = _ov.getContext('2d');

    // Arrows (z:50 — above everything)
    _buildArrows();

    // Pointer events on container
    container.addEventListener('mousedown',  _onDown, { passive: true });
    container.addEventListener('touchstart', _onDown, { passive: true });
    document.addEventListener('mousemove',   _onMove, { passive: true });
    document.addEventListener('touchmove',   _onMove, { passive: true });
    document.addEventListener('mouseup',     _onUp);
    document.addEventListener('touchend',    _onUp,  { passive: false });
    document.addEventListener('keydown',     _onKey);

    // Resize: re-sync overlay dimensions
    window.addEventListener('resize', () => { if (_ov.style.display !== 'none') _syncOv(); });

    if (_onChange) _onChange(0, _tot);
  }

  /* ════════════════════════════════════════════════════════════════
     PUBLIC API
  ════════════════════════════════════════════════════════════════ */
  return {
    init, next, prev, first, last, goTo,
    get currentPage () { return _cur; },
    get totalPages  () { return _tot; },
  };

})();
