/**
 * app.js  v4
 * ─────────────────────────────────────────────────────────────────────
 * Orchestrates: PDF load → UI reveal → Flipbook init
 *
 * Flipbook.init() now receives 4 args:
 *   canvases, container, onPageChange, onFlipStart
 *
 * onFlipStart fires at animation START  → sound syncs with visual
 * onPageChange fires at animation END   → UI counters update
 * ─────────────────────────────────────────────────────────────────────
 */

(async function main () {

  if (typeof PDFLoader === 'undefined' ||
      typeof Flipbook  === 'undefined' ||
      typeof UI        === 'undefined') {
    console.error('[App] Module(s) missing — check script tags in index.html');
    return;
  }

  try {
    /* 1. Load & render PDF */
    const result = await PDFLoader.load({
      url: PDFLoader.PDF_PATH,
      onProgress (pct, label) { UI.setProgress(pct, label); },
      onError    (err)        {
        UI.showError(
          `Could not load the PDF: ${err.message || err}.  ` +
          `Make sure ./pdf/newsletter.pdf exists on the server and ` +
          `you are accessing the page through a web server (not file://).`
        );
      },
    });

    if (!result) return; // onError already handled the UI

    const { canvases, pageCount, pageWidth, pageHeight } = result;
    if (!canvases || canvases.length === 0) throw new Error('No pages rendered.');

    /* 2. Show the flipbook shell */
    UI.showFlipbook(pageWidth, pageHeight, 'Newsletter');

    /* 3. Initialise engine
          4th arg = onFlipStart → sound plays WHEN animation begins   */
    Flipbook.init(
      canvases,
      UI.container,
      (cur, tot) => UI.onPageChange(cur, tot),   // fires after flip
      ()         => UI.onFlipStart()             // fires AT flip start ← SOUND
    );

    console.log(`[App] Ready — ${pageCount} page(s) loaded.`);

  } catch (err) {
    console.error('[App]', err);
  }

})();
