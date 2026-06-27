/**
 * pdf-loader.js
 * ─────────────────────────────────────────────────────────────────────
 * Loads a PDF via PDF.js, renders every page onto an offscreen canvas
 * at high DPI and returns the canvases for the flipbook to consume.
 *
 * Public API
 *   PDFLoader.load(url, callbacks) → Promise<PDFLoadResult>
 *
 * callbacks:
 *   onProgress(pct, statusText)   – called during rendering
 *   onError(err)                  – called on fatal error
 * ─────────────────────────────────────────────────────────────────────
 */

const PDFLoader = (() => {

  // ── Configuration ───────────────────────────────────────────────
  const SCALE_FACTOR  = 3.0;   // 3× upscale for Retina / sharp text
  const WORKER_PATH   = './libraries/pdf.worker.min.js';
  const PDF_PATH      = './pdf/newsletter.pdf';

  // ── Initialise PDF.js worker ────────────────────────────────────
  function initWorker () {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF.js library not found. Make sure pdf.min.js is loaded.');
    }
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_PATH;
  }

  /**
   * Renders a single PDF page to an offscreen HTMLCanvasElement.
   * @param {PDFPageProxy} pdfPage
   * @returns {HTMLCanvasElement}
   */
  async function renderPage (pdfPage) {
    const viewport = pdfPage.getViewport({ scale: SCALE_FACTOR });

    const canvas  = document.createElement('canvas');
    canvas.width  = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    const ctx = canvas.getContext('2d');

    await pdfPage.render({
      canvasContext: ctx,
      viewport,
      intent: 'display',
    }).promise;

    return canvas;
  }

  /**
   * Main loader.  Resolves with an array of rendered canvases.
   *
   * @param {Object}   opts
   * @param {string}   opts.url          – PDF URL (defaults to PDF_PATH)
   * @param {Function} opts.onProgress   – (pct: 0-100, label: string) => void
   * @param {Function} opts.onError      – (Error) => void
   * @returns {Promise<{ canvases: HTMLCanvasElement[], pageCount: number,
   *                     pageWidth: number, pageHeight: number }>}
   */
  async function load ({ url = PDF_PATH, onProgress, onError } = {}) {

    try {
      initWorker();

      onProgress && onProgress(2, 'Fetching PDF…');

      // Load the PDF document
      const loadingTask = pdfjsLib.getDocument({
        url,
        cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/cmaps/',
        cMapPacked: true,
      });

      // Optional: hook into the PDF.js download-progress event
      loadingTask.onProgress = ({ loaded, total }) => {
        if (total) {
          const dlPct = Math.round((loaded / total) * 30); // 0-30 %
          onProgress && onProgress(dlPct, 'Downloading PDF…');
        }
      };

      const pdfDoc = await loadingTask.promise;
      const pageCount = pdfDoc.numPages;

      onProgress && onProgress(32, `PDF loaded — ${pageCount} pages detected`);

      // ── Render every page ──────────────────────────────────────
      const canvases = new Array(pageCount);
      let   pageWidth  = 0;
      let   pageHeight = 0;

      for (let i = 1; i <= pageCount; i++) {
        const pdfPage = await pdfDoc.getPage(i);

        // Capture dimensions from the first page (all pages assumed same size)
        if (i === 1) {
          const vp = pdfPage.getViewport({ scale: 1 });
          pageWidth  = vp.width;
          pageHeight = vp.height;
        }

        canvases[i - 1] = await renderPage(pdfPage);

        // Progress from 32 % → 98 % over the rendering phase
        const renderPct = 32 + Math.round(((i) / pageCount) * 66);
        onProgress && onProgress(
          renderPct,
          `Rendering page ${i} of ${pageCount}…`
        );
      }

      onProgress && onProgress(100, 'Ready!');

      return { canvases, pageCount, pageWidth, pageHeight };

    } catch (err) {
      console.error('[PDFLoader] Fatal error:', err);
      onError && onError(err);
      // Do NOT rethrow — onError already handled the UI; rethrowing
      // causes app.js to catch it a second time and crash on a hidden DOM.
      return null;
    }
  }

  return { load, PDF_PATH };

})();
