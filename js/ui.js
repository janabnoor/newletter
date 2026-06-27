/**
 * ui.js  v4
 * ─────────────────────────────────────────────────────────────────────
 * Controls, bars, progress, sound, resize.
 *
 * KEY CHANGE:  playFlipSound() is exposed as onFlipStart() so that
 *              Flipbook can call it the INSTANT animation begins —
 *              not after it ends.
 * ─────────────────────────────────────────────────────────────────────
 */

const UI = (() => {

  const $ = id => document.getElementById(id);

  /* ── Cached DOM refs ──────────────────────────────────────────── */
  const el = {
    loadingScreen : $('loading-screen'),
    errorScreen   : $('error-screen'),
    errorMsg      : $('error-message'),
    flipStage     : $('flipbook-stage'),
    topBar        : $('top-bar'),
    bottomBar     : $('bottom-bar'),
    pageCounter   : $('page-counter'),
    pageJumpInput : $('page-jump-input'),
    pageJumpTotal : $('page-jump-total'),
    pageJumpGo    : $('page-jump-go'),
    btnFirst      : $('btn-first'),
    btnPrev       : $('btn-prev'),
    btnNext       : $('btn-next'),
    btnLast       : $('btn-last'),
    viewport      : $('flipbook-viewport'),
    container     : $('flipbook-container'),
    flipSound     : $('flip-sound'),
    progressBar   : $('progress-bar'),
    loaderStatus  : $('loader-status'),
    progressLabel : $('progress-label'),
    bookTitle     : $('book-title'),
  };

  /* ── Auto-hide bars ───────────────────────────────────────────── */
  let _hideTimer  = null;
  const HIDE_MS   = 3500;

  function _showBars () {
    el.topBar.classList.remove('ui-hidden');
    el.bottomBar.classList.remove('ui-hidden');
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(_hideBars, HIDE_MS);
  }
  function _hideBars () {
    el.topBar.classList.add('ui-hidden');
    el.bottomBar.classList.add('ui-hidden');
  }

  /* ── Loading progress ─────────────────────────────────────────── */
  function setProgress (pct, label) {
    el.progressBar.style.width   = `${Math.min(pct, 100)}%`;
    el.progressLabel.textContent = `${Math.round(pct)}%`;
    if (label) el.loaderStatus.textContent = label;
  }

  function showError (message) {
    el.loadingScreen.classList.add('hidden');
    if (message) el.errorMsg.textContent = message;
    el.errorScreen.classList.remove('hidden');
  }

  /* ── Container sizing ─────────────────────────────────────────── */
  let _pw = 0, _ph = 0;

  function sizeContainer (pageWidth, pageHeight) {
    // Give 70 px horizontal breathing room for the arrows
    const vpW = el.viewport.clientWidth  - 70;
    const vpH = el.viewport.clientHeight - 12;
    if (vpW <= 0 || vpH <= 0) return;

    const aspect   = pageWidth / pageHeight;
    const vpAspect = vpW / vpH;

    let w, h;
    if (aspect > vpAspect) { w = vpW; h = vpW / aspect; }
    else                   { h = vpH; w = vpH * aspect; }

    el.container.style.width  = `${Math.floor(w)}px`;
    el.container.style.height = `${Math.floor(h)}px`;
  }

  /* ── Sound — called AT animation start, not end ───────────────── */
  function onFlipStart () {
    try {
      el.flipSound.currentTime = 0;
      el.flipSound.play().catch(() => {});
    } catch (_) {}
  }

  /* ── Page-change — called AFTER animation ends ────────────────── */
  function onPageChange (current, total) {
    const pg = current + 1;
    el.pageCounter.textContent   = `${pg} / ${total}`;
    el.pageJumpInput.value       = pg;
    el.pageJumpTotal.textContent = `/ ${total}`;
    el.pageJumpInput.max         = total;

    el.btnFirst.disabled = current === 0;
    el.btnPrev.disabled  = current === 0;
    el.btnNext.disabled  = current === total - 1;
    el.btnLast.disabled  = current === total - 1;

    _showBars();
  }

  /* ── Wire bottom-bar controls ─────────────────────────────────── */
  function _bindControls () {
    // Helper: bind both click and touchend for maximum mobile compat
    function on (btn, fn) {
      btn.addEventListener('click', e => { e.stopPropagation(); fn(); });
      btn.addEventListener('touchend', e => {
        e.stopPropagation();
        e.preventDefault();
        fn();
      }, { passive: false });
      btn.addEventListener('touchstart', e => {
        e.stopPropagation();
      }, { passive: false });
    }

    on(el.btnFirst, () => Flipbook.first());
    on(el.btnPrev,  () => Flipbook.prev());
    on(el.btnNext,  () => Flipbook.next());
    on(el.btnLast,  () => Flipbook.last());
    on(el.pageJumpGo, _doJump);

    el.pageJumpInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') _doJump();
    });

    // Activity → show bars
    ['mousemove','touchstart','keydown'].forEach(ev =>
      document.addEventListener(ev, _showBars, { passive: true })
    );

    // Resize / orientation
    let _rt = null;
    const _resize = () => {
      clearTimeout(_rt);
      _rt = setTimeout(() => sizeContainer(_pw, _ph), 150);
    };
    window.addEventListener('resize', _resize);
    if (screen.orientation) {
      screen.orientation.addEventListener('change', () => setTimeout(_resize, 250));
    }
    window.addEventListener('orientationchange', () => setTimeout(_resize, 300));
  }

  function _doJump () {
    const v = parseInt(el.pageJumpInput.value, 10);
    if (!isNaN(v)) Flipbook.goTo(v - 1);
  }

  /* ── Reveal flipbook ──────────────────────────────────────────── */
  function showFlipbook (pageWidth, pageHeight, title = 'Newsletter') {
    _pw = pageWidth; _ph = pageHeight;
    el.bookTitle.textContent = title;
    el.loadingScreen.classList.add('hidden');
    el.flipStage.classList.remove('hidden');
    sizeContainer(pageWidth, pageHeight);
    _bindControls();
    _showBars();
  }

  /* ── Public ───────────────────────────────────────────────────── */
  return {
    setProgress,
    showError,
    showFlipbook,
    onPageChange,
    onFlipStart,
    sizeContainer,
    get container () { return el.container; },
  };

})();
