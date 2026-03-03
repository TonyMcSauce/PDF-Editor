/**
 * PDF Studio v5
 *
 * Architecture change: we no longer use pdf-lib to LOAD existing PDFs.
 * pdf-lib 1.17.1 cannot parse many real-world PDFs (Canva, Figma, Word exports, etc.)
 *
 * New approach:
 *   - PDF.js renders every page to a canvas (works on all PDFs)
 *   - We capture each canvas as a PNG image
 *   - pdf-lib creates a BRAND NEW document and embeds those images as pages
 *   - This completely bypasses pdf-lib's broken PDF parser
 *
 * Trade-off: text is rasterised (not selectable in output), but ALL operations
 * work on ALL PDFs. For a browser-only tool this is the only reliable approach.
 *
 * Operations supported:
 *   Upload, Preview, Merge, Split, Delete pages, Reorder, Rotate,
 *   Add text overlay, Add image overlay, Signature, Download
 */
'use strict';

/* ── CONFIG ───────────────────────────────────────── */
const CFG = {
  MAX_MB:        100,
  WORKER:        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  RENDER_SCALE:  2.0,    // scale for rasterising pages (higher = better quality)
  PREVIEW_SCALE: 1.4,
  THUMB_SCALE:   0.28,
  ZOOM_STEP:     0.25,
  ZOOM_MIN:      0.5,
  ZOOM_MAX:      3.0,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = CFG.WORKER;

/* ── STATE ────────────────────────────────────────── */
const S = {
  // Each loaded "source" PDF is stored as a pdfjsLib document
  // Pages are represented as { srcDoc, srcPageNum (1-based), rotation, overlays[] }
  pages:       [],   // array of page descriptors in current order
  pdfJsDoc:    null, // the currently previewed/main PDF.js doc
  rawBytesMap: new Map(), // docId -> Uint8Array (for merge sources)

  totalPages:  0,
  curPage:     1,
  zoom:        1.0,
  isDark:      true,
  selectedPgs: new Set(),

  // Merge
  mergeSources: [], // [{ name, pdfJsDoc, file }]

  // Sig
  sigDrawing: false,
  placeMode:  null,
};

/* ── DOM ──────────────────────────────────────────── */
const $    = id => document.getElementById(id);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function toast(msg, type = 'info', ms = 4500) {
  const t = $('toast');
  t.textContent = msg;
  t.className   = `toast ${type}`;
  show(t);
  clearTimeout(t._t);
  t._t = setTimeout(() => hide(t), ms);
}

function loading(on, txt = 'Processing…') {
  $('loadingText').textContent = txt;
  on ? show($('loadingOverlay')) : hide($('loadingOverlay'));
}

function fmtSize(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function okSize(f) {
  if (f.size / 1048576 > CFG.MAX_MB) {
    toast(`File too large (${fmtSize(f.size)}). Max ${CFG.MAX_MB} MB.`, 'error');
    return false;
  }
  return true;
}
function okPage(n) {
  if (!Number.isFinite(n) || n < 1 || n > S.totalPages) {
    toast(`Page must be 1–${S.totalPages}.`, 'error'); return false;
  }
  return true;
}
window.togglePwd = id => {
  const el = $(id); el.type = el.type === 'password' ? 'text' : 'password';
};

/* ── THEME ────────────────────────────────────────── */
$('themeToggle').addEventListener('click', () => {
  S.isDark = !S.isDark;
  document.documentElement.setAttribute('data-theme', S.isDark ? 'dark' : 'light');
  $('themeToggle').innerHTML = S.isDark
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
});

/* ── PANEL NAV ────────────────────────────────────── */
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $(`panel-${btn.dataset.panel}`).classList.add('active');
    if (btn.dataset.panel === 'pages' && S.pages.length) renderGrid();
    if (btn.dataset.panel === 'merge') refreshMergePreview();
  });
});

/* ── LOAD PDF ─────────────────────────────────────── */

/**
 * Load a PDF file via PDF.js (works on ALL PDFs).
 * Returns { pdfJsDoc, numPages }
 */
async function loadPdfJs(bytes) {
  const doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
  return doc;
}

/**
 * Build S.pages from a PDF.js doc.
 * Each entry: { pdfJsDoc, pageNum (1-based), rotation: 0, overlays: [] }
 */
function buildPages(pdfJsDoc) {
  S.pdfJsDoc   = pdfJsDoc;
  S.totalPages = pdfJsDoc.numPages;
  S.pages = Array.from({ length: S.totalPages }, (_, i) => ({
    pdfJsDoc,
    pageNum:  i + 1,
    rotation: 0,
    overlays: [],   // { type:'text'|'image'|'signature', ...params }
  }));
  S.curPage = 1;
  S.selectedPgs.clear();
}

async function handleFileUpload(file) {
  if (!file || file.type !== 'application/pdf') {
    toast('Please select a valid PDF file.', 'error'); return;
  }
  if (!okSize(file)) return;
  loading(true, 'Loading PDF…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc   = await loadPdfJs(bytes);
    buildPages(doc);
    $('fileName').textContent = file.name;
    $('fileSize').textContent  = `${fmtSize(file.size)} · ${S.totalPages} pages`;
    hide($('dropZone')); show($('fileInfo'));
    enableBtns(true);
    updateSplitHint();
    await previewMain(1);
    toast(`Loaded "${file.name}" — ${S.totalPages} pages`, 'success');
  } catch (e) {
    console.error('Upload error:', e);
    toast(`Load failed: ${e.message}`, 'error');
  } finally { loading(false); }
}

function enableBtns(on) {
  ['downloadBtn','splitBtn','addTextBtn','addImageBtn','addSigBtn','applyPwdBtn','zoomIn','zoomOut']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  updateNav();
}

const dz = $('dropZone');
$('fileInput').addEventListener('change', e => { if (e.target.files[0]) handleFileUpload(e.target.files[0]); });
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop',     e => { if (e.target !== dz) e.preventDefault(); });

$('clearFile').addEventListener('click', () => {
  S.pages = []; S.pdfJsDoc = null; S.totalPages = 0; S.curPage = 1;
  S.selectedPgs.clear();
  show($('dropZone')); hide($('fileInfo'));
  $('fileInput').value = '';
  $('pageIndicator').textContent = '— / —';
  hide($('previewCanvas')); show($('previewPlaceholder'));
  $('pageGrid').innerHTML = '<p class="hint center">Upload a PDF to manage pages.</p>';
  clearOverlay(); enableBtns(false);
});

/* ── MAIN PREVIEW ─────────────────────────────────── */

/**
 * Render a page descriptor to the preview canvas using PDF.js.
 * Applies any rotation stored in the descriptor.
 */
async function previewMain(pg) {
  if (!S.pages.length) return;
  pg = Math.max(1, Math.min(pg ?? S.curPage, S.totalPages));
  S.curPage = pg;

  const desc    = S.pages[pg - 1];
  const pdfPage = await desc.pdfJsDoc.getPage(desc.pageNum);
  const baseVp  = pdfPage.getViewport({ scale: 1 });
  const rotation = (baseVp.rotation + desc.rotation) % 360;
  const vp      = pdfPage.getViewport({ scale: CFG.PREVIEW_SCALE * S.zoom, rotation });

  const cv  = $('previewCanvas');
  cv.width  = vp.width;
  cv.height = vp.height;
  show(cv); hide($('previewPlaceholder'));
  await pdfPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;

  // Draw any overlays on top
  drawOverlaysOnCanvas(cv, desc.overlays, vp);

  updateNav();
  const ov = $('placementOverlay');
  if (ov) { ov.width = cv.width; ov.height = cv.height; }
}

/**
 * Draw overlay items (text/image) on a canvas context.
 * The viewport tells us the scale so we position correctly.
 */
function drawOverlaysOnCanvas(canvas, overlays, viewport) {
  if (!overlays || !overlays.length) return;
  const ctx   = canvas.getContext('2d');
  const scale = viewport.scale;
  overlays.forEach(o => {
    if (o.type === 'text') {
      ctx.save();
      ctx.font      = `${o.size * scale}px ${o.font || 'Arial'}`;
      ctx.fillStyle = o.color || '#000';
      // o.x, o.y are in PDF points from top-left
      ctx.fillText(o.text, o.x * scale, o.y * scale + o.size * scale);
      ctx.restore();
    } else if (o.type === 'image' || o.type === 'signature') {
      if (!o.imgEl) return;
      ctx.drawImage(o.imgEl, o.x * scale, o.y * scale, o.w * scale, o.h * scale);
    }
  });
}

function updateNav() {
  $('pageIndicator').textContent = S.totalPages ? `${S.curPage} / ${S.totalPages}` : '— / —';
  $('prevPage').disabled = !S.totalPages || S.curPage <= 1;
  $('nextPage').disabled = !S.totalPages || S.curPage >= S.totalPages;
}
$('prevPage').addEventListener('click', () => previewMain(S.curPage - 1));
$('nextPage').addEventListener('click', () => previewMain(S.curPage + 1));
$('zoomIn').addEventListener('click', () => {
  S.zoom = Math.min(CFG.ZOOM_MAX, +(S.zoom + CFG.ZOOM_STEP).toFixed(2));
  $('zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  previewMain();
});
$('zoomOut').addEventListener('click', () => {
  S.zoom = Math.max(CFG.ZOOM_MIN, +(S.zoom - CFG.ZOOM_STEP).toFixed(2));
  $('zoomLabel').textContent = Math.round(S.zoom * 100) + '%';
  previewMain();
});

/* ── PLACEMENT OVERLAY ────────────────────────────── */
function clearOverlay() {
  const ov = $('placementOverlay');
  if (!ov) return;
  ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  ov.style.pointerEvents = 'none';
  $('previewWrap').classList.remove('placement-active');
}

$('placementOverlay').addEventListener('click', e => {
  if (!S.placeMode) return;
  const ov   = $('placementOverlay');
  const rect = ov.getBoundingClientRect();
  const cx   = (e.clientX - rect.left) * (ov.width  / rect.width);
  const cy   = (e.clientY - rect.top)  * (ov.height / rect.height);
  const sc   = CFG.PREVIEW_SCALE * S.zoom;
  const px   = Math.round(cx / sc);
  const py   = Math.round(cy / sc);

  if (S.placeMode === 'text')      { $('textX').value = px; $('textY').value = py; }
  if (S.placeMode === 'image')     { $('imgX').value  = px; $('imgY').value  = py; }
  if (S.placeMode === 'signature') { $('sigX').value  = px; $('sigY').value  = py; }

  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.width, ov.height);
  ctx.strokeStyle = '#4f8ef7'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(ov.width, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, ov.height); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#4f8ef7';
  ctx.beginPath(); ctx.arc(cx, cy, 5, 0, Math.PI * 2); ctx.fill();
  ctx.font = 'bold 11px monospace'; ctx.fillText(`(${px}, ${py})`, cx + 8, cy - 5);
  toast(`Position → X:${px}  Y:${py}`, 'success', 2000);
});

function setPlaceMode(mode, btnId) {
  S.placeMode = (S.placeMode === mode) ? null : mode;
  ['textPickBtn','imgPickBtn','sigPickBtn'].forEach(id => {
    const b = $(id); if (!b) return;
    b.classList.remove('active-pick');
    b.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Pick on Page';
  });
  const ov = $('placementOverlay');
  if (S.placeMode) {
    ov.style.pointerEvents = 'all';
    $('previewWrap').classList.add('placement-active');
    const b = $(btnId);
    if (b) { b.classList.add('active-pick'); b.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel'; }
    toast('Click on the preview to set position.', 'info', 3000);
  } else {
    clearOverlay();
  }
}
$('textPickBtn').addEventListener('click', () => setPlaceMode('text',      'textPickBtn'));
$('imgPickBtn' ).addEventListener('click', () => setPlaceMode('image',     'imgPickBtn'));
$('sigPickBtn' ).addEventListener('click', () => setPlaceMode('signature', 'sigPickBtn'));

/* ── CORE: RENDER PAGE TO IMAGE ───────────────────────
 * This is the key function. We use PDF.js to render a page
 * descriptor to an offscreen canvas, then export as PNG.
 * pdf-lib then embeds that PNG — zero parsing of original PDF.
 ─────────────────────────────────────────────────────── */
async function renderPageToCanvas(desc, scale) {
  const pdfPage = await desc.pdfJsDoc.getPage(desc.pageNum);
  const baseVp  = pdfPage.getViewport({ scale: 1 });
  const rotation = (baseVp.rotation + desc.rotation) % 360;
  const vp      = pdfPage.getViewport({ scale, rotation });

  const offscreen = document.createElement('canvas');
  offscreen.width  = Math.ceil(vp.width);
  offscreen.height = Math.ceil(vp.height);
  const ctx = offscreen.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, offscreen.width, offscreen.height);

  await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;

  // Draw any overlays
  drawOverlaysOnCanvas(offscreen, desc.overlays, vp);

  return offscreen;
}

/**
 * Build a complete PDF from S.pages (or a subset).
 * Each page is rendered via PDF.js → canvas → PNG → embedded in new pdf-lib doc.
 * Returns Uint8Array.
 */
async function buildPdf(pageDescriptors) {
  const doc = await PDFLib.PDFDocument.create();

  for (let i = 0; i < pageDescriptors.length; i++) {
    const desc = pageDescriptors[i];
    loading(true, `Building PDF… page ${i + 1} of ${pageDescriptors.length}`);

    const canvas  = await renderPageToCanvas(desc, CFG.RENDER_SCALE);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    const imgBytes = dataUrlToBytes(dataUrl);
    const img      = await doc.embedJpg(imgBytes);

    // Page size in points (1 point = 1/72 inch; canvas pixels at RENDER_SCALE)
    const wPt = canvas.width  / CFG.RENDER_SCALE * (72 / 96); // 96dpi screen → 72dpi PDF
    const hPt = canvas.height / CFG.RENDER_SCALE * (72 / 96);

    // Actually simpler: use pixel dimensions directly — PDF.js gives us points
    // Let's use the viewport from PDF.js to get exact point dimensions
    const pdfPage  = await desc.pdfJsDoc.getPage(desc.pageNum);
    const baseVp   = pdfPage.getViewport({ scale: 1 });
    const rotation  = (baseVp.rotation + desc.rotation) % 360;
    const vp1      = pdfPage.getViewport({ scale: 1, rotation });
    const wPoints  = vp1.width;   // already in points at scale=1
    const hPoints  = vp1.height;

    const page = doc.addPage([wPoints, hPoints]);
    page.drawImage(img, { x: 0, y: 0, width: wPoints, height: hPoints });
  }

  return doc.save();
}

/* ── MERGE ────────────────────────────────────────── */
async function addMergeFiles(files) {
  loading(true, 'Loading files…');
  try {
    for (const f of Array.from(files)) {
      if (f.type !== 'application/pdf') { toast(`Not a PDF: ${f.name}`, 'error'); continue; }
      if (!okSize(f)) continue;
      const bytes  = new Uint8Array(await f.arrayBuffer());
      const jsDoc  = await loadPdfJs(bytes);
      S.mergeSources.push({ name: f.name, file: f, pdfJsDoc: jsDoc, curPage: 1 });
    }
    refreshMergeList();
    if (S.mergeSources.length) await refreshMergePreview();
  } catch (e) {
    console.error('addMergeFiles:', e);
    toast(`Error: ${e.message}`, 'error');
  } finally { loading(false); }
}

function refreshMergeList() {
  const list = $('mergeList');
  list.innerHTML = '';
  S.mergeSources.forEach((src, i) => {
    const li = document.createElement('li');
    li.className = 'merge-item' + (i === (S._mergeViewIdx ?? 0) ? ' merge-item-active' : '');
    li.innerHTML = `
      <i class="fa-solid fa-file-pdf"></i>
      <span class="merge-item-name" title="${src.name}">${src.name}</span>
      <small class="merge-item-size">${src.pdfJsDoc.numPages}p</small>
      <button class="icon-btn" onclick="viewMergeDoc(${i})" title="Preview"><i class="fa-solid fa-eye"></i></button>
      <button class="icon-btn danger" onclick="removeMergeDoc(${i})" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(li);
  });
  $('mergeBtn').disabled = S.mergeSources.length < 2;
  updateMergeNav();
}

function updateMergeNav() {
  const idx  = S._mergeViewIdx ?? 0;
  const src  = S.mergeSources[idx];
  const total = S.mergeSources.length;
  const pg   = src ? src.curPage : 0;
  const pgs  = src ? src.pdfJsDoc.numPages : 0;
  $('mergeDocLabel').textContent = total
    ? `${src.name.slice(0,20)} — Page ${pg}/${pgs}`
    : 'No PDFs added';
  $('mergePrevDoc').disabled = idx <= 0;
  $('mergeNextDoc').disabled = idx >= total - 1;
  $('mergePrevPg').disabled  = !src || pg <= 1;
  $('mergeNextPg').disabled  = !src || pg >= pgs;
}

window.viewMergeDoc = i => {
  S._mergeViewIdx = i;
  S.mergeSources[i].curPage = 1;
  refreshMergeList(); refreshMergePreview();
};
window.removeMergeDoc = i => {
  S.mergeSources.splice(i, 1);
  S._mergeViewIdx = Math.max(0, Math.min(S._mergeViewIdx ?? 0, S.mergeSources.length - 1));
  refreshMergeList(); refreshMergePreview();
};

async function refreshMergePreview() {
  const cv = $('mergePreviewCanvas');
  const ph = $('mergePreviewPlaceholder');
  const idx = S._mergeViewIdx ?? 0;
  const src = S.mergeSources[idx];
  if (!src) { hide(cv); show(ph); return; }
  src.curPage = Math.max(1, Math.min(src.curPage, src.pdfJsDoc.numPages));
  const pdfPage = await src.pdfJsDoc.getPage(src.curPage);
  const vp      = pdfPage.getViewport({ scale: CFG.PREVIEW_SCALE });
  cv.width = vp.width; cv.height = vp.height;
  show(cv); hide(ph);
  await pdfPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  updateMergeNav();
}

$('mergeInput').addEventListener('change', async e => { await addMergeFiles(e.target.files); e.target.value = ''; });
const mdz = $('mergeDropZone');
mdz.addEventListener('dragover',  e => { e.preventDefault(); mdz.classList.add('drag-over'); });
mdz.addEventListener('dragleave', () => mdz.classList.remove('drag-over'));
mdz.addEventListener('drop', async e => { e.preventDefault(); mdz.classList.remove('drag-over'); await addMergeFiles(e.dataTransfer.files); });

$('mergePrevDoc').addEventListener('click', () => { S._mergeViewIdx = Math.max(0, (S._mergeViewIdx??0)-1); S.mergeSources[S._mergeViewIdx].curPage=1; refreshMergeList(); refreshMergePreview(); });
$('mergeNextDoc').addEventListener('click', () => { S._mergeViewIdx = Math.min(S.mergeSources.length-1, (S._mergeViewIdx??0)+1); S.mergeSources[S._mergeViewIdx].curPage=1; refreshMergeList(); refreshMergePreview(); });
$('mergePrevPg').addEventListener('click', () => { const src=S.mergeSources[S._mergeViewIdx??0]; if(src){src.curPage--; refreshMergePreview();} });
$('mergeNextPg').addEventListener('click', () => { const src=S.mergeSources[S._mergeViewIdx??0]; if(src){src.curPage++; refreshMergePreview();} });

$('mergeBtn').addEventListener('click', async () => {
  if (S.mergeSources.length < 2) return;
  loading(true, 'Merging…');
  try {
    // Build page descriptors from all merge sources in order
    const allDescs = [];
    for (const src of S.mergeSources) {
      for (let p = 1; p <= src.pdfJsDoc.numPages; p++) {
        allDescs.push({ pdfJsDoc: src.pdfJsDoc, pageNum: p, rotation: 0, overlays: [] });
      }
    }
    const bytes = await buildPdf(allDescs);
    dlBytes(bytes, 'merged.pdf');
    toast(`Merged ${S.mergeSources.length} PDFs (${allDescs.length} pages total)!`, 'success');
  } catch (e) {
    console.error('merge error:', e);
    toast(`Merge failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ── SPLIT ────────────────────────────────────────── */
function updateSplitHint() {
  $('splitPageCount').textContent = S.totalPages ? `Document has ${S.totalPages} pages` : '';
  if (S.totalPages) { $('splitTo').value = S.totalPages; $('splitFrom').max = $('splitTo').max = S.totalPages; }
}

$('splitBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  const from = parseInt($('splitFrom').value, 10);
  const to   = parseInt($('splitTo').value,   10);
  if (!Number.isFinite(from)||!Number.isFinite(to)||from<1||to>S.totalPages||from>to) {
    toast('Invalid page range.', 'error'); return;
  }
  loading(true, 'Splitting…');
  try {
    const descs = S.pages.slice(from - 1, to);
    const bytes = await buildPdf(descs);
    dlBytes(bytes, `pages_${from}-${to}.pdf`);
    toast(`Pages ${from}–${to} extracted!`, 'success');
  } catch (e) {
    console.error('split error:', e);
    toast(`Split failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ── PAGE GRID ────────────────────────────────────── */
let sortable = null;

async function renderGrid() {
  if (!S.pages.length) return;
  const grid = $('pageGrid');
  grid.innerHTML = '';
  loading(true, 'Rendering thumbnails…');
  try {
    for (let i = 0; i < S.pages.length; i++) {
      const canvas = await renderPageToCanvas(S.pages[i], CFG.THUMB_SCALE * 3);

      const thumb = document.createElement('div');
      thumb.className   = 'page-thumb' + (S.selectedPgs.has(i) ? ' selected' : '');
      thumb.dataset.idx = i;
      canvas.style.width  = '100%';
      canvas.style.height = 'auto';

      const lbl = document.createElement('div');
      lbl.className = 'page-thumb-label'; lbl.textContent = `Page ${i + 1}`;

      const chk = document.createElement('div');
      chk.className = 'page-thumb-select';
      chk.innerHTML = '<i class="fa-solid fa-check" style="font-size:.6rem"></i>';

      thumb.append(canvas, lbl, chk);

      if (S.pages[i].rotation) {
        const rb = document.createElement('div');
        rb.className = 'page-rotation-badge'; rb.textContent = `${S.pages[i].rotation}°`;
        thumb.appendChild(rb);
      }

      thumb.addEventListener('click', () => {
        const idx = +thumb.dataset.idx;
        if (S.selectedPgs.has(idx)) { S.selectedPgs.delete(idx); thumb.classList.remove('selected'); }
        else                        { S.selectedPgs.add(idx);    thumb.classList.add('selected'); }
        updateGridBtns();
      });
      grid.appendChild(thumb);
    }

    if (sortable) sortable.destroy();
    sortable = Sortable.create(grid, {
      animation: 150, ghostClass: 'sortable-ghost',
      onEnd(ev) {
        const moved = S.pages.splice(ev.oldIndex, 1)[0];
        S.pages.splice(ev.newIndex, 0, moved);
        grid.querySelectorAll('.page-thumb').forEach((el, i) => {
          el.dataset.idx = i;
          el.querySelector('.page-thumb-label').textContent = `Page ${i + 1}`;
        });
        S.selectedPgs.clear();
        toast('Reordered. Download to save.', 'info');
      },
    });
  } finally { loading(false); }
  updateGridBtns();
}

function updateGridBtns() {
  const has = S.selectedPgs.size > 0;
  $('deleteSelectedBtn').disabled = !has;
  $('rotateLeftBtn').disabled     = !has;
  $('rotateRightBtn').disabled    = !has;
}

$('selectAllBtn').addEventListener('click', () => {
  S.pages.forEach((_, i) => S.selectedPgs.add(i));
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
  updateGridBtns();
});
$('deselectAllBtn').addEventListener('click', () => {
  S.selectedPgs.clear();
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
  updateGridBtns();
});
$('deleteSelectedBtn').addEventListener('click', async () => {
  if (!S.selectedPgs.size || S.selectedPgs.size >= S.pages.length) {
    toast('Cannot delete all pages.', 'error'); return;
  }
  if (!confirm(`Delete ${S.selectedPgs.size} page(s)?`)) return;
  [...S.selectedPgs].sort((a,b)=>b-a).forEach(i => S.pages.splice(i,1));
  S.selectedPgs.clear();
  S.totalPages = S.pages.length;
  S.curPage    = Math.min(S.curPage, S.totalPages);
  updateNav(); updateSplitHint();
  await renderGrid(); previewMain(S.curPage);
  toast('Deleted.', 'success');
});
async function rotateSel(deg) {
  if (!S.selectedPgs.size) return;
  const cnt = S.selectedPgs.size;
  S.selectedPgs.forEach(i => { S.pages[i].rotation = (S.pages[i].rotation + deg + 360) % 360; });
  S.selectedPgs.clear();
  await renderGrid(); previewMain(S.curPage);
  toast(`Rotated ${cnt} page(s).`, 'success');
}
$('rotateLeftBtn').addEventListener('click',  () => rotateSel(-90));
$('rotateRightBtn').addEventListener('click', () => rotateSel(90));

/* ── TEXT OVERLAY ─────────────────────────────────── */
$('addTextBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  const text = $('overlayText').value.trim();
  if (!text) { toast('Enter some text first.', 'error'); return; }
  const pgNum = parseInt($('textPage').value, 10);
  if (!okPage(pgNum)) return;
  const size  = Math.max(1, parseFloat($('textSize').value) || 24);
  const x     = parseFloat($('textX').value) || 0;
  const y     = parseFloat($('textY').value) || 0;
  const color = $('textColor').value || '#000000';

  S.pages[pgNum - 1].overlays.push({ type: 'text', text, size, x, y, color });
  await previewMain(pgNum);
  setPlaceMode(null);
  toast('Text added! It will appear in the downloaded PDF.', 'success');
});

/* ── IMAGE OVERLAY ────────────────────────────────── */
$('addImageBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  const fi = $('overlayImageInput');
  if (!fi.files[0]) { toast('Select an image file.', 'error'); return; }
  const f     = fi.files[0];
  const pgNum = parseInt($('imgPage').value, 10);
  if (!okPage(pgNum)) return;
  const x = parseFloat($('imgX').value) || 0;
  const y = parseFloat($('imgY').value) || 0;
  const w = parseFloat($('imgW').value) || 150;
  const h = parseFloat($('imgH').value) || 100;

  loading(true, 'Loading image…');
  try {
    const imgEl = await loadImageElement(f);
    S.pages[pgNum - 1].overlays.push({ type: 'image', imgEl, src: f, x, y, w, h });
    await previewMain(pgNum);
    setPlaceMode(null);
    toast('Image added! It will appear in the downloaded PDF.', 'success');
  } catch (e) {
    toast(`Image error: ${e.message}`, 'error');
  } finally { loading(false); }
});

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(file);
  });
}

/* ── SIGNATURE ────────────────────────────────────── */
const sigCv  = $('sigCanvas');
const sigCtx = sigCv.getContext('2d');
$('clearSig').addEventListener('click', () => sigCtx.clearRect(0, 0, sigCv.width, sigCv.height));

function sigPos(e) {
  const r = sigCv.getBoundingClientRect(), src = e.touches ? e.touches[0] : e;
  return { x: (src.clientX-r.left)*(sigCv.width/r.width), y: (src.clientY-r.top)*(sigCv.height/r.height) };
}
function sigDraw(e) {
  e.preventDefault(); if (!S.sigDrawing) return;
  const p = sigPos(e);
  sigCtx.strokeStyle = $('sigColor').value; sigCtx.lineWidth = +$('sigStroke').value;
  sigCtx.lineCap = 'round'; sigCtx.lineJoin = 'round'; sigCtx.lineTo(p.x, p.y); sigCtx.stroke();
}
sigCv.addEventListener('mousedown',  e => { e.preventDefault(); S.sigDrawing=true; const p=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x,p.y); });
sigCv.addEventListener('mousemove',  e => sigDraw(e));
sigCv.addEventListener('mouseup',    () => { S.sigDrawing=false; });
sigCv.addEventListener('mouseleave', () => { S.sigDrawing=false; });
sigCv.addEventListener('touchstart', e => { e.preventDefault(); S.sigDrawing=true; const p=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x,p.y); }, {passive:false});
sigCv.addEventListener('touchmove',  e => sigDraw(e), {passive:false});
sigCv.addEventListener('touchend',   () => { S.sigDrawing=false; });

$('addSigBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  const px = sigCtx.getImageData(0, 0, sigCv.width, sigCv.height);
  if (!px.data.some(v => v > 0)) { toast('Draw a signature first.', 'error'); return; }
  const pgNum = parseInt($('sigPage').value, 10);
  if (!okPage(pgNum)) return;
  const x = parseFloat($('sigX').value) || 50;
  const y = parseFloat($('sigY').value) || 50;
  const w = parseFloat($('sigW').value) || 200;
  const h = parseFloat($('sigH').value) || 80;

  // Convert canvas to Image element
  const img = new Image();
  img.src = sigCv.toDataURL('image/png');
  await new Promise(r => { img.onload = r; });

  S.pages[pgNum - 1].overlays.push({ type: 'signature', imgEl: img, x, y, w, h });
  await previewMain(pgNum);
  setPlaceMode(null);
  toast('Signature added! It will appear in the downloaded PDF.', 'success');
});

/* ── SECURITY ─────────────────────────────────────── */
$('applyPwdBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  const up = $('userPassword').value;
  if (!up) { toast('Enter a user password.', 'error'); return; }
  loading(true, 'Building PDF…');
  try {
    const bytes = await buildPdf(S.pages);
    dlBytes(bytes, 'document.pdf');
    const op = $('ownerPassword').value || up;
    toast(`Saved. To encrypt: qpdf --encrypt ${up} ${op} 256 -- document.pdf encrypted.pdf`, 'info', 10000);
  } catch (e) {
    console.error(e); toast(`Failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ── DOWNLOAD ─────────────────────────────────────── */
$('downloadBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  loading(true, 'Building PDF…');
  try {
    const bytes = await buildPdf(S.pages);
    dlBytes(bytes, 'edited.pdf');
    toast('Downloaded!', 'success');
  } catch (e) {
    console.error(e); toast(`Failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ── UTILS ────────────────────────────────────────── */
function dlBytes(bytes, name) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a   = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1], bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

/* ── INIT ─────────────────────────────────────────── */
enableBtns(false);
refreshMergeList();
console.log('%c PDF Studio v5 ', 'background:#4f8ef7;color:#fff;font-size:1rem;padding:3px 12px;border-radius:4px');
console.log('Architecture: PDF.js render → canvas → JPEG → pdf-lib embed. Works on all PDFs.');
