/**
 * PDF Studio v4 — script.js
 * API verified against debug.html output.
 * All pdf-lib calls use window.PDFLib.X directly (no destructuring at module level
 * since the UMD bundle is loaded async and must be available at call time).
 */
'use strict';

/* ─── CONFIG ─────────────────────────────────── */
const CFG = {
  MAX_MB:        50,
  WORKER:        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  THUMB_SCALE:   0.28,
  PREVIEW_SCALE: 1.4,
  ZOOM_STEP:     0.25,
  ZOOM_MIN:      0.5,
  ZOOM_MAX:      3.0,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = CFG.WORKER;

/* ─── STATE ──────────────────────────────────── */
const S = {
  pdfJsDoc:    null,
  rawBytes:    null,      // Uint8Array of latest PDF bytes
  pageOrder:   [],        // [origIndex, ...] current display order
  pageRots:    {},        // { origIndex: extraDegrees }
  selectedPgs: new Set(),
  curPage:     1,
  totalPages:  0,
  zoom:        1.0,
  isDark:      true,
  mergeFiles:  [],
  mergeJsDocs: [],
  mergeCurDoc: 0,
  mergeCurPg:  1,
  sigDrawing:  false,
  placeMode:   null,
};

/* ─── DOM ────────────────────────────────────── */
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
    toast(`Page must be 1–${S.totalPages}.`, 'error');
    return false;
  }
  return true;
}

window.togglePwd = id => {
  const el = $(id);
  el.type = el.type === 'password' ? 'text' : 'password';
};

/* ─── THEME ──────────────────────────────────── */
$('themeToggle').addEventListener('click', () => {
  S.isDark = !S.isDark;
  document.documentElement.setAttribute('data-theme', S.isDark ? 'dark' : 'light');
  $('themeToggle').innerHTML = S.isDark
    ? '<i class="fa-solid fa-moon"></i>'
    : '<i class="fa-solid fa-sun"></i>';
});

/* ─── PANEL NAV ──────────────────────────────── */
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    $(`panel-${btn.dataset.panel}`).classList.add('active');
    if (btn.dataset.panel === 'pages' && S.pdfJsDoc) renderGrid();
    if (btn.dataset.panel === 'merge') renderMergePreview();
  });
});

/* ─── PDF LOAD ───────────────────────────────── */

/**
 * Read bytes into state.
 * isNew=true  → full reset (fresh file upload)
 * isNew=false → keep page/zoom state (after edit)
 */
async function ingestBytes(bytes, isNew) {
  if (!(bytes instanceof Uint8Array)) {
    bytes = new Uint8Array(bytes);
  }

  // STEP 1: Load with pdf-lib
  let doc;
  try {
    doc = await PDFLib.PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch (e) {
    console.error("Initial load failed:", e);
    throw new Error("Unsupported or corrupted PDF.");
  }

  // STEP 2: Re-save to normalize structure
  const normalized = await doc.save({
    useObjectStreams: false,   // critical
    addDefaultPage: false,
  });

  const cleanBytes = normalized instanceof Uint8Array
    ? normalized
    : new Uint8Array(normalized);

  // STEP 3: Now store clean version
  S.rawBytes = cleanBytes;

  // STEP 4: Load into PDF.js using sanitized bytes
  S.pdfJsDoc = await pdfjsLib.getDocument({
    data: cleanBytes.slice()
  }).promise;

  S.totalPages = S.pdfJsDoc.numPages;

  if (isNew) {
    S.pageOrder = Array.from({ length: S.totalPages }, (_, i) => i);
    S.pageRots = {};
    S.selectedPgs.clear();
    S.curPage = 1;
  }
}

async function loadFile(file) {
  if (!file || file.type !== 'application/pdf') {
    toast('Please select a valid PDF file.', 'error'); return;
  }
  if (!okSize(file)) return;
  loading(true, 'Loading PDF…');
  try {
    const buf = await file.arrayBuffer();
    await ingestBytes(new Uint8Array(buf), true);
    $('fileName').textContent = file.name;
    $('fileSize').textContent = `${fmtSize(file.size)} · ${S.totalPages} pages`;
    hide($('dropZone')); show($('fileInfo'));
    enableBtns(true);
    updateSplitHint();
    await previewMain(1);
    toast(`Loaded: ${file.name} (${S.totalPages} pages)`, 'success');
  } catch (e) {
    console.error('loadFile error:', e);
    toast(`Load failed: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
}

function enableBtns(on) {
  ['downloadBtn','splitBtn','addTextBtn','addImageBtn','addSigBtn','applyPwdBtn','zoomIn','zoomOut']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  updateNav();
}

$('fileInput').addEventListener('change', e => {
  if (e.target.files[0]) loadFile(e.target.files[0]);
});

const dz = $('dropZone');
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => {
  e.preventDefault(); dz.classList.remove('drag-over');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop',     e => { if (e.target !== dz) e.preventDefault(); });

$('clearFile').addEventListener('click', () => {
  Object.assign(S, {
    pdfJsDoc: null, rawBytes: null, pageOrder: [], pageRots: {},
    totalPages: 0, curPage: 1,
  });
  S.selectedPgs.clear();
  show($('dropZone')); hide($('fileInfo'));
  $('fileInput').value = '';
  $('pageIndicator').textContent = '— / —';
  hide($('previewCanvas')); show($('previewPlaceholder'));
  $('pageGrid').innerHTML = '<p class="hint center">Upload a PDF to manage pages.</p>';
  clearOverlay();
  enableBtns(false);
});

/* ─── MAIN PREVIEW ───────────────────────────── */
async function previewMain(pg) {
  if (!S.pdfJsDoc) return;
  pg = Math.max(1, Math.min(pg ?? S.curPage, S.totalPages));
  S.curPage = pg;

  const origIdx = S.pageOrder[pg - 1];
  const pdfPage = await S.pdfJsDoc.getPage(origIdx + 1);
  const addRot  = S.pageRots[origIdx] || 0;
  const vp      = pdfPage.getViewport({
    scale:    CFG.PREVIEW_SCALE * S.zoom,
    rotation: (pdfPage.rotate + addRot) % 360,
  });

  const cv = $('previewCanvas');
  cv.width  = vp.width;
  cv.height = vp.height;
  show(cv); hide($('previewPlaceholder'));
  await pdfPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  updateNav();

  // Keep placement overlay same size as canvas
  const ov = $('placementOverlay');
  if (ov) { ov.width = cv.width; ov.height = cv.height; }
}

function updateNav() {
  $('pageIndicator').textContent =
    S.totalPages ? `${S.curPage} / ${S.totalPages}` : '— / —';
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

/* ─── PLACEMENT OVERLAY ──────────────────────── */
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
  ctx.font = 'bold 11px monospace';
  ctx.fillText(`(${px}, ${py})`, cx + 8, cy - 5);
  toast(`Position → X:${px} Y:${py}`, 'success', 2500);
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
    toast('Click on the preview to place.', 'info', 3500);
  } else {
    clearOverlay();
  }
}

$('textPickBtn').addEventListener('click', () => setPlaceMode('text',      'textPickBtn'));
$('imgPickBtn' ).addEventListener('click', () => setPlaceMode('image',     'imgPickBtn'));
$('sigPickBtn' ).addEventListener('click', () => setPlaceMode('signature', 'sigPickBtn'));

/* ─── CORE: REBUILD ──────────────────────────────
   Applies pageOrder + rotations to rawBytes.
   Returns a plain Uint8Array.

   KEY INSIGHT from debug: PDFLib.degrees(), PDFLib.rgb(),
   PDFLib.StandardFonts all exist. The crash was caused by
   copyPages() receiving a Uint8Array that was already the
   result of .save() (which returns Uint8Array), then being
   passed again into load() without issue — BUT the problem
   was that we were calling load() on the *result of save()*
   which is already a Uint8Array, and that is fine.

   The REAL crash source: after applyEdit() we reset pageOrder
   to [0,1,2,...] but the *rawBytes* now encodes a doc with
   N pages in order. Then rebuild() copies pages[0..N-1] and
   that works. BUT if an exception happens *during* copyPages
   for a malformed page entry, pdf-lib throws "expected instance
   of e". Guard: wrap in try/catch with full stack logging.
─────────────────────────────────────────────────── */
async function rebuild() {
  if (!S.rawBytes) throw new Error('No PDF loaded');

  console.log('[rebuild] rawBytes length:', S.rawBytes.length);
  console.log('[rebuild] pageOrder:', S.pageOrder);
  console.log('[rebuild] pageRots:', S.pageRots);

  // pdf-lib load — pass a COPY so it owns the buffer
  const srcBytes = S.rawBytes.slice();
  const src  = await PDFLib.PDFDocument.load(srcBytes, { ignoreEncryption: true });
  console.log('[rebuild] src page count:', src.getPageCount());
  const dest = await PDFLib.PDFDocument.create();

  // Validate page order indices before passing to copyPages
  const totalSrcPages = src.getPageCount();
  const safeOrder = S.pageOrder.filter(i =>
  Number.isInteger(i) &&
  i >= 0 &&
  i < totalSrcPages
);
  if (safeOrder.length === 0) throw new Error('No valid pages to copy');

  const copied = await dest.copyPages(src, safeOrder);
  copied.forEach((page, i) => {
    const origIdx = safeOrder[i];
    const extra   = S.pageRots[origIdx] || 0;
    if (extra !== 0) {
      // getRotation() confirmed to return {type,angle} — safe
      const curAngle = page.getRotation().angle;
      page.setRotation(PDFLib.degrees((curAngle + extra) % 360));
    }
    dest.addPage(page);
  });

  const saved = await dest.save();
  // dest.save() returns Uint8Array — confirm and return
  return saved instanceof Uint8Array ? saved : new Uint8Array(saved);
}

/**
 * After a content edit, update rawBytes and re-render.
 * The saved doc has pages 0..N-1 in order so reset pageOrder.
 */
async function applyEdit(newBytes) {
  if (!(newBytes instanceof Uint8Array)) newBytes = new Uint8Array(newBytes);
  const prevPage   = S.curPage;
  S.rawBytes       = newBytes;
  S.pdfJsDoc       = await pdfjsLib.getDocument({ data: newBytes.slice() }).promise;
  S.totalPages     = S.pdfJsDoc.numPages;
  S.pageOrder      = Array.from({ length: S.totalPages }, (_, i) => i);
  S.pageRots       = {};
  S.curPage        = Math.min(prevPage, S.totalPages);
  updateNav();
  updateSplitHint();
  await previewMain(S.curPage);
}

/* ─── MERGE ──────────────────────────────────── */
function refreshMergeList() {
  const list = $('mergeList');
  list.innerHTML = '';
  S.mergeFiles.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'merge-item' + (i === S.mergeCurDoc ? ' merge-item-active' : '');
    li.innerHTML = `
      <i class="fa-solid fa-file-pdf"></i>
      <span class="merge-item-name" title="${f.name}">${f.name}</span>
      <small class="merge-item-size">${fmtSize(f.size)}</small>
      <button class="icon-btn" onclick="switchMergeDoc(${i})" title="Preview"><i class="fa-solid fa-eye"></i></button>
      <button class="icon-btn danger" onclick="removeMergeFile(${i})" title="Remove"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(li);
  });
  $('mergeBtn').disabled = S.mergeFiles.length < 2;

  const total  = S.mergeJsDocs.length;
  const curDoc = S.mergeJsDocs[S.mergeCurDoc];
  const curPgs = curDoc ? curDoc.numPages : 0;
  $('mergeDocLabel').textContent = total
    ? `File ${S.mergeCurDoc + 1}/${total} — Page ${S.mergeCurPg}/${curPgs}`
    : 'No PDFs added';
  $('mergePrevDoc').disabled = S.mergeCurDoc <= 0;
  $('mergeNextDoc').disabled = S.mergeCurDoc >= total - 1;
  $('mergePrevPg').disabled  = S.mergeCurPg <= 1;
  $('mergeNextPg').disabled  = !curDoc || S.mergeCurPg >= curPgs;
}

window.switchMergeDoc = i => {
  S.mergeCurDoc = i; S.mergeCurPg = 1;
  renderMergePreview(); refreshMergeList();
};

window.removeMergeFile = i => {
  S.mergeFiles.splice(i, 1);
  S.mergeJsDocs.splice(i, 1);
  S.mergeCurDoc = Math.max(0, Math.min(S.mergeCurDoc, S.mergeFiles.length - 1));
  S.mergeCurPg  = 1;
  renderMergePreview(); refreshMergeList();
};

async function addMergeFiles(files) {
  loading(true, 'Adding files…');
  try {
    for (const f of Array.from(files)) {
      if (f.type !== 'application/pdf') { toast(`Not a PDF: ${f.name}`, 'error'); continue; }
      if (!okSize(f)) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const jsDoc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      S.mergeFiles.push(f);
      S.mergeJsDocs.push(jsDoc);
    }
    S.mergeCurDoc = Math.max(0, S.mergeFiles.length - 1);
    S.mergeCurPg  = 1;
    await renderMergePreview();
    refreshMergeList();
  } catch (e) {
    console.error('addMergeFiles:', e);
    toast(`Error: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
}

async function renderMergePreview() {
  const cv = $('mergePreviewCanvas');
  const ph = $('mergePreviewPlaceholder');
  if (!S.mergeJsDocs.length) { hide(cv); show(ph); refreshMergeList(); return; }
  const doc = S.mergeJsDocs[S.mergeCurDoc];
  if (!doc) return;
  S.mergeCurPg = Math.max(1, Math.min(S.mergeCurPg, doc.numPages));
  const pg = await doc.getPage(S.mergeCurPg);
  const vp = pg.getViewport({ scale: CFG.PREVIEW_SCALE });
  cv.width = vp.width; cv.height = vp.height;
  show(cv); hide(ph);
  await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  refreshMergeList();
}

$('mergeInput').addEventListener('change', async e => {
  await addMergeFiles(e.target.files); e.target.value = '';
});
const mdz = $('mergeDropZone');
mdz.addEventListener('dragover',  e => { e.preventDefault(); mdz.classList.add('drag-over'); });
mdz.addEventListener('dragleave', () => mdz.classList.remove('drag-over'));
mdz.addEventListener('drop', async e => {
  e.preventDefault(); mdz.classList.remove('drag-over');
  await addMergeFiles(e.dataTransfer.files);
});
$('mergePrevDoc').addEventListener('click', () => { S.mergeCurDoc--; S.mergeCurPg = 1; renderMergePreview(); });
$('mergeNextDoc').addEventListener('click', () => { S.mergeCurDoc++; S.mergeCurPg = 1; renderMergePreview(); });
$('mergePrevPg' ).addEventListener('click', () => { S.mergeCurPg--; renderMergePreview(); });
$('mergeNextPg' ).addEventListener('click', () => { S.mergeCurPg++; renderMergePreview(); });

$('mergeBtn').addEventListener('click', async () => {
  if (S.mergeFiles.length < 2) return;
  loading(true, `Merging ${S.mergeFiles.length} PDFs…`);
  try {
    const merged = await PDFLib.PDFDocument.create();
    for (const f of S.mergeFiles) {
      const buf  = new Uint8Array(await f.arrayBuffer());
      const doc  = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
      const idxs = Array.from({ length: doc.getPageCount() }, (_, i) => i);
      const pgs  = await merged.copyPages(doc, idxs);
      pgs.forEach(p => merged.addPage(p));
    }
    const out = await merged.save();
    dlBytes(out instanceof Uint8Array ? out : new Uint8Array(out), 'merged.pdf');
    toast(`Merged ${S.mergeFiles.length} PDFs!`, 'success');
  } catch (e) {
    console.error('mergeBtn error:', e);
    toast(`Merge failed: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
});

/* ─── SPLIT ──────────────────────────────────── */
function updateSplitHint() {
  $('splitPageCount').textContent = S.totalPages ? `Document has ${S.totalPages} pages` : '';
  if (S.totalPages) {
    $('splitTo').value = S.totalPages;
    $('splitFrom').max = $('splitTo').max = S.totalPages;
  }
}

$('splitBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const from = parseInt($('splitFrom').value, 10);
  const to   = parseInt($('splitTo').value,   10);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to > S.totalPages || from > to) {
    toast('Invalid page range.', 'error'); return;
  }
  loading(true, 'Splitting…');
  try {
    const srcBytes = S.rawBytes.slice();
    const src  = await PDFLib.PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const dest = await PDFLib.PDFDocument.create();
    const idxs = Array.from({ length: to - from + 1 }, (_, i) => from - 1 + i);
    const pgs  = await dest.copyPages(src, idxs);
    pgs.forEach(p => dest.addPage(p));
    const out  = await dest.save();
    dlBytes(out instanceof Uint8Array ? out : new Uint8Array(out), `pages_${from}-${to}.pdf`);
    toast(`Pages ${from}–${to} extracted!`, 'success');
  } catch (e) {
    console.error('splitBtn error:', e);
    toast(`Split failed: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
});

/* ─── PAGE GRID ──────────────────────────────── */
let sortable = null;

async function renderGrid() {
  if (!S.pdfJsDoc) return;
  const grid = $('pageGrid');
  grid.innerHTML = '';
  loading(true, 'Rendering thumbnails…');
  try {
    for (let i = 0; i < S.pageOrder.length; i++) {
      const origIdx = S.pageOrder[i];
      const pg      = await S.pdfJsDoc.getPage(origIdx + 1);
      const addRot  = S.pageRots[origIdx] || 0;
      const vp      = pg.getViewport({ scale: CFG.THUMB_SCALE, rotation: (pg.rotate + addRot) % 360 });
      const cv      = document.createElement('canvas');
      cv.width = vp.width; cv.height = vp.height;
      await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;

      const thumb = document.createElement('div');
      thumb.className   = 'page-thumb' + (S.selectedPgs.has(i) ? ' selected' : '');
      thumb.dataset.idx = i;

      const lbl = document.createElement('div');
      lbl.className   = 'page-thumb-label';
      lbl.textContent = `Page ${i + 1}`;

      const chk = document.createElement('div');
      chk.className = 'page-thumb-select';
      chk.innerHTML = '<i class="fa-solid fa-check" style="font-size:.6rem"></i>';

      thumb.append(cv, lbl, chk);

      if (addRot) {
        const rb = document.createElement('div');
        rb.className   = 'page-rotation-badge';
        rb.textContent = `${addRot}°`;
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
      animation: 150,
      ghostClass: 'sortable-ghost',
      onEnd(ev) {
        const moved = S.pageOrder.splice(ev.oldIndex, 1)[0];
        S.pageOrder.splice(ev.newIndex, 0, moved);
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
  S.pageOrder.forEach((_, i) => S.selectedPgs.add(i));
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
  updateGridBtns();
});
$('deselectAllBtn').addEventListener('click', () => {
  S.selectedPgs.clear();
  document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
  updateGridBtns();
});
$('deleteSelectedBtn').addEventListener('click', async () => {
  if (!S.selectedPgs.size || S.selectedPgs.size >= S.pageOrder.length) {
    toast('Cannot delete all pages.', 'error'); return;
  }
  if (!confirm(`Delete ${S.selectedPgs.size} page(s)?`)) return;
  [...S.selectedPgs].sort((a, b) => b - a).forEach(i => S.pageOrder.splice(i, 1));
  S.selectedPgs.clear();
  S.totalPages = S.pageOrder.length;
  S.curPage    = Math.min(S.curPage, S.totalPages);
  updateNav(); updateSplitHint();
  await renderGrid(); previewMain(S.curPage);
  toast('Deleted.', 'success');
});
async function rotateSel(deg) {
  if (!S.selectedPgs.size) return;
  const cnt = S.selectedPgs.size;
  S.selectedPgs.forEach(i => {
    const orig = S.pageOrder[i];
    S.pageRots[orig] = ((S.pageRots[orig] || 0) + deg + 360) % 360;
  });
  S.selectedPgs.clear();
  await renderGrid(); previewMain(S.curPage);
  toast(`Rotated ${cnt} page(s).`, 'success');
}
$('rotateLeftBtn').addEventListener('click',  () => rotateSel(-90));
$('rotateRightBtn').addEventListener('click', () => rotateSel(90));

/* ─── TEXT OVERLAY ───────────────────────────── */
$('addTextBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const text = $('overlayText').value.trim();
  if (!text) { toast('Enter some text first.', 'error'); return; }
  const pgNum = parseInt($('textPage').value, 10);
  if (!okPage(pgNum)) return;
  const size  = Math.max(1, parseFloat($('textSize').value) || 24);
  const x     = parseFloat($('textX').value) || 0;
  const yTop  = parseFloat($('textY').value) || 0;
  const col   = hexToRgb($('textColor').value);

  loading(true, 'Adding text…');
  try {
    const base = await rebuild();
    const doc  = await PDFLib.PDFDocument.load(base, { ignoreEncryption: true });
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    const page = doc.getPages()[pgNum - 1];
    const h    = page.getSize().height;
    page.drawText(text, {
      x,
      y:     h - yTop - size,   // convert top→bottom
      size,
      font,
      color: PDFLib.rgb(col.r / 255, col.g / 255, col.b / 255),
    });
    const saved = await dest.save({
      useObjectStreams: false
    });
    await applyEdit(saved instanceof Uint8Array ? saved : new Uint8Array(saved));
    setPlaceMode(null);
    toast('Text added!', 'success');
  } catch (e) {
    console.error('addTextBtn error:', e);
    toast(`Failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── IMAGE OVERLAY ──────────────────────────── */
$('addImageBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const fi = $('overlayImageInput');
  if (!fi.files[0]) { toast('Select an image file.', 'error'); return; }
  const f     = fi.files[0];
  const pgNum = parseInt($('imgPage').value, 10);
  if (!okPage(pgNum)) return;
  const x    = parseFloat($('imgX').value) || 0;
  const yTop = parseFloat($('imgY').value) || 0;
  const w    = parseFloat($('imgW').value) || 150;
  const h    = parseFloat($('imgH').value) || 100;

  loading(true, 'Embedding image…');
  try {
    const base   = await rebuild();
    const doc    = await PDFLib.PDFDocument.load(base, { ignoreEncryption: true });
    const imgBuf = await f.arrayBuffer();
    const img    = (f.type === 'image/png')
      ? await doc.embedPng(imgBuf)
      : await doc.embedJpg(imgBuf);
    const page   = doc.getPages()[pgNum - 1];
    const pgH    = page.getSize().height;
    page.drawImage(img, { x, y: pgH - yTop - h, width: w, height: h });
    const saved  = await doc.save();
    await applyEdit(saved instanceof Uint8Array ? saved : new Uint8Array(saved));
    setPlaceMode(null);
    toast('Image embedded!', 'success');
  } catch (e) {
    console.error('addImageBtn error:', e);
    toast(`Failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── SIGNATURE ──────────────────────────────── */
const sigCv  = $('sigCanvas');
const sigCtx = sigCv.getContext('2d');

$('clearSig').addEventListener('click', () =>
  sigCtx.clearRect(0, 0, sigCv.width, sigCv.height));

function sigPos(e) {
  const r   = sigCv.getBoundingClientRect();
  const src = e.touches ? e.touches[0] : e;
  return {
    x: (src.clientX - r.left) * (sigCv.width  / r.width),
    y: (src.clientY - r.top)  * (sigCv.height / r.height),
  };
}
function sigDraw(e) {
  e.preventDefault();
  if (!S.sigDrawing) return;
  const p = sigPos(e);
  sigCtx.strokeStyle = $('sigColor').value;
  sigCtx.lineWidth   = +$('sigStroke').value;
  sigCtx.lineCap     = 'round';
  sigCtx.lineJoin    = 'round';
  sigCtx.lineTo(p.x, p.y);
  sigCtx.stroke();
}
sigCv.addEventListener('mousedown',  e => { e.preventDefault(); S.sigDrawing = true;  const p = sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); });
sigCv.addEventListener('mousemove',  e => sigDraw(e));
sigCv.addEventListener('mouseup',    () => { S.sigDrawing = false; });
sigCv.addEventListener('mouseleave', () => { S.sigDrawing = false; });
sigCv.addEventListener('touchstart', e => { e.preventDefault(); S.sigDrawing = true;  const p = sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x, p.y); }, { passive: false });
sigCv.addEventListener('touchmove',  e => sigDraw(e), { passive: false });
sigCv.addEventListener('touchend',   () => { S.sigDrawing = false; });

$('addSigBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const px = sigCtx.getImageData(0, 0, sigCv.width, sigCv.height);
  if (!px.data.some(v => v > 0)) { toast('Draw a signature first.', 'error'); return; }
  const pgNum = parseInt($('sigPage').value, 10);
  if (!okPage(pgNum)) return;
  const x    = parseFloat($('sigX').value) || 50;
  const yTop = parseFloat($('sigY').value) || 50;
  const w    = parseFloat($('sigW').value) || 200;
  const h    = parseFloat($('sigH').value) || 80;

  loading(true, 'Embedding signature…');
  try {
    const pngBytes = dataUrlToBytes(sigCv.toDataURL('image/png'));
    const base     = await rebuild();
    const doc      = await PDFLib.PDFDocument.load(base, { ignoreEncryption: true });
    const img      = await doc.embedPng(pngBytes);
    const page     = doc.getPages()[pgNum - 1];
    const pgH      = page.getSize().height;
    page.drawImage(img, { x, y: pgH - yTop - h, width: w, height: h });
    const saved    = await doc.save();
    await applyEdit(saved instanceof Uint8Array ? saved : new Uint8Array(saved));
    setPlaceMode(null);
    toast('Signature embedded!', 'success');
  } catch (e) {
    console.error('addSigBtn error:', e);
    toast(`Failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── SECURITY ───────────────────────────────── */
$('applyPwdBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  const up = $('userPassword').value;
  if (!up) { toast('Enter a user password.', 'error'); return; }
  loading(true, 'Saving…');
  try {
    const out = await rebuild();
    dlBytes(out, 'document.pdf');
    const op = $('ownerPassword').value || up;
    toast(`PDF saved. To encrypt locally: qpdf --encrypt ${up} ${op} 256 -- document.pdf out.pdf`, 'info', 10000);
  } catch (e) {
    console.error('applyPwdBtn error:', e);
    toast(`Failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── DOWNLOAD ───────────────────────────────── */
$('downloadBtn').addEventListener('click', async () => {
  if (!S.rawBytes) return;
  loading(true, 'Building PDF…');
  try {
    const out = await rebuild();
    dlBytes(out, 'edited.pdf');
    toast('Downloaded!', 'success');
  } catch (e) {
    console.error('downloadBtn error:', e);
    toast(`Download failed: ${e.message}`, 'error');
  } finally { loading(false); }
});

/* ─── UTILS ──────────────────────────────────── */
function dlBytes(bytes, name) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

function dataUrlToBytes(dataUrl) {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

/* ─── INIT ───────────────────────────────────── */
enableBtns(false);
refreshMergeList();
console.log('%c PDF Studio v4 ', 'background:#4f8ef7;color:#fff;font-size:1rem;padding:3px 12px;border-radius:4px');
