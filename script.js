'use strict';
/**
 * PDF Studio v7
 * Key changes from v6:
 *  - Each tool panel has its own independent upload drop zone
 *  - Home button always visible in header when in editor
 *  - Shared "active PDF" per-tool — switching tools doesn't lose your file
 *  - Merge has its own multi-file upload (no shared PDF needed)
 *  - Images→PDF has its own image upload (no PDF needed)
 */

/* ── CONFIG ── */
const CFG = {
  MAX_MB: 100,
  WORKER: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  RENDER_SCALE: 2.0,
  PREVIEW_SCALE: 1.4,
  THUMB_SCALE: 0.9,
  ZOOM_STEP: 0.25, ZOOM_MIN: 0.5, ZOOM_MAX: 3.0,
};
pdfjsLib.GlobalWorkerOptions.workerSrc = CFG.WORKER;

/* ── STATE ── */
const S = {
  // Each tool stores its own pages array independently
  toolPages: {},      // { toolName: [pageDesc, ...] }
  activeTool: null,

  // Convenience getters for current tool's pages
  get pages() { return S.toolPages[S.activeTool] || []; },
  set pages(v) { S.toolPages[S.activeTool] = v; },
  get totalPages() { return S.pages.length; },

  curPage: 1, zoom: 1.0, isDark: true,
  selectedPgs: new Set(),

  mergeSources: [], _mergeViewIdx: 0,
  imgToPdfFiles: [],

  sigDrawing: false, placeMode: null,
  annoteTool: 'freehand',
  annoteStrokes: [], annoteDrawing: false,
  annoteStart: null, annoteCurStroke: null,
  redactBoxes: [], redactDrawing: false, redactStart: null,
  compressQuality: 0.92,
};

/* ── HELPERS ── */
const $ = id => document.getElementById(id);
const show = el => el && el.classList.remove('hidden');
const hide = el => el && el.classList.add('hidden');

function toast(msg, type = 'info', ms = 4500) {
  const t = $('toast');
  t.textContent = msg; t.className = `toast ${type}`;
  show(t); clearTimeout(t._t);
  t._t = setTimeout(() => hide(t), ms);
}
function loading(on, txt = 'Processing…') {
  $('loadingText').textContent = txt;
  on ? show($('loadingOverlay')) : hide($('loadingOverlay'));
}
function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(2) + ' MB';
}
function okSize(f) {
  if (f.size / 1048576 > CFG.MAX_MB) { toast(`Too large (max ${CFG.MAX_MB} MB).`, 'error'); return false; }
  return true;
}
function okPage(n) {
  if (!Number.isFinite(n) || n < 1 || n > S.totalPages) {
    toast(`Page must be 1–${S.totalPages}.`, 'error'); return false;
  }
  return true;
}
window.togglePwd = id => { const e = $(id); e.type = e.type === 'password' ? 'text' : 'password'; };

function loadImgEl(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Image load failed'));
    img.src = URL.createObjectURL(file);
  });
}
function dataUrlToBytes(du) {
  const b = atob(du.split(',')[1]), u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}
function dlBytes(bytes, name) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/* ── THEME ── */
$('themeToggle').addEventListener('click', () => {
  S.isDark = !S.isDark;
  document.documentElement.setAttribute('data-theme', S.isDark ? 'dark' : 'light');
  $('themeToggle').innerHTML = S.isDark ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
});

/* ── SCREEN SWITCHING ── */
function showHome() {
  show($('homeScreen')); hide($('editorScreen'));
  hide($('homeBtn'));
  exitAnnotateMode(); exitRedactMode();
}
function showEditor(tool) {
  hide($('homeScreen')); show($('editorScreen'));
  show($('homeBtn'));
  activatePanel(tool);
}
$('goHome').addEventListener('click', showHome);
$('homeBtn').addEventListener('click', showHome);
document.querySelectorAll('.tool-card').forEach(card => {
  card.addEventListener('click', () => showEditor(card.dataset.tool));
});

/* ── PANEL ACTIVATION ── */
function activatePanel(name) {
  S.activeTool = name;
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));

  // Sync preview to this tool's pages if loaded
  if (S.pages.length) {
    S.curPage = Math.max(1, Math.min(S.curPage, S.totalPages));
    previewMain(S.curPage);
    updateDownloadBtn();
  } else {
    hide($('previewCanvas')); show($('previewPlaceholder'));
    $('pageIndicator').textContent = '— / —';
    updateDownloadBtn();
  }

  if (name === 'pages' && S.pages.length) renderGrid();
  if (name === 'merge') refreshMergePreview();
  if (name === 'annotate' && S.pages.length) enterAnnotateMode(); else exitAnnotateMode();
  if (name === 'redact'   && S.pages.length) enterRedactMode();   else exitRedactMode();
  if (typeof tbCheckEnter === 'function') tbCheckEnter();
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => showEditor(btn.dataset.panel));
});

/* ── PER-TOOL PDF UPLOAD ── */
/**
 * Generic function to wire up a tool's upload zone.
 * toolName: key in S.toolPages
 * inputId:  <input type="file"> id
 * zoneId:   drop zone div id
 * infoId:   file info badge div id
 * controlsId: controls to reveal after upload (optional)
 * onLoaded:  callback after pages built
 */
// Map each toolName to its action button id
const TOOL_ACTION_BTN = {
  split:       'splitBtn',
  compress:    'compressBtn',
  pages:       null,   // no single action btn (grid-based)
  annotate:    'annotateApplyBtn',
  text:        'addTextBtn',
  image:       'addImageBtn',
  watermark:   'wmBtn',
  pagenumbers: 'pnBtn',
  redact:      'redactApplyBtn',
  signature:   'addSigBtn',
  security:    'applyPwdBtn',
};

function wirePdfUpload({ toolName, inputId, zoneId, infoId, controlsId }) {
  const input = $(inputId);
  const zone  = $(zoneId);
  const info  = $(infoId);

  async function handleFile(file) {
    if (!file || file.type !== 'application/pdf') { toast('Please select a valid PDF.', 'error'); return; }
    if (!okSize(file)) return;
    loading(true, 'Loading PDF…');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc   = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      S.toolPages[toolName] = Array.from({ length: doc.numPages }, (_, i) => ({
        pdfJsDoc: doc, pageNum: i + 1, rotation: 0, overlays: [],
      }));
      // Show file badge
      info.innerHTML = `
        <i class="fa-solid fa-file-pdf fi-icon"></i>
        <div style="flex:1;min-width:0">
          <div class="fi-name">${file.name}</div>
          <div class="fi-size">${fmtSize(file.size)} · ${doc.numPages} pages</div>
        </div>
        <button class="fi-change" onclick="resetToolUpload('${toolName}','${inputId}','${zoneId}','${infoId}','${controlsId}')">Change</button>`;
      hide(zone); show(info);
      if (controlsId) show($(controlsId));

      // Enable this tool's action button
      const btnId = TOOL_ACTION_BTN[toolName];
      if (btnId) { const b = $(btnId); if (b) b.disabled = false; }

      // If this is the active tool, update preview
      if (S.activeTool === toolName) {
        S.curPage = 1;
        await previewMain(1);
        updateDownloadBtn();
        if (toolName === 'pages')    { show($('pagesToolbar')); renderGrid(); }
        if (toolName === 'annotate') enterAnnotateMode();
        if (toolName === 'redact')   enterRedactMode();
        if (toolName === 'split')    updateSplitHint();
        if (toolName === 'text')     tbCheckEnter();
        if (toolName === 'watermark') setTimeout(() => { if (typeof wmActivate==='function') wmActivate(); }, 50);
        if (toolName === 'signature') setTimeout(() => { if (typeof sigActivate==='function') sigActivate(); }, 50);
      }
      toast(`Loaded "${file.name}" — ${doc.numPages} pages`, 'success');
    } catch (e) { console.error(e); toast(`Load failed: ${e.message}`, 'error'); }
    finally { loading(false); }
  }

  input.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); e.target.value = ''; });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
}

window.resetToolUpload = (toolName, inputId, zoneId, infoId, controlsId) => {
  S.toolPages[toolName] = [];
  $(inputId).value = '';
  show($(zoneId)); hide($(infoId));
  if (controlsId) hide($(controlsId));
  // Disable the tool's action button
  const btnId = TOOL_ACTION_BTN[toolName];
  if (btnId) { const b = $(btnId); if (b) b.disabled = true; }
  if (S.activeTool === toolName) {
    hide($('previewCanvas')); show($('previewPlaceholder'));
    $('pageIndicator').textContent = '— / —';
    updateDownloadBtn();
    exitAnnotateMode(); exitRedactMode();
    if (toolName === 'watermark' && typeof wmDeactivate === 'function') wmDeactivate();
  }
};

// Wire every tool that needs a single PDF
wirePdfUpload({ toolName:'split',      inputId:'splitFileInput',      zoneId:'splitUploadZone',      infoId:'splitFileInfo',      controlsId:null });
wirePdfUpload({ toolName:'compress',   inputId:'compressFileInput',   zoneId:'compressUploadZone',   infoId:'compressFileInfo',   controlsId:null });
wirePdfUpload({ toolName:'pages',      inputId:'pagesFileInput',      zoneId:'pagesUploadZone',      infoId:'pagesFileInfo',      controlsId:'pagesToolbar' });
wirePdfUpload({ toolName:'annotate',   inputId:'annotateFileInput',   zoneId:'annotateUploadZone',   infoId:'annotateFileInfo',   controlsId:'annotateControls' });
wirePdfUpload({ toolName:'text',       inputId:'textFileInput',       zoneId:'textUploadZone',       infoId:'textFileInfo',       controlsId:'textControls' });
wirePdfUpload({ toolName:'image',      inputId:'pdfImageFileInput',   zoneId:'imageUploadZone',      infoId:'imageFileInfo',      controlsId:'imageControls' });
wirePdfUpload({ toolName:'watermark',  inputId:'watermarkFileInput',  zoneId:'watermarkUploadZone',  infoId:'watermarkFileInfo',  controlsId:'watermarkControls' });
wirePdfUpload({ toolName:'pagenumbers',inputId:'pnFileInput',         zoneId:'pnUploadZone',         infoId:'pnFileInfo',         controlsId:'pnControls' });
wirePdfUpload({ toolName:'redact',     inputId:'redactFileInput',     zoneId:'redactUploadZone',     infoId:'redactFileInfo',     controlsId:'redactControls' });
wirePdfUpload({ toolName:'signature',  inputId:'signatureFileInput',  zoneId:'signatureUploadZone',  infoId:'signatureFileInfo',  controlsId:'signatureControls' });
wirePdfUpload({ toolName:'security',   inputId:'securityFileInput',   zoneId:'securityUploadZone',   infoId:'securityFileInfo',   controlsId:'securityControls' });

/* ── RENDER ENGINE ── */
async function renderPageToCanvas(desc, scale) {
  const pdfPage = await desc.pdfJsDoc.getPage(desc.pageNum);
  const baseVp  = pdfPage.getViewport({ scale: 1 });
  const rotation = (baseVp.rotation + desc.rotation) % 360;
  const vp      = pdfPage.getViewport({ scale, rotation });
  const cv      = document.createElement('canvas');
  cv.width  = Math.ceil(vp.width);
  cv.height = Math.ceil(vp.height);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
  drawOverlaysOnCanvas(cv, desc.overlays, vp);
  return { canvas: cv, viewport: vp };
}

function drawOverlaysOnCanvas(canvas, overlays, vp) {
  if (!overlays?.length) return;
  const ctx = canvas.getContext('2d'), sc = vp.scale;
  overlays.forEach(o => {
    ctx.save();
    if (o.type === 'text') {
      const weight = o.bold   ? 'bold '   : '';
      const style2 = o.italic ? 'italic ' : '';
      const face   = o.font   || 'Arial';
      ctx.font      = `${style2}${weight}${o.size * sc}px ${face}`;
      ctx.fillStyle = o.color || '#000';
      ctx.fillText(o.text, o.x * sc, o.y * sc + o.size * sc);
    } else if (o.type === 'image' || o.type === 'signature') {
      if (o.imgEl) ctx.drawImage(o.imgEl, o.x*sc, o.y*sc, o.w*sc, o.h*sc);
    } else if (o.type === 'watermark') {
      const cW = canvas.width, cH = canvas.height;
      // Use fractional position if set, else default to centre
      const cx = o.xFrac !== undefined ? cW * o.xFrac : cW / 2;
      const cy = o.yFrac !== undefined ? cH * o.yFrac : cH / 2;
      ctx.globalAlpha = o.opacity;
      ctx.translate(cx, cy);
      ctx.rotate((o.angle || 0) * Math.PI / 180);
      if (o.imgEl) {
        ctx.drawImage(o.imgEl, -o.w*sc/2, -o.h*sc/2, o.w*sc, o.h*sc);
      } else {
        const weight = o.bold   ? 'bold '   : '';
        const style  = o.italic ? 'italic ' : '';
        ctx.font         = `${style}${weight}${(o.size||60) * sc}px ${o.font||'Arial'}`;
        ctx.fillStyle    = o.color || '#000';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.text, 0, 0);
      }
    } else if (o.type === 'pagenumber' || o.type === 'pagenumber_preview') {
      ctx.font = `${o.size * sc}px Arial`; ctx.fillStyle = o.color || '#333';
      ctx.textAlign = o.align || 'center';
      ctx.fillText(o.text, o.x * sc, o.y * sc);
    } else if (o.type === 'annotation') {
      drawAnnotation(ctx, o, sc);
    } else if (o.type === 'redact') {
      ctx.fillStyle = o.color || '#000';
      ctx.fillRect(o.x*sc, o.y*sc, o.w*sc, o.h*sc);
    }
    ctx.restore();
  });
}

function drawAnnotation(ctx, o, sc) {
  ctx.strokeStyle = o.color; ctx.lineWidth = o.size * sc;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (o.tool === 'freehand') {
    if (!o.points?.length) return;
    ctx.beginPath(); ctx.moveTo(o.points[0].x*sc, o.points[0].y*sc);
    o.points.slice(1).forEach(p => ctx.lineTo(p.x*sc, p.y*sc)); ctx.stroke();
  } else if (o.tool === 'highlight') {
    ctx.globalAlpha = 0.35; ctx.fillStyle = o.color;
    ctx.fillRect(o.x*sc, o.y*sc, o.w*sc, o.h*sc);
  } else if (o.tool === 'rect') {
    ctx.strokeRect(o.x*sc, o.y*sc, o.w*sc, o.h*sc);
  } else if (o.tool === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((o.x+o.w/2)*sc, (o.y+o.h/2)*sc, Math.abs(o.w/2)*sc, Math.abs(o.h/2)*sc, 0, 0, Math.PI*2);
    ctx.stroke();
  } else if (o.tool === 'line') {
    ctx.beginPath(); ctx.moveTo(o.x*sc, o.y*sc); ctx.lineTo((o.x+o.w)*sc, (o.y+o.h)*sc); ctx.stroke();
  } else if (o.tool === 'arrow') {
    const ex=(o.x+o.w)*sc, ey=(o.y+o.h)*sc, sx=o.x*sc, sy=o.y*sc;
    const angle = Math.atan2(ey-sy, ex-sx), hw = Math.max(8, o.size*sc*3);
    ctx.beginPath(); ctx.moveTo(sx,sy); ctx.lineTo(ex,ey); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - hw*Math.cos(angle-Math.PI/6), ey - hw*Math.sin(angle-Math.PI/6));
    ctx.lineTo(ex - hw*Math.cos(angle+Math.PI/6), ey - hw*Math.sin(angle+Math.PI/6));
    ctx.closePath(); ctx.fillStyle = o.color; ctx.fill();
  }
}

async function previewMain(pg) {
  if (!S.pages.length) return;
  pg = Math.max(1, Math.min(pg ?? S.curPage, S.totalPages));
  S.curPage = pg;
  const { canvas } = await renderPageToCanvas(S.pages[pg - 1], CFG.PREVIEW_SCALE * S.zoom);
  const cv = $('previewCanvas');
  cv.width = canvas.width; cv.height = canvas.height;
  cv.getContext('2d').drawImage(canvas, 0, 0);
  show(cv); hide($('previewPlaceholder'));
  $('drawingLayer').width  = cv.width; $('drawingLayer').height  = cv.height;
  $('placementOverlay').width = cv.width; $('placementOverlay').height = cv.height;
  updateNav();

  // Fit textBoxLayer exactly over the canvas after layout completes
  requestAnimationFrame(() => {
    const layer = $('textBoxLayer');
    const wrap  = $('previewWrap');
    const wRect = wrap.getBoundingClientRect();
    const cRect = cv.getBoundingClientRect();
    // Position relative to the wrap (scrollable container)
    layer.style.top    = (cRect.top  - wRect.top  + wrap.scrollTop)  + 'px';
    layer.style.left   = (cRect.left - wRect.left + wrap.scrollLeft) + 'px';
    layer.style.width  = cRect.width  + 'px';
    layer.style.height = cRect.height + 'px';
    if (typeof tbSyncToPage === 'function') tbSyncToPage(pg);

    // Keep watermark preview canvas in sync
    const wmc = $('wmPreviewCanvas');
    wmc.style.top  = cv.offsetTop  + 'px';
    wmc.style.left = cv.offsetLeft + 'px';
    if (typeof wmDrawPreview === 'function') wmDrawPreview();

    // Keep signature placement layer in sync (scroll-aware)
    const spl = $('sigPlacementLayer');
    spl.style.top    = (cRect.top  - wRect.top  + wrap.scrollTop)  + 'px';
    spl.style.left   = (cRect.left - wRect.left + wrap.scrollLeft) + 'px';
    spl.style.width  = cRect.width  + 'px';
    spl.style.height = cRect.height + 'px';

    // Sync redact layer (scroll-aware)
    if (typeof rdSyncLayer === 'function') { rdSyncLayer(); rdRenderBoxes(); }
  });
}

function updateNav() {
  $('pageIndicator').textContent = S.totalPages ? `${S.curPage} / ${S.totalPages}` : '— / —';
  $('prevPage').disabled = !S.totalPages || S.curPage <= 1;
  $('nextPage').disabled = !S.totalPages || S.curPage >= S.totalPages;
}
function updateDownloadBtn() {
  $('downloadBtn').disabled = !S.pages.length;
}
$('prevPage').addEventListener('click', () => previewMain(S.curPage - 1));
$('nextPage').addEventListener('click', () => previewMain(S.curPage + 1));
$('zoomIn').addEventListener('click',  () => { S.zoom = Math.min(CFG.ZOOM_MAX, +(S.zoom+CFG.ZOOM_STEP).toFixed(2)); $('zoomLabel').textContent = Math.round(S.zoom*100)+'%'; previewMain(); });
$('zoomOut').addEventListener('click', () => { S.zoom = Math.max(CFG.ZOOM_MIN, +(S.zoom-CFG.ZOOM_STEP).toFixed(2)); $('zoomLabel').textContent = Math.round(S.zoom*100)+'%'; previewMain(); });

/* ── PLACEMENT OVERLAY ── */
function clearPlacementOverlay() {
  const ov = $('placementOverlay'); if (!ov) return;
  ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  ov.style.pointerEvents = 'none';
  $('previewWrap').classList.remove('placement-active');
}
$('placementOverlay').addEventListener('click', e => {
  if (!S.placeMode) return;
  const ov = $('placementOverlay'), rect = ov.getBoundingClientRect();
  const cx = (e.clientX-rect.left)*(ov.width/rect.width);
  const cy = (e.clientY-rect.top)*(ov.height/rect.height);
  const sc = CFG.PREVIEW_SCALE * S.zoom;
  const px = Math.round(cx/sc), py = Math.round(cy/sc);
  if (S.placeMode==='text')      { $('textX').value=px; $('textY').value=py; }
  if (S.placeMode==='image')     { $('imgX').value=px;  $('imgY').value=py; }
  const ctx = ov.getContext('2d');
  ctx.clearRect(0,0,ov.width,ov.height);
  ctx.strokeStyle='#4f8ef7'; ctx.lineWidth=1.5; ctx.setLineDash([5,3]);
  ctx.beginPath(); ctx.moveTo(0,cy); ctx.lineTo(ov.width,cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx,0); ctx.lineTo(cx,ov.height); ctx.stroke();
  ctx.setLineDash([]); ctx.fillStyle='#4f8ef7';
  ctx.beginPath(); ctx.arc(cx,cy,5,0,Math.PI*2); ctx.fill();
  ctx.font='bold 11px monospace'; ctx.fillText(`(${px},${py})`,cx+8,cy-5);
  toast(`Position → X:${px}  Y:${py}`, 'success', 2000);
});
function setPlaceMode(mode, btnId) {
  S.placeMode = S.placeMode===mode ? null : mode;
  ['imgPickBtn'].forEach(id => {
    const b=$(id); if(!b) return;
    b.classList.remove('active-pick');
    b.innerHTML='<i class="fa-solid fa-crosshairs"></i> Pick on Page';
  });
  const ov = $('placementOverlay');
  if (S.placeMode) {
    ov.style.pointerEvents='all';
    $('previewWrap').classList.add('placement-active');
    const b=$(btnId);
    if(b){b.classList.add('active-pick');b.innerHTML='<i class="fa-solid fa-xmark"></i> Cancel';}
    toast('Click on the preview to set position.','info',3000);
  } else { clearPlacementOverlay(); }
}
$('imgPickBtn').addEventListener('click', () => setPlaceMode('image','imgPickBtn'));

/* ── BUILD PDF ── */
async function buildPdf(pageDescs, quality = 0.92) {
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pageDescs.length; i++) {
    loading(true, `Building PDF… ${i+1} / ${pageDescs.length}`);
    const { canvas } = await renderPageToCanvas(pageDescs[i], CFG.RENDER_SCALE);
    const img = await doc.embedJpg(dataUrlToBytes(canvas.toDataURL('image/jpeg', quality)));
    const pg1 = await pageDescs[i].pdfJsDoc.getPage(pageDescs[i].pageNum);
    const rot = (pg1.getViewport({scale:1}).rotation + pageDescs[i].rotation) % 360;
    const vp1 = pg1.getViewport({ scale:1, rotation:rot });
    const page = doc.addPage([vp1.width, vp1.height]);
    page.drawImage(img, { x:0, y:0, width:vp1.width, height:vp1.height });
  }
  return doc.save();
}

/* ── MERGE ── */
async function addMergeFiles(files) {
  loading(true, 'Loading…');
  try {
    for (const f of Array.from(files)) {
      if (f.type !== 'application/pdf') { toast(`Not a PDF: ${f.name}`, 'error'); continue; }
      if (!okSize(f)) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const doc   = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      S.mergeSources.push({ name: f.name, pdfJsDoc: doc, curPage: 1 });
    }
    S._mergeViewIdx = Math.max(0, S.mergeSources.length - 1);
    refreshMergeList(); await refreshMergePreview();
  } catch(e) { console.error(e); toast(e.message, 'error'); }
  finally { loading(false); }
}
function refreshMergeList() {
  const list = $('mergeList'); list.innerHTML = '';
  S.mergeSources.forEach((src, i) => {
    const li = document.createElement('li');
    li.className = 'merge-item' + (i === S._mergeViewIdx ? ' active' : '');
    li.innerHTML = `<i class="fa-solid fa-file-pdf"></i>
      <span class="merge-item-name" title="${src.name}">${src.name}</span>
      <small class="merge-item-size">${src.pdfJsDoc.numPages}p</small>
      <button class="icon-btn" onclick="viewMergeDoc(${i})"><i class="fa-solid fa-eye"></i></button>
      <button class="icon-btn danger" onclick="removeMergeDoc(${i})"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(li);
  });
  $('mergeBtn').disabled = S.mergeSources.length < 2;
  const src = S.mergeSources[S._mergeViewIdx];
  $('mergeDocLabel').textContent = src ? `${src.name.slice(0,22)} — pg ${src.curPage}/${src.pdfJsDoc.numPages}` : 'No PDFs added yet';
  $('mergePrevDoc').disabled = S._mergeViewIdx <= 0;
  $('mergeNextDoc').disabled = S._mergeViewIdx >= S.mergeSources.length - 1;
  $('mergePrevPg').disabled  = !src || src.curPage <= 1;
  $('mergeNextPg').disabled  = !src || src.curPage >= src.pdfJsDoc.numPages;
}
window.viewMergeDoc   = i => { S._mergeViewIdx=i; S.mergeSources[i].curPage=1; refreshMergeList(); refreshMergePreview(); };
window.removeMergeDoc = i => { S.mergeSources.splice(i,1); S._mergeViewIdx=Math.max(0,Math.min(S._mergeViewIdx,S.mergeSources.length-1)); refreshMergeList(); refreshMergePreview(); };

async function refreshMergePreview() {
  const cv=$('mergePreviewCanvas'), ph=$('mergePreviewPlaceholder');
  const src = S.mergeSources[S._mergeViewIdx];
  if (!src) { hide(cv); show(ph); refreshMergeList(); return; }
  src.curPage = Math.max(1, Math.min(src.curPage, src.pdfJsDoc.numPages));
  const pg = await src.pdfJsDoc.getPage(src.curPage);
  const vp = pg.getViewport({ scale: CFG.PREVIEW_SCALE });
  cv.width = vp.width; cv.height = vp.height; show(cv); hide(ph);
  await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  refreshMergeList();
}

$('mergeInput').addEventListener('change', async e => { await addMergeFiles(e.target.files); e.target.value=''; });
const muz = $('mergeUploadZone');
muz.addEventListener('dragover',  e => { e.preventDefault(); muz.classList.add('drag-over'); });
muz.addEventListener('dragleave', () => muz.classList.remove('drag-over'));
muz.addEventListener('drop', async e => { e.preventDefault(); muz.classList.remove('drag-over'); await addMergeFiles(e.dataTransfer.files); });
$('mergePrevDoc').addEventListener('click',()=>{S._mergeViewIdx--;S.mergeSources[S._mergeViewIdx].curPage=1;refreshMergeList();refreshMergePreview();});
$('mergeNextDoc').addEventListener('click',()=>{S._mergeViewIdx++;S.mergeSources[S._mergeViewIdx].curPage=1;refreshMergeList();refreshMergePreview();});
$('mergePrevPg').addEventListener('click',()=>{const s=S.mergeSources[S._mergeViewIdx];if(s){s.curPage--;refreshMergePreview();}});
$('mergeNextPg').addEventListener('click',()=>{const s=S.mergeSources[S._mergeViewIdx];if(s){s.curPage++;refreshMergePreview();}});
$('mergeBtn').addEventListener('click', async () => {
  if (S.mergeSources.length < 2) return;
  loading(true,'Merging…');
  try {
    const descs = S.mergeSources.flatMap(src =>
      Array.from({length:src.pdfJsDoc.numPages},(_,i)=>({pdfJsDoc:src.pdfJsDoc,pageNum:i+1,rotation:0,overlays:[]})));
    dlBytes(await buildPdf(descs), 'merged.pdf');
    toast(`Merged ${S.mergeSources.length} PDFs!`, 'success');
  } catch(e) { console.error(e); toast(`Merge failed: ${e.message}`, 'error'); }
  finally { loading(false); }
});

/* ── SPLIT ── */
function updateSplitHint() {
  const n = S.toolPages['split']?.length || 0;
  $('splitPageCount').textContent = n ? `Document has ${n} pages` : '';
  if (n) { $('splitTo').value=n; $('splitFrom').max=$('splitTo').max=n; }
}
$('splitBtn').addEventListener('click', async () => {
  const pages = S.toolPages['split']; if (!pages?.length) return;
  const from=parseInt($('splitFrom').value,10), to=parseInt($('splitTo').value,10);
  if (!Number.isFinite(from)||!Number.isFinite(to)||from<1||to>pages.length||from>to){toast('Invalid range.','error');return;}
  loading(true,'Splitting…');
  try { dlBytes(await buildPdf(pages.slice(from-1,to)), `pages_${from}-${to}.pdf`); toast(`Pages ${from}–${to} extracted!`,'success'); }
  catch(e){ console.error(e); toast(`Split failed: ${e.message}`,'error'); }
  finally { loading(false); }
});


/* ── COMPRESS ── */
document.querySelectorAll('.compress-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.compress-opt').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    S.compressQuality = parseFloat(opt.dataset.quality);
  });
});
$('compressBtn').addEventListener('click', async () => {
  const pages = S.toolPages['compress']; if (!pages?.length) return;
  loading(true,'Compressing…');
  try { dlBytes(await buildPdf(pages, S.compressQuality), 'compressed.pdf'); toast('Compressed PDF downloaded!','success'); }
  catch(e){ console.error(e); toast(`Compress failed: ${e.message}`,'error'); }
  finally { loading(false); }
});

/* ── IMAGES TO PDF ── */
async function addImgToPdfFiles(files) {
  for (const f of Array.from(files)) {
    if (!f.type.startsWith('image/')) { toast(`Not an image: ${f.name}`,'error'); continue; }
    const imgEl = await loadImgEl(f);
    S.imgToPdfFiles.push({ file:f, imgEl });
  }
  refreshImgToPdfList();
}
function refreshImgToPdfList() {
  const list = $('imgToPdfList'); list.innerHTML='';
  S.imgToPdfFiles.forEach((item,i) => {
    const li = document.createElement('li');
    li.className = 'img-to-pdf-item';
    li.innerHTML = `<img src="${item.imgEl.src}" alt=""/>
      <span>${item.file.name}</span>
      <button class="icon-btn danger" onclick="removeImgFile(${i})"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(li);
  });
  $('imgToPdfBtn').disabled = S.imgToPdfFiles.length === 0;
  if (S.imgToPdfFiles.length > 1 && !S._imgSortable) {
    S._imgSortable = Sortable.create(list, { animation:150,
      onEnd(ev){const m=S.imgToPdfFiles.splice(ev.oldIndex,1)[0];S.imgToPdfFiles.splice(ev.newIndex,0,m);}
    });
  }
}
window.removeImgFile = i => { S.imgToPdfFiles.splice(i,1); refreshImgToPdfList(); };
const iuz = $('imgToPdfUploadZone');
$('imgToPdfInput').addEventListener('change', async e => { await addImgToPdfFiles(e.target.files); e.target.value=''; });
iuz.addEventListener('dragover',  e => { e.preventDefault(); iuz.classList.add('drag-over'); });
iuz.addEventListener('dragleave', () => iuz.classList.remove('drag-over'));
iuz.addEventListener('drop', async e => { e.preventDefault(); iuz.classList.remove('drag-over'); await addImgToPdfFiles(e.dataTransfer.files); });
$('imgToPdfBtn').addEventListener('click', async () => {
  if (!S.imgToPdfFiles.length) return;
  loading(true,'Converting images…');
  try {
    const doc = await PDFLib.PDFDocument.create();
    const sizes = { A4:[595.28,841.89], Letter:[612,792] };
    const psize = $('imgToPdfPageSize').value;
    const ori   = $('imgToPdfOrientation').value;
    for (const item of S.imgToPdfFiles) {
      const cv = document.createElement('canvas');
      cv.width=item.imgEl.naturalWidth; cv.height=item.imgEl.naturalHeight;
      cv.getContext('2d').drawImage(item.imgEl,0,0);
      const img = await doc.embedJpg(dataUrlToBytes(cv.toDataURL('image/jpeg',0.92)));
      const iw=item.imgEl.naturalWidth, ih=item.imgEl.naturalHeight;
      let pw,ph;
      if (psize==='fit') { pw=iw; ph=ih; }
      else { [pw,ph]=(sizes[psize]||sizes.A4); if(ori==='landscape')[pw,ph]=[ph,pw]; }
      const page=doc.addPage([pw,ph]);
      const sc=Math.min(pw/iw,ph/ih);
      page.drawImage(img,{x:(pw-iw*sc)/2,y:(ph-ih*sc)/2,width:iw*sc,height:ih*sc});
    }
    dlBytes(await doc.save(),'images.pdf');
    toast(`Converted ${S.imgToPdfFiles.length} image(s) to PDF!`,'success');
  } catch(e){ console.error(e); toast(`Failed: ${e.message}`,'error'); }
  finally { loading(false); }
});

/* ── PAGE GRID (pages tool) ── */
let sortable = null;
async function renderGrid() {
  const pages = S.toolPages['pages']; if (!pages?.length) return;
  const grid = $('pageGrid'); grid.innerHTML = '';
  loading(true,'Rendering thumbnails…');
  try {
    for (let i=0;i<pages.length;i++) {
      const {canvas} = await renderPageToCanvas(pages[i], CFG.THUMB_SCALE);
      const thumb = document.createElement('div');
      thumb.className = 'page-thumb'+(S.selectedPgs.has(i)?' selected':'');
      thumb.dataset.idx = i;
      canvas.style.cssText='width:100%;height:auto;display:block';
      const lbl = document.createElement('div');
      lbl.className='page-thumb-label'; lbl.textContent=`Page ${i+1}`;
      const chk = document.createElement('div');
      chk.className='page-thumb-select';
      chk.innerHTML='<i class="fa-solid fa-check" style="font-size:.6rem"></i>';
      thumb.append(canvas,lbl,chk);
      if (pages[i].rotation) {
        const rb=document.createElement('div');
        rb.className='page-rotation-badge'; rb.textContent=`${pages[i].rotation}°`;
        thumb.appendChild(rb);
      }
      thumb.addEventListener('click',()=>{
        const idx=+thumb.dataset.idx;
        if(S.selectedPgs.has(idx)){S.selectedPgs.delete(idx);thumb.classList.remove('selected');}
        else{S.selectedPgs.add(idx);thumb.classList.add('selected');}
        updateGridBtns();
      });
      grid.appendChild(thumb);
    }
    if(sortable) sortable.destroy();
    sortable=Sortable.create(grid,{animation:150,ghostClass:'sortable-ghost',onEnd(ev){
      const p=S.toolPages['pages'];
      const m=p.splice(ev.oldIndex,1)[0]; p.splice(ev.newIndex,0,m);
      grid.querySelectorAll('.page-thumb').forEach((el,i)=>{el.dataset.idx=i;el.querySelector('.page-thumb-label').textContent=`Page ${i+1}`;});
      S.selectedPgs.clear();
      // Update preview to show new page order
      const newCur = Math.min(S.curPage, p.length);
      previewMain(newCur);
      toast('Reordered. Download to save.','info');
    }});
  } finally { loading(false); }
  updateGridBtns();
}
function updateGridBtns(){const h=S.selectedPgs.size>0;$('deleteSelectedBtn').disabled=!h;$('rotateLeftBtn').disabled=!h;$('rotateRightBtn').disabled=!h;}
$('selectAllBtn').addEventListener('click',()=>{const p=S.toolPages['pages']||[];p.forEach((_,i)=>S.selectedPgs.add(i));document.querySelectorAll('.page-thumb').forEach(t=>t.classList.add('selected'));updateGridBtns();});
$('deselectAllBtn').addEventListener('click',()=>{S.selectedPgs.clear();document.querySelectorAll('.page-thumb').forEach(t=>t.classList.remove('selected'));updateGridBtns();});
$('deleteSelectedBtn').addEventListener('click',async()=>{
  const p=S.toolPages['pages']||[];
  if(!S.selectedPgs.size||S.selectedPgs.size>=p.length){toast('Cannot delete all pages.','error');return;}
  if(!confirm(`Delete ${S.selectedPgs.size} page(s)?`))return;
  [...S.selectedPgs].sort((a,b)=>b-a).forEach(i=>p.splice(i,1));
  S.selectedPgs.clear();
  await renderGrid();
  if(S.activeTool==='pages') previewMain(Math.min(S.curPage,p.length));
  toast('Deleted.','success');
});
async function rotateSel(deg){
  const p=S.toolPages['pages']||[]; if(!S.selectedPgs.size)return;
  S.selectedPgs.forEach(i=>{p[i].rotation=(p[i].rotation+deg+360)%360;});
  S.selectedPgs.clear();
  await renderGrid();
  if(S.activeTool==='pages') previewMain(S.curPage);
  toast(`Rotated.`,'success');
}
$('rotateLeftBtn').addEventListener('click',()=>rotateSel(-90));
$('rotateRightBtn').addEventListener('click',()=>rotateSel(90));

/* ── ANNOTATE ── */
document.querySelectorAll('.annotate-tool-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.annotate-tool-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); S.annoteTool=btn.dataset.atool;
  });
});
const dl=$('drawingLayer');
function getDrawPos(e){
  // Always measure against previewCanvas, not drawingLayer, to avoid CSS offset issues
  const cv=document.getElementById('previewCanvas');
  const rect=cv.getBoundingClientRect(),src=e.touches?e.touches[0]:e;
  return{x:(src.clientX-rect.left)*(cv.width/rect.width),y:(src.clientY-rect.top)*(cv.height/rect.height)};
}
function enterAnnotateMode(){
  show(dl); dl.classList.add('active');
  $('previewWrap').classList.add('drawing-active'); S.annoteStrokes=[];
}
function exitAnnotateMode(){
  dl.getContext('2d').clearRect(0,0,dl.width,dl.height);
  hide(dl); dl.classList.remove('active');
  $('previewWrap').classList.remove('drawing-active');
}
function redrawAnnoteLayer(){
  const ctx=dl.getContext('2d'); ctx.clearRect(0,0,dl.width,dl.height);
  const sc=CFG.PREVIEW_SCALE*S.zoom;
  S.annoteStrokes.forEach(o=>drawAnnotation(ctx,o,sc));
}
dl.addEventListener('mousedown',e=>{
  if(!$('previewWrap').classList.contains('drawing-active'))return;
  e.preventDefault(); S.annoteDrawing=true;
  const p=getDrawPos(e),sc=CFG.PREVIEW_SCALE*S.zoom;
  const color=$('annotateColor').value,size=+$('annotateSize').value;
  if(S.annoteTool==='freehand'){S.annoteCurStroke={type:'annotation',tool:'freehand',color,size,points:[{x:p.x/sc,y:p.y/sc}]};}
  else{S.annoteStart=p;S.annoteCurStroke={type:'annotation',tool:S.annoteTool,color,size,x:p.x/sc,y:p.y/sc,w:0,h:0};}
});
dl.addEventListener('mousemove',e=>{
  if(!S.annoteDrawing||!S.annoteCurStroke)return; e.preventDefault();
  const p=getDrawPos(e),sc=CFG.PREVIEW_SCALE*S.zoom;
  if(S.annoteTool==='freehand'){S.annoteCurStroke.points.push({x:p.x/sc,y:p.y/sc});}
  else{const st=S.annoteStart;S.annoteCurStroke.w=(p.x-st.x)/sc;S.annoteCurStroke.h=(p.y-st.y)/sc;}
  redrawAnnoteLayer(); drawAnnotation(dl.getContext('2d'),S.annoteCurStroke,sc);
});
dl.addEventListener('mouseup',()=>{if(!S.annoteDrawing)return;S.annoteDrawing=false;if(S.annoteCurStroke){S.annoteStrokes.push(S.annoteCurStroke);S.annoteCurStroke=null;}redrawAnnoteLayer();});
dl.addEventListener('mouseleave',()=>{if(S.annoteDrawing){S.annoteDrawing=false;if(S.annoteCurStroke){S.annoteStrokes.push(S.annoteCurStroke);S.annoteCurStroke=null;}redrawAnnoteLayer();}});
$('annotateUndoBtn').addEventListener('click',()=>{S.annoteStrokes.pop();redrawAnnoteLayer();});
$('annotateClearBtn').addEventListener('click',()=>{S.annoteStrokes=[];redrawAnnoteLayer();});
$('annotateApplyBtn').addEventListener('click',async()=>{
  const pages=S.toolPages['annotate']; if(!pages?.length)return;
  const pgNum=parseInt($('annotatePage').value,10);
  if(pgNum<1||pgNum>pages.length){toast(`Page must be 1–${pages.length}.`,'error');return;}
  pages[pgNum-1].overlays.push(...S.annoteStrokes);
  S.annoteStrokes=[]; exitAnnotateMode();
  await previewMain(pgNum); enterAnnotateMode();
  toast('Annotations applied!','success');
});

/* ══════════════════════════════════════════════════════════════
   TEXT TOOL  —  SimplePDF-style inline text boxes
   
   How it works:
   1. textBoxLayer (absolute div over canvas) receives clicks
   2. Click on empty space → create box at cursor
   3. Each box: contenteditable div + ✕ delete btn + SE resize handle
   4. Clicking box border (not content) → drag to move
   5. Float toolbar appears above selected box (font/size/color/B/I/delete)
   6. Apply → compute PDF coords via canvas bounding rect, burn in
   
   Coordinate system:
   - Boxes are positioned relative to textBoxLayer
   - textBoxLayer overlaps the canvas exactly (same inset as canvas padding)
   - On apply: box.left/top → canvas-relative → PDF-space via viewport scale
══════════════════════════════════════════════════════════════ */

const TB = {
  boxes:      [],      // { id, el, contentEl, page }
  nextId:     1,
  active:     false,
  selectedId: null,
};

// ── Grab float bar elements ────────────────────────
const tbFB    = () => $('tbFloatBar');
const tbFFont = () => $('tbFloatFont');
const tbFSize = () => $('tbFloatSize');
const tbFClr  = () => $('tbFloatColor');
const tbFBold = () => $('tbFloatBold');
const tbFItal = () => $('tbFloatItalic');

// ── Helper: read default style from sidebar ────────
function tbDefaultStyle() {
  return {
    font:   $('tbDefFont')?.value  || 'Arial',
    size:   parseInt($('tbDefSize')?.value)  || 16,
    color:  $('tbDefColor')?.value || '#000000',
    bold:   !!$('tbDefBold')?.classList.contains('active'),
    italic: !!$('tbDefItalic')?.classList.contains('active'),
  };
}

// ── Apply a style object to a DOM element ─────────
function tbApplyStyleToEl(el, s) {
  el.style.fontFamily = s.font;
  el.style.fontSize   = s.size + 'px';
  el.style.color      = s.color;
  el.style.fontWeight = s.bold   ? 'bold'   : 'normal';
  el.style.fontStyle  = s.italic ? 'italic' : 'normal';
}

// ── Mode enter/exit ───────────────────────────────
function tbEnter() {
  TB.active = true;
  $('previewWrap').classList.add('text-mode');
  $('textBoxLayer').classList.add('active');
}
function tbExit() {
  TB.active = false;
  $('previewWrap').classList.remove('text-mode');
  $('textBoxLayer').classList.remove('active');
  tbDeselect();
}
function tbCheckEnter() {
  if (S.activeTool === 'text' && S.toolPages['text']?.length) tbEnter();
  else tbExit();
}

// ── Float bar positioning ─────────────────────────
function tbPositionBar(boxEl) {
  const fb = tbFB(); if (!fb) return;
  const br  = boxEl.getBoundingClientRect();
  const fbH = fb.offsetHeight || 42;
  const fbW = fb.offsetWidth  || 310;
  let top  = br.top - fbH - 10;
  if (top < 60) top = br.bottom + 10;                 // flip below if no space
  let left = br.left;
  if (left + fbW > window.innerWidth - 8) left = window.innerWidth - fbW - 8;
  fb.style.top  = Math.max(4, top) + 'px';
  fb.style.left = Math.max(4, left) + 'px';
  fb.classList.remove('hidden');
}
function tbHideBar() { tbFB()?.classList.add('hidden'); }

// ── Selection ────────────────────────────────────
function tbSelect(id) {
  TB.selectedId = id;
  TB.boxes.forEach(b => b.el.classList.toggle('selected', b.id === id));
  const box = TB.boxes.find(b => b.id === id);
  if (!box) return;
  // Sync float bar to this box's current computed style
  const ce = box.contentEl;
  const cs = window.getComputedStyle(ce);
  const ff = tbFFont(), fs = tbFSize(), fc = tbFClr(), fb2 = tbFBold(), fi = tbFItal();
  if (ff) ff.value = cs.fontFamily.replace(/['"]/g, '').split(',')[0].trim();
  if (fs) fs.value = Math.round(parseFloat(cs.fontSize));
  if (fc) fc.value = rgbToHex(cs.color);
  if (fb2) fb2.classList.toggle('active', cs.fontWeight === 'bold' || parseInt(cs.fontWeight) >= 700);
  if (fi)  fi.classList.toggle('active',  cs.fontStyle === 'italic');
  tbPositionBar(box.el);
}
function tbDeselect() {
  TB.selectedId = null;
  TB.boxes.forEach(b => b.el.classList.remove('selected'));
  tbHideBar();
}

// ── Float bar → apply style to selected box ──────
function tbApplyFloat() {
  const box = TB.boxes.find(b => b.id === TB.selectedId);
  if (!box) return;
  const s = {
    font:   tbFFont()?.value || 'Arial',
    size:   parseInt(tbFSize()?.value) || 16,
    color:  tbFClr()?.value  || '#000000',
    bold:   !!tbFBold()?.classList.contains('active'),
    italic: !!tbFItal()?.classList.contains('active'),
  };
  tbApplyStyleToEl(box.contentEl, s);
}

// Wire float bar events
['tbFloatFont','tbFloatSize','tbFloatColor'].forEach(id => {
  $(id)?.addEventListener('input',  tbApplyFloat);
  $(id)?.addEventListener('change', tbApplyFloat);
});
$('tbFloatBold')?.addEventListener('click', () => {
  $('tbFloatBold').classList.toggle('active'); tbApplyFloat();
});
$('tbFloatItalic')?.addEventListener('click', () => {
  $('tbFloatItalic').classList.toggle('active'); tbApplyFloat();
});
$('tbFloatDel')?.addEventListener('click', () => {
  if (TB.selectedId !== null) tbRemove(TB.selectedId);
});
$('tbFloatDup')?.addEventListener('click', () => {
  const box = TB.boxes.find(b => b.id === TB.selectedId);
  if (!box) return;
  const x = parseFloat(box.el.style.left) + 16;
  const y = parseFloat(box.el.style.top)  + 16;
  const nb = tbCreate(x, y);
  nb.contentEl.innerHTML = box.contentEl.innerHTML;
  // Copy styles
  const cs = window.getComputedStyle(box.contentEl);
  nb.contentEl.style.cssText = box.contentEl.style.cssText;
  tbSelect(nb.id);
});

// Wire sidebar default buttons
$('tbDefBold')?.addEventListener('click',   () => $('tbDefBold').classList.toggle('active'));
$('tbDefItalic')?.addEventListener('click', () => $('tbDefItalic').classList.toggle('active'));

// ── Create a text box ─────────────────────────────
function tbCreate(xPx, yPx) {
  const s  = tbDefaultStyle();
  const id = TB.nextId++;

  // Outer wrapper
  const box       = document.createElement('div');
  box.className   = 'inline-textbox';
  box.dataset.tbid = String(id);
  box.style.left  = xPx + 'px';
  box.style.top   = yPx + 'px';

  // Editable content
  const content = document.createElement('div');
  content.className       = 'tb-content';
  content.contentEditable = 'true';
  content.spellcheck      = false;
  content.dataset.placeholder = 'Type here…';
  tbApplyStyleToEl(content, s);

  // ✕ Delete button
  const del       = document.createElement('button');
  del.className   = 'tb-delete';
  del.textContent = '✕';
  del.title       = 'Delete box';
  del.addEventListener('mousedown', e => { e.stopPropagation(); e.preventDefault(); });
  del.addEventListener('click',     e => { e.stopPropagation(); tbRemove(id); });

  // SE resize handle
  const rz      = document.createElement('div');
  rz.className  = 'tb-resize-handle';
  rz.title      = 'Drag to resize';

  box.appendChild(content);
  box.appendChild(del);
  box.appendChild(rz);
  $('textBoxLayer').appendChild(box);

  // ── Drag / resize logic ────────────────────────
  let dragMode = null, dsx, dsy, dox, doy, dow, doh;

  const startDrag = (mode, e) => {
    dragMode = mode;
    dsx = e.clientX; dsy = e.clientY;
    dox = parseFloat(box.style.left)  || 0;
    doy = parseFloat(box.style.top)   || 0;
    dow = box.offsetWidth;
    doh = box.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  };

  box.addEventListener('mousedown', e => {
    tbSelect(id);
    // Resize handle
    if (e.target === rz) { startDrag('resize', e); return; }
    // Content → don't drag, allow typing
    if (e.target === content || e.target.closest('.tb-content')) {
      e.stopPropagation(); return;
    }
    // Delete btn → handled separately
    if (e.target === del) return;
    // Anything else on the box (border) → move
    startDrag('move', e);
  });

  const onMouseMove = e => {
    if (!dragMode) return;
    const dx = e.clientX - dsx, dy = e.clientY - dsy;
    if (dragMode === 'move') {
      box.style.left = (dox + dx) + 'px';
      box.style.top  = (doy + dy) + 'px';
      if (TB.selectedId === id) tbPositionBar(box); // keep toolbar aligned
    } else {
      box.style.width  = Math.max(60,  dow + dx) + 'px';
      box.style.height = Math.max(24, doh + dy) + 'px';
    }
  };
  const onMouseUp = () => { dragMode = null; };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup',   onMouseUp);

  // Focus → select
  content.addEventListener('focus', () => tbSelect(id));

  const cv = $('previewCanvas');
  const record = {
    id, el: box, contentEl: content,
    page:    S.curPage,
    canvasW: cv.offsetWidth,   // display size at creation — used for PDF coord scaling
    canvasH: cv.offsetHeight,
  };
  TB.boxes.push(record);
  tbUpdateApplyBtn();
  tbSelect(id);
  setTimeout(() => { content.focus(); placeCursorAtEnd(content); }, 20);
  return record;
}

// ── Helpers ───────────────────────────────────────
function placeCursorAtEnd(el) {
  const range = document.createRange();
  const sel   = window.getSelection();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function rgbToHex(rgb) {
  const m = rgb.match(/\d+/g);
  if (!m || m.length < 3) return '#000000';
  return '#' + m.slice(0,3).map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
}

// ── Remove / clear ────────────────────────────────
function tbRemove(id) {
  const idx = TB.boxes.findIndex(b => b.id === id);
  if (idx === -1) return;
  TB.boxes[idx].el.remove();
  TB.boxes.splice(idx, 1);
  if (TB.selectedId === id) tbDeselect();
  tbUpdateApplyBtn();
}
function tbClearAll() {
  TB.boxes.forEach(b => b.el.remove());
  TB.boxes = [];
  tbDeselect();
  tbUpdateApplyBtn();
}
function tbUpdateApplyBtn() {
  const btn = $('addTextBtn');
  if (!btn) return;
  const total = TB.boxes.length;
  btn.disabled = total === 0;
  btn.innerHTML = total > 0
    ? `<i class="fa-solid fa-check"></i> Apply ${total} Text Box${total > 1 ? 'es' : ''} to PDF &amp; Download`
    : `<i class="fa-solid fa-check"></i> Apply Text to PDF &amp; Download`;
}

// Show only boxes for current page, hide others
function tbSyncToPage(pg) {
  TB.boxes.forEach(b => {
    const onThisPage = b.page === pg;
    b.el.style.display = onThisPage ? '' : 'none';
    if (!onThisPage && TB.selectedId === b.id) tbDeselect();
  });
}

// ── Click on empty layer → create new box ─────────
$('textBoxLayer').addEventListener('mousedown', e => {
  if (!TB.active) return;
  if (e.target !== $('textBoxLayer')) return; // only empty space
  const rect = $('textBoxLayer').getBoundingClientRect();
  tbCreate(e.clientX - rect.left, e.clientY - rect.top);
});

// ── Click outside boxes → deselect ───────────────
document.addEventListener('mousedown', e => {
  if (!TB.active) return;
  if (e.target.closest('.inline-textbox')) return;
  if (e.target.closest('#tbFloatBar'))     return;
  tbDeselect();
});

// ── Switch tool → exit text mode ─────────────────
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.panel !== 'text') tbExit();
  });
});

// ── Apply all boxes to PDF ────────────────────────
$('addTextBtn').addEventListener('click', async () => {
  const pages = S.toolPages['text'];
  if (!pages?.length) return;
  const validBoxes = TB.boxes.filter(b => b.contentEl.innerText.trim().length > 0);
  if (!validBoxes.length) { toast('Add some text first.', 'error'); return; }

  for (const box of validBoxes) {
    const text    = box.contentEl.innerText.trim();
    const pageIdx = (box.page || 1) - 1;
    if (!pages[pageIdx]) continue;

    // box.left/top are canvas-relative pixels (layer == canvas, no offset)
    const bx = parseFloat(box.el.style.left) || 0;
    const by = parseFloat(box.el.style.top)  || 0;

    // Scale from canvas display size → PDF coordinate space
    // Use the canvas size that was recorded when this box was created
    const canvasW = box.canvasW;
    const canvasH = box.canvasH;

    const pdfPage  = await pages[pageIdx].pdfJsDoc.getPage(pages[pageIdx].pageNum);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const scaleX   = viewport.width  / canvasW;
    const scaleY   = viewport.height / canvasH;

    const cs   = window.getComputedStyle(box.contentEl);
    const size = Math.round(parseFloat(cs.fontSize) * scaleX);

    pages[pageIdx].overlays.push({
      type:   'text',
      text,
      size,
      x:      bx * scaleX,
      y:      by * scaleY,
      color:  rgbToHex(cs.color),
      font:   cs.fontFamily.replace(/['"]/g,'').split(',')[0].trim(),
      bold:   cs.fontWeight === 'bold' || parseInt(cs.fontWeight) >= 700,
      italic: cs.fontStyle === 'italic',
    });
  }

  loading(true, 'Building PDF…');
  try {
    dlBytes(await buildPdf(pages), 'text-edited.pdf');
    toast('✓ Text applied & downloaded!', 'success');
    tbClearAll();
  } catch(e) {
    console.error('[TB apply]', e);
    toast(`Error: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
});

/* ── IMAGE OVERLAY ── */
$('addImageBtn').addEventListener('click',async()=>{
  const pages=S.toolPages['image']; if(!pages?.length)return;
  const fi=$('overlayImageInput'); if(!fi.files[0]){toast('Select an image.','error');return;}
  const pgNum=parseInt($('imgPage').value,10);
  if(pgNum<1||pgNum>pages.length){toast(`Page must be 1–${pages.length}.`,'error');return;}
  loading(true,'Loading image…');
  try{
    const imgEl=await loadImgEl(fi.files[0]);
    pages[pgNum-1].overlays.push({type:'image',imgEl,
      x:parseFloat($('imgX').value)||0,y:parseFloat($('imgY').value)||0,
      w:parseFloat($('imgW').value)||150,h:parseFloat($('imgH').value)||100});
    await previewMain(pgNum); setPlaceMode(null); toast('Image added!','success');
  }catch(e){toast(`Image error: ${e.message}`,'error');}
  finally{loading(false);}
});

/* ══════════════════════════════════════════════════
   WATERMARK  —  live preview, draggable, real-time styling
══════════════════════════════════════════════════ */

const WM = {
  // Position as fraction of canvas (0–1), default centre
  xFrac: 0.5,
  yFrac: 0.5,
  imgEl: null,      // loaded image element for image watermarks
  active: false,    // true when watermark panel is open & PDF loaded
};

// ── Tab switching ──────────────────────────────────
document.querySelectorAll('.tab-btn[data-wtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn[data-wtab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('wmTextTab').classList.toggle('hidden', btn.dataset.wtab !== 'text');
    $('wmImageTab').classList.toggle('hidden', btn.dataset.wtab !== 'image');
    wmDrawPreview();
  });
});

// ── Bold / Italic buttons ──────────────────────────
$('wmBold')?.addEventListener('click',   () => { $('wmBold').classList.toggle('active');   wmDrawPreview(); });
$('wmItalic')?.addEventListener('click', () => { $('wmItalic').classList.toggle('active'); wmDrawPreview(); });

// ── All live-update inputs ─────────────────────────
['wmText','wmFont','wmSize','wmColor','wmOpacity','wmAngle','wmImgW','wmImgH'].forEach(id => {
  $(id)?.addEventListener('input',  wmDrawPreview);
  $(id)?.addEventListener('change', wmDrawPreview);
});
$('wmOpacity').addEventListener('input', () => {
  $('wmOpacityVal').textContent = $('wmOpacity').value + '%';
  wmDrawPreview();
});

// Image upload → load & preview immediately
$('wmImageInput').addEventListener('change', async () => {
  const f = $('wmImageInput').files[0];
  if (!f) return;
  try { WM.imgEl = await loadImgEl(f); wmDrawPreview(); }
  catch(e) { toast(e.message, 'error'); }
});

// ── Build current watermark descriptor from UI ─────
function wmGetDesc() {
  const isImg   = !$('wmImageTab').classList.contains('hidden');
  const opacity = (+$('wmOpacity').value) / 100;
  const angle   = +$('wmAngle').value;
  if (isImg) {
    return { type:'watermark', opacity, angle, imgEl: WM.imgEl,
             w: +$('wmImgW').value || 300, h: +$('wmImgH').value || 200 };
  }
  return {
    type: 'watermark', opacity, angle,
    text:   $('wmText').value || 'WATERMARK',
    size:   +$('wmSize').value || 60,
    color:  $('wmColor').value || '#000000',
    font:   $('wmFont').value  || 'Arial',
    bold:   !!$('wmBold').classList.contains('active'),
    italic: !!$('wmItalic').classList.contains('active'),
  };
}

// ── Draw watermark onto a canvas at given position ─
function wmRenderToCanvas(ctx, canvasW, canvasH, desc, xFrac, yFrac) {
  ctx.save();
  ctx.globalAlpha = desc.opacity || 0.3;
  ctx.translate(canvasW * xFrac, canvasH * yFrac);
  ctx.rotate((desc.angle || 0) * Math.PI / 180);
  if (desc.imgEl) {
    const w = desc.w || 300, h = desc.h || 200;
    ctx.drawImage(desc.imgEl, -w / 2, -h / 2, w, h);
  } else {
    const weight = desc.bold   ? 'bold '   : '';
    const style  = desc.italic ? 'italic ' : '';
    ctx.font         = `${style}${weight}${desc.size || 60}px ${desc.font || 'Arial'}`;
    ctx.fillStyle    = desc.color || '#000000';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(desc.text || '', 0, 0);
  }
  ctx.restore();
}

// ── Redraw the live preview canvas ─────────────────
function wmDrawPreview() {
  const cv  = $('previewCanvas');
  const wmc = $('wmPreviewCanvas');
  if (!WM.active || cv.classList.contains('hidden')) return;

  wmc.width  = cv.offsetWidth;
  wmc.height = cv.offsetHeight;
  wmc.style.width  = cv.offsetWidth  + 'px';
  wmc.style.height = cv.offsetHeight + 'px';

  const ctx  = wmc.getContext('2d');
  ctx.clearRect(0, 0, wmc.width, wmc.height);
  wmRenderToCanvas(ctx, wmc.width, wmc.height, wmGetDesc(), WM.xFrac, WM.yFrac);
}

// ── Draggable watermark on preview canvas ──────────
(function() {
  let dragging = false, lastX, lastY;
  const wmc = $('wmPreviewCanvas');

  wmc.addEventListener('mousedown', e => {
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    wmc.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const cv   = $('previewCanvas');
    const rect = wmc.getBoundingClientRect();
    WM.xFrac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    WM.yFrac = Math.max(0, Math.min(1, (e.clientY - rect.top)  / rect.height));
    wmDrawPreview();
  });
  document.addEventListener('mouseup', () => {
    if (dragging) { dragging = false; $('wmPreviewCanvas').style.cursor = 'move'; }
  });
  // Touch support
  wmc.addEventListener('touchstart', e => {
    dragging = true; const t = e.touches[0]; lastX = t.clientX; lastY = t.clientY;
    e.preventDefault();
  }, { passive: false });
  wmc.addEventListener('touchmove', e => {
    if (!dragging) return;
    const t = e.touches[0];
    const rect = wmc.getBoundingClientRect();
    WM.xFrac = Math.max(0, Math.min(1, (t.clientX - rect.left) / rect.width));
    WM.yFrac = Math.max(0, Math.min(1, (t.clientY - rect.top)  / rect.height));
    wmDrawPreview();
    e.preventDefault();
  }, { passive: false });
  wmc.addEventListener('touchend', () => { dragging = false; });
})();

// ── Activate / deactivate preview ─────────────────
function wmActivate() {
  WM.active = true;
  WM.xFrac  = 0.5;
  WM.yFrac  = 0.5;
  $('wmPreviewCanvas').classList.add('active');

  // Position the preview canvas over the PDF canvas
  const cv  = $('previewCanvas');
  const wmc = $('wmPreviewCanvas');
  wmc.style.top  = cv.offsetTop  + 'px';
  wmc.style.left = cv.offsetLeft + 'px';
  wmUpdateUndoBtns();
  wmDrawPreview();
}
function wmDeactivate() {
  WM.active = false;
  $('wmPreviewCanvas').classList.remove('active');
  const wmc = $('wmPreviewCanvas');
  const ctx = wmc.getContext('2d');
  ctx.clearRect(0, 0, wmc.width, wmc.height);
}

// Hook into tool switching
const _origActivatePanel = typeof activatePanel === 'function' ? activatePanel : null;
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.panel === 'watermark') {
      setTimeout(() => {
        if (S.toolPages['watermark']?.length) wmActivate();
      }, 100);
    } else {
      wmDeactivate();
    }
  });
});

// ── Update undo/remove button states ──────────────
function wmUpdateUndoBtns() {
  const pages   = S.toolPages['watermark'] || [];
  const hasAny  = pages.some(p => p.overlays.some(o => o.type === 'watermark'));
  $('wmUndoBtn').disabled  = !hasAny;
  $('wmClearBtn').disabled = !hasAny;
}

// ── Undo last watermark (removes most recently applied batch) ──
$('wmUndoBtn').addEventListener('click', async () => {
  const pages = S.toolPages['watermark'];
  if (!pages?.length) return;
  // Find the last watermark overlay added and remove that entire batch
  // We track by removing the last watermark from each page simultaneously
  let removed = false;
  pages.forEach(p => {
    // Find last watermark index on this page
    for (let i = p.overlays.length - 1; i >= 0; i--) {
      if (p.overlays[i].type === 'watermark') {
        p.overlays.splice(i, 1);
        removed = true;
        break; // only remove last one per page
      }
    }
  });
  if (removed) {
    await previewMain(S.curPage);
    wmUpdateUndoBtns();
    toast('Last watermark removed.', 'success');
  }
});

// ── Remove ALL watermarks from all pages ───────────
$('wmClearBtn').addEventListener('click', async () => {
  const pages = S.toolPages['watermark'];
  if (!pages?.length) return;
  pages.forEach(p => {
    p.overlays = p.overlays.filter(o => o.type !== 'watermark');
  });
  await previewMain(S.curPage);
  wmUpdateUndoBtns();
  toast('All watermarks removed.', 'success');
});
$('wmBtn').addEventListener('click', async () => {
  const pages = S.toolPages['watermark'];
  if (!pages?.length) return;

  const desc   = wmGetDesc();
  const isImg  = !!desc.imgEl;
  const filter = $('wmPages').value;

  if (isImg && !desc.imgEl) { toast('Select a watermark image.', 'error'); return; }
  if (!isImg && !desc.text.trim()) { toast('Enter watermark text.', 'error'); return; }

  const pdfPage  = await pages[0].pdfJsDoc.getPage(pages[0].pageNum);
  const viewport = pdfPage.getViewport({ scale: 1 });
  const xPdf = WM.xFrac * viewport.width;
  const yPdf = WM.yFrac * viewport.height;

  loading(true, 'Applying watermark…');
  try {
    pages.forEach((p, i) => {
      const n = i + 1;
      const match = filter === 'all'
        || (filter === 'odd'   && n % 2 !== 0)
        || (filter === 'even'  && n % 2 === 0)
        || (filter === 'first' && n === 1);
      if (match) {
        p.overlays.push({ ...desc, xFrac: WM.xFrac, yFrac: WM.yFrac, xPdf, yPdf });
      }
    });
    await previewMain(S.curPage);
    wmUpdateUndoBtns();
    toast('Watermark applied!', 'success');
  } finally {
    loading(false);
  }
});

/* ── PAGE NUMBERS ── */
// Live preview helper — computes overlay for given page index
async function pnMakeOverlay(pages, i) {
  const pos   = $('pnPosition').value;
  const start = parseInt($('pnStart').value, 10) || 1;
  const size  = +$('pnSize').value || 14;
  const color = $('pnColor').value;
  const fmt   = $('pnFormat').value;
  const total = pages.length;
  const n     = i + start;
  const text  = fmt==='n' ? `${n}` : fmt==='of' ? `${n} of ${total}` : fmt==='dash' ? `— ${n} —` : `Page ${n}`;
  const pg    = await pages[i].pdfJsDoc.getPage(pages[i].pageNum);
  const rot   = (pg.getViewport({scale:1}).rotation + pages[i].rotation) % 360;
  const vp    = pg.getViewport({scale:1, rotation:rot});
  const W = vp.width, H = vp.height, pad = 20;
  let x, y, align = 'center';
  if      (pos==='bottom-center') { x=W/2;   y=H-pad;      align='center'; }
  else if (pos==='bottom-right')  { x=W-pad; y=H-pad;      align='right';  }
  else if (pos==='bottom-left')   { x=pad;   y=H-pad;      align='left';   }
  else if (pos==='top-center')    { x=W/2;   y=pad+size;   align='center'; }
  else if (pos==='top-right')     { x=W-pad; y=pad+size;   align='right';  }
  else                            { x=pad;   y=pad+size;   align='left';   }
  return { type:'pagenumber', text, size, color, x, y, align };
}

// Preview: apply temp overlay to current page and re-render (don't save)
async function pnPreview() {
  const pages = S.toolPages['pagenumbers'];
  if (!pages?.length) return;
  const idx = S.curPage - 1;
  // Remove any existing preview overlay, add fresh one
  pages[idx].overlays = pages[idx].overlays.filter(o => o.type !== 'pagenumber_preview');
  const o = await pnMakeOverlay(pages, idx);
  o.type = 'pagenumber_preview'; // mark as preview — not saved
  pages[idx].overlays.push(o);
  await previewMain(S.curPage);
  // Clean up preview overlay (it's just for display, removed on next render)
  pages[idx].overlays = pages[idx].overlays.filter(o => o.type !== 'pagenumber_preview');
}

// Wire all pn inputs to trigger live preview
['pnPosition','pnStart','pnSize','pnColor','pnFormat'].forEach(id => {
  $(id)?.addEventListener('input',  pnPreview);
  $(id)?.addEventListener('change', pnPreview);
});

function pnUpdateUndoBtn() {
  const pages  = S.toolPages['pagenumbers'] || [];
  const hasAny = pages.some(p => p.overlays.some(o => o.type === 'pagenumber'));
  $('pnUndoBtn').disabled  = !hasAny;
  $('pnClearBtn').disabled = !hasAny;
}

$('pnBtn').addEventListener('click', async () => {
  const pages = S.toolPages['pagenumbers']; if (!pages?.length) return;
  loading(true, 'Adding page numbers…');
  try {
    const jobs = pages.map(async (p, i) => {
      const o = await pnMakeOverlay(pages, i);
      p.overlays.push(o);
    });
    await Promise.all(jobs);
    await previewMain(S.curPage);
    pnUpdateUndoBtn();
    toast('Page numbers added!', 'success');
  } finally { loading(false); }
});

$('pnUndoBtn').addEventListener('click', async () => {
  const pages = S.toolPages['pagenumbers']; if (!pages?.length) return;
  pages.forEach(p => {
    for (let i = p.overlays.length - 1; i >= 0; i--) {
      if (p.overlays[i].type === 'pagenumber') { p.overlays.splice(i, 1); break; }
    }
  });
  await previewMain(S.curPage);
  pnUpdateUndoBtn();
  toast('Last page numbers removed.', 'success');
});

$('pnClearBtn').addEventListener('click', async () => {
  const pages = S.toolPages['pagenumbers']; if (!pages?.length) return;
  pages.forEach(p => { p.overlays = p.overlays.filter(o => o.type !== 'pagenumber'); });
  await previewMain(S.curPage);
  pnUpdateUndoBtn();
  toast('All page numbers removed.', 'success');
});

/* ── REDACT ── */
/* ══════════════════════════════════════════════════
   REDACT  —  smallpdf-style div boxes, pixel-perfect coords
══════════════════════════════════════════════════ */
const RD = {
  boxes:   [],   // { el, xFrac, yFrac, wFrac, hFrac, color }
  color:   '#000000',
  active:  false,
  drawing: false,
  startX:  0, startY: 0,
};

const rdLayer  = $('redactLayer');
const rdDrag   = document.createElement('div');
rdDrag.id = 'rdDragBox';
rdLayer.appendChild(rdDrag);

// Color picker
document.querySelectorAll('.rdclr').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rdclr').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    RD.color = btn.dataset.color;
  });
});

function rdSyncLayer() {
  const cv   = $('previewCanvas');
  const wrap = $('previewWrap');
  // Match canvas exactly, accounting for scroll (same logic as textBoxLayer)
  const wRect = wrap.getBoundingClientRect();
  const cRect = cv.getBoundingClientRect();
  rdLayer.style.top    = (cRect.top  - wRect.top  + wrap.scrollTop)  + 'px';
  rdLayer.style.left   = (cRect.left - wRect.left + wrap.scrollLeft) + 'px';
  rdLayer.style.width  = cRect.width  + 'px';
  rdLayer.style.height = cRect.height + 'px';
}

function rdEnter() {
  RD.active = true;
  RD.boxes  = [];
  rdLayer.classList.add('active');
  rdSyncLayer();
  rdRenderBoxes();
}
function rdExit() {
  RD.active = false;
  rdLayer.classList.remove('active');
  rdLayer.innerHTML = '';
  rdLayer.appendChild(rdDrag);
  rdUpdateList();
}

function rdUpdateList() {
  const list = $('redactBoxList');
  list.innerHTML = '';
  RD.boxes.forEach((b, i) => {
    const item = document.createElement('div');
    item.className = 'rdbox-item';
    item.innerHTML = `<span>Box ${i+1} &nbsp;·&nbsp; ${Math.round(b.wFrac*100)}% × ${Math.round(b.hFrac*100)}%</span>
      <button onclick="rdRemoveBox(${i})"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(item);
  });
  $('redactApplyBtn').disabled = RD.boxes.length === 0;
  $('redactUndoBtn').disabled  = RD.boxes.length === 0;
  $('redactClearBtn').disabled = RD.boxes.length === 0;
}
window.rdRemoveBox = function(i) {
  RD.boxes[i]?.el?.remove();
  RD.boxes.splice(i, 1);
  rdUpdateList();
};

function rdCreateBox(xFrac, yFrac, wFrac, hFrac, color) {
  const cv  = $('previewCanvas');
  const el  = document.createElement('div');
  el.className = 'rdbox';
  el.style.left   = (xFrac * 100) + '%';
  el.style.top    = (yFrac * 100) + '%';
  el.style.width  = (wFrac * 100) + '%';
  el.style.height = (hFrac * 100) + '%';
  el.style.background = color || '#000';

  const xBtn = document.createElement('button');
  xBtn.className = 'rdx';
  xBtn.innerHTML = '×';
  const idx = RD.boxes.length;
  xBtn.addEventListener('click', e => {
    e.stopPropagation();
    const i = RD.boxes.indexOf(box);
    if (i >= 0) { RD.boxes[i].el.remove(); RD.boxes.splice(i, 1); rdUpdateList(); }
  });
  el.appendChild(xBtn);

  rdLayer.appendChild(el);
  const box = { el, xFrac, yFrac, wFrac, hFrac, color: color || '#000' };
  RD.boxes.push(box);
  rdUpdateList();
  return box;
}

function rdRenderBoxes() {
  // Re-render all existing boxes (after page change / resize)
  RD.boxes.forEach(b => {
    b.el.style.left   = (b.xFrac * 100) + '%';
    b.el.style.top    = (b.yFrac * 100) + '%';
    b.el.style.width  = (b.wFrac * 100) + '%';
    b.el.style.height = (b.hFrac * 100) + '%';
  });
}

// Mouse drag to draw boxes
rdLayer.addEventListener('mousedown', e => {
  if (!RD.active || e.target !== rdLayer && e.target !== rdDrag) return;
  const rect = rdLayer.getBoundingClientRect();
  RD.drawing = true;
  RD.startX  = e.clientX - rect.left;
  RD.startY  = e.clientY - rect.top;
  rdDrag.style.display = 'block';
  rdDrag.style.left   = RD.startX + 'px';
  rdDrag.style.top    = RD.startY + 'px';
  rdDrag.style.width  = '0';
  rdDrag.style.height = '0';
  e.preventDefault();
});

document.addEventListener('mousemove', e => {
  if (!RD.drawing) return;
  const rect = rdLayer.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const x = Math.min(RD.startX, cx);
  const y = Math.min(RD.startY, cy);
  const w = Math.abs(cx - RD.startX);
  const h = Math.abs(cy - RD.startY);
  rdDrag.style.left   = x + 'px';
  rdDrag.style.top    = y + 'px';
  rdDrag.style.width  = w + 'px';
  rdDrag.style.height = h + 'px';
});

document.addEventListener('mouseup', e => {
  if (!RD.drawing) return;
  RD.drawing = false;
  rdDrag.style.display = 'none';
  const rect = rdLayer.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const x = Math.min(RD.startX, cx);
  const y = Math.min(RD.startY, cy);
  const w = Math.abs(cx - RD.startX);
  const h = Math.abs(cy - RD.startY);
  if (w < 8 || h < 8) return; // too small, ignore
  const lw = rect.width, lh = rect.height;
  rdCreateBox(x/lw, y/lh, w/lw, h/lh, RD.color);
});

// Undo / Clear
$('redactUndoBtn').addEventListener('click', () => {
  const b = RD.boxes.pop();
  if (b) { b.el.remove(); rdUpdateList(); }
});
$('redactClearBtn').addEventListener('click', () => {
  RD.boxes.forEach(b => b.el.remove());
  RD.boxes = [];
  rdUpdateList();
});

// Apply — burn boxes into overlays using fractional coords → PDF space
$('redactApplyBtn').addEventListener('click', async () => {
  const pages = S.toolPages['redact']; if (!pages?.length) return;
  if (!RD.boxes.length) { toast('Draw at least one box first.', 'error'); return; }

  loading(true, 'Applying redactions…');
  try {
    const pgIdx = S.curPage - 1;
    const pdfPage = await pages[pgIdx].pdfJsDoc.getPage(pages[pgIdx].pageNum);
    const vp      = pdfPage.getViewport({ scale: 1 });

    RD.boxes.forEach(b => {
      pages[pgIdx].overlays.push({
        type:  'redact',
        x:     b.xFrac * vp.width,
        y:     b.yFrac * vp.height,
        w:     b.wFrac * vp.width,
        h:     b.hFrac * vp.height,
        color: b.color,
      });
    });

    // Clear boxes and re-render
    RD.boxes.forEach(b => b.el.remove());
    RD.boxes = [];
    rdUpdateList();
    await previewMain(S.curPage);
    toast('Redactions applied!', 'success');
  } finally { loading(false); }
});

// Hook into enterRedactMode / exitRedactMode
function enterRedactMode() { rdEnter(); }
function exitRedactMode()  { rdExit(); }

/* ── SIGNATURE ── */
const sigCv  = $('sigCanvas');
const sigCtx = sigCv.getContext('2d');

// Signature drawing
$('clearSig').addEventListener('click', () => {
  sigCtx.clearRect(0, 0, sigCv.width, sigCv.height);
  // Remove placement box too — signature is blank now
  if (SIG.boxEl) { SIG.boxEl.remove(); SIG.boxEl = null; }
  $('addSigBtn').disabled = true;
});
function sigPos(e) {
  const r = sigCv.getBoundingClientRect(), s = e.touches ? e.touches[0] : e;
  return { x: (s.clientX-r.left)*(sigCv.width/r.width), y: (s.clientY-r.top)*(sigCv.height/r.height) };
}
function sigDraw(e) {
  e.preventDefault(); if (!S.sigDrawing) return;
  const p = sigPos(e);
  sigCtx.strokeStyle = $('sigColor').value;
  sigCtx.lineWidth   = +$('sigStroke').value;
  sigCtx.lineCap = 'round'; sigCtx.lineJoin = 'round';
  sigCtx.lineTo(p.x, p.y); sigCtx.stroke();
  // Auto-show box on first ink; then keep live in sync
  if (SIG.active) {
    if (!SIG.boxEl) {
      sigShowBox(); // place at default position automatically
    } else {
      const img = SIG.boxEl.querySelector('img');
      if (img) img.src = sigCv.toDataURL('image/png');
    }
  }
}
sigCv.addEventListener('mousedown', e => { e.preventDefault(); S.sigDrawing=true; const p=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x,p.y); });
sigCv.addEventListener('mousemove', e => sigDraw(e));
sigCv.addEventListener('mouseup',   () => { S.sigDrawing=false; sigCheckDrawn(); });
sigCv.addEventListener('mouseleave',() => { S.sigDrawing=false; });
sigCv.addEventListener('touchstart', e => { e.preventDefault(); S.sigDrawing=true; const p=sigPos(e); sigCtx.beginPath(); sigCtx.moveTo(p.x,p.y); }, {passive:false});
sigCv.addEventListener('touchmove',  e => sigDraw(e), {passive:false});
sigCv.addEventListener('touchend',   () => { S.sigDrawing=false; sigCheckDrawn(); });

// State
const SIG = { boxEl: null, active: false };

function sigCheckDrawn() {
  if (!SIG.active) return;
  const px = sigCtx.getImageData(0, 0, sigCv.width, sigCv.height);
  const hasInk = px.data.some(v => v > 0);
  if (hasInk) {
    if (!SIG.boxEl) sigShowBox(); // auto-place if not yet shown
    else {
      const img = SIG.boxEl.querySelector('img');
      if (img) img.src = sigCv.toDataURL('image/png');
    }
  } else {
    // No ink (e.g. after clearSig) — remove box
    if (SIG.boxEl) { SIG.boxEl.remove(); SIG.boxEl = null; }
    $('addSigBtn').disabled = true;
  }
}

function sigUpdateBtns() {
  const pages  = S.toolPages['signature'] || [];
  const hasAny = pages.some(p => p.overlays.some(o => o.type === 'signature'));
  $('sigUndoBtn').disabled  = !hasAny;
  $('sigClearBtn').disabled = !hasAny;
}

// Show/create the draggable signature box on the preview at click position
function sigShowBox(clickX, clickY) {
  const layer = $('sigPlacementLayer');
  // Remove existing box
  if (SIG.boxEl) SIG.boxEl.remove();

  const cv  = $('previewCanvas');
  const box = document.createElement('div');
  box.className = 'sig-box';

  const img = document.createElement('img');
  img.src = sigCv.toDataURL('image/png');
  box.appendChild(img);

  const resH = document.createElement('div');
  resH.className = 'sig-resize';
  box.appendChild(resH);

  // Default size
  const defW = Math.round(cv.offsetWidth  * 0.30);
  const defH = Math.round(cv.offsetHeight * 0.10);

  // Place centred on click, clamped to layer
  const lw = cv.offsetWidth, lh = cv.offsetHeight;
  const left = clickX !== undefined
    ? Math.max(0, Math.min(lw - defW, clickX - defW/2))
    : Math.round(lw * 0.05);
  const top  = clickY !== undefined
    ? Math.max(0, Math.min(lh - defH, clickY - defH/2))
    : Math.round(lh * 0.75);

  box.style.left   = left + 'px';
  box.style.top    = top  + 'px';
  box.style.width  = defW + 'px';
  box.style.height = defH + 'px';

  let dragMode = null, startX, startY, startL, startT, startW, startH;
  box.addEventListener('mousedown', e => {
    if (e.target === resH) dragMode = 'resize';
    else dragMode = 'move';
    startX = e.clientX; startY = e.clientY;
    startL = parseInt(box.style.left); startT = parseInt(box.style.top);
    startW = box.offsetWidth; startH = box.offsetHeight;
    e.preventDefault(); e.stopPropagation();
  });
  document.addEventListener('mousemove', e => {
    if (!dragMode) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (dragMode === 'move') {
      box.style.left = Math.max(0, startL + dx) + 'px';
      box.style.top  = Math.max(0, startT + dy) + 'px';
    } else {
      box.style.width  = Math.max(60, startW + dx) + 'px';
      box.style.height = Math.max(30, startH + dy) + 'px';
    }
  });
  document.addEventListener('mouseup', () => { dragMode = null; });

  layer.appendChild(box);
  SIG.boxEl = box;
  $('addSigBtn').disabled = false;
}

function sigActivate() {
  SIG.active = true;
  const layer = $('sigPlacementLayer');
  const cv = $('previewCanvas');
  layer.style.top    = cv.offsetTop  + 'px';
  layer.style.left   = cv.offsetLeft + 'px';
  layer.style.width  = cv.offsetWidth  + 'px';
  layer.style.height = cv.offsetHeight + 'px';
  layer.classList.add('active');
  sigUpdateBtns();

  // Click on empty layer area → place box at click position
  layer.addEventListener('click', sigLayerClick);

  // Show box if signature already drawn
  const px = sigCtx.getImageData(0, 0, sigCv.width, sigCv.height);
  if (px.data.some(v => v > 0)) sigShowBox();
}

function sigLayerClick(e) {
  // Only trigger on the layer itself, not on the box
  if (e.target !== $('sigPlacementLayer')) return;
  const rect = $('sigPlacementLayer').getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  // Check ink
  const px = sigCtx.getImageData(0, 0, sigCv.width, sigCv.height);
  if (!px.data.some(v => v > 0)) {
    toast('Draw your signature first, then click to place it.', 'info');
    return;
  }
  sigShowBox(cx, cy);
}

function sigDeactivate() {
  SIG.active = false;
  SIG.boxEl  = null;
  $('sigPlacementLayer').classList.remove('active');
  $('sigPlacementLayer').innerHTML = '';
  $('addSigBtn').disabled = true;
}

// Hook into tool switching
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.panel === 'signature') {
      setTimeout(() => { if (S.toolPages['signature']?.length) sigActivate(); }, 50);
    } else {
      sigDeactivate();
    }
  });
});

// Hook PDF load
const _origWirePdfSig = wirePdfUpload;
(function() {
  const obs = new MutationObserver(() => {
    if (!$('signatureControls').classList.contains('hidden') && S.activeTool === 'signature' && !SIG.active) {
      sigActivate();
    }
  });
  obs.observe($('signatureControls'), { attributes:true, attributeFilter:['class'] });
})();

// Re-sync layer position on page change
const _sigPreviewHook = previewMain;

// Embed signature button
$('addSigBtn').addEventListener('click', async () => {
  const pages = S.toolPages['signature']; if (!pages?.length) return;
  if (!SIG.boxEl) { toast('Place your signature on the page first.', 'error'); return; }

  const px = sigCtx.getImageData(0, 0, sigCv.width, sigCv.height);
  if (!px.data.some(v => v > 0)) { toast('Draw a signature first.', 'error'); return; }

  // Convert box position to PDF coordinates
  const cv      = $('previewCanvas');
  const layer   = $('sigPlacementLayer');
  const bx      = parseFloat(SIG.boxEl.style.left) || 0;
  const by      = parseFloat(SIG.boxEl.style.top)  || 0;
  const bw      = SIG.boxEl.offsetWidth;
  const bh      = SIG.boxEl.offsetHeight;
  const scaleX  = cv.offsetWidth;
  const scaleY  = cv.offsetHeight;

  const pdfPage = await pages[S.curPage-1].pdfJsDoc.getPage(pages[S.curPage-1].pageNum);
  const vp      = pdfPage.getViewport({ scale:1 });
  const xPdf = (bx / scaleX) * vp.width;
  const yPdf = (by / scaleY) * vp.height;
  const wPdf = (bw / scaleX) * vp.width;
  const hPdf = (bh / scaleY) * vp.height;

  const img = new Image(); img.src = sigCv.toDataURL('image/png');
  await new Promise(r => { img.onload = r; });

  pages[S.curPage-1].overlays.push({ type:'signature', imgEl:img, x:xPdf, y:yPdf, w:wPdf, h:hPdf });
  const prevTool = S.activeTool;
  S.activeTool = 'signature';
  await previewMain(S.curPage);
  S.activeTool = prevTool;
  sigUpdateBtns();
  toast('Signature embedded!', 'success');
});

// Undo / Clear
$('sigUndoBtn').addEventListener('click', async () => {
  const pages = S.toolPages['signature']; if (!pages?.length) return;
  // Remove last signature overlay from any page (scan all)
  let removed = false;
  for (let pi = pages.length - 1; pi >= 0 && !removed; pi--) {
    for (let oi = pages[pi].overlays.length - 1; oi >= 0; oi--) {
      if (pages[pi].overlays[oi].type === 'signature') {
        pages[pi].overlays.splice(oi, 1);
        removed = true; break;
      }
    }
  }
  if (removed) {
    const prevTool = S.activeTool;
    S.activeTool = 'signature';
    await previewMain(S.curPage);
    S.activeTool = prevTool;
  }
  sigUpdateBtns();
  toast(removed ? 'Signature removed.' : 'Nothing to undo.', removed ? 'success' : 'info');
});

$('sigClearBtn').addEventListener('click', async () => {
  const pages = S.toolPages['signature']; if (!pages?.length) return;
  pages.forEach(p => { p.overlays = p.overlays.filter(o => o.type !== 'signature'); });
  const prevTool = S.activeTool;
  S.activeTool = 'signature';
  await previewMain(S.curPage);
  S.activeTool = prevTool;
  sigUpdateBtns();
  toast('All signatures removed.', 'success');
});

/* ── SECURITY — server-side AES-256 encryption via pikepdf ── */
function mkTimeout(ms) {
  // AbortSignal.timeout is not available in all browsers; use controller fallback
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

$('applyPwdBtn').addEventListener('click', async () => {
  const pages = S.toolPages['security']; if (!pages?.length) return;
  const userPwd  = $('userPassword').value.trim();
  const ownerPwd = ($('ownerPassword').value || userPwd).trim();
  if (!userPwd) { toast('Enter a password first.', 'error'); return; }

  loading(true, 'Building PDF…');
  let pdfBytes;
  try {
    pdfBytes = await buildPdf(pages);
  } catch(e) {
    console.error(e);
    toast(`PDF build failed: ${e.message}`, 'error');
    loading(false); return;
  }

  loading(true, 'Encrypting… (server may take 15s to wake)');
  try {
    const formData = new FormData();
    formData.append('file', new Blob([pdfBytes], { type:'application/pdf' }), 'document.pdf');
    formData.append('userPassword', userPwd);
    formData.append('ownerPassword', ownerPwd);

    const res = await fetch(`${SERVER_URL}/encrypt`, {
      method: 'POST', body: formData, mode: 'cors',
      signal: mkTimeout(90000),
    });

    // Server sends heartbeat spaces then JSON — strip and parse
    const raw = await res.text();
    let json;
    try { json = JSON.parse(raw.trim()); }
    catch(_) { throw new Error(`Server error (${res.status}): ${raw.slice(0,200)}`); }

    if (!json.ok) throw new Error(json.error || 'Encryption failed on server');

    // base64 → Uint8Array → download
    const bin = atob(json.data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    dlBytes(out, 'protected.pdf');

    $('userPassword').value  = '';
    $('ownerPassword').value = '';
    toast('✓ Password-protected PDF downloaded!', 'success');
  } catch(e) {
    console.error(e);
    toast(`Encryption failed: ${e.message}`, 'error');
  } finally {
    loading(false);
  }
});

/* ── DOWNLOAD (main button, current tool's pages) ── */
$('downloadBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  loading(true,'Building PDF…');
  try{ dlBytes(await buildPdf(S.pages),'edited.pdf'); toast('Downloaded!','success'); }
  catch(e){ console.error(e); toast(`Failed: ${e.message}`,'error'); }
  finally{ loading(false); }
});

/* ══════════════════════════════════════════════════
   SERVER-SIDE CONVERSIONS
   PDF → Word / Excel / PowerPoint via Render server
══════════════════════════════════════════════════ */

const SERVER_URL = 'https://pdf-studio-server-1.onrender.com';

[
  { tool:'pdftoword',  zoneId:'pdftowordUploadZone',  infoId:'pdftowordFileInfo',  btnId:'pdftowordBtn',  statusId:'pdftowordStatus',  endpoint:'/convert/word',  ext:'docx', label:'Word' },
  { tool:'pdftoexcel', zoneId:'pdftoexcelUploadZone', infoId:'pdftoexcelFileInfo', btnId:'pdftoexcelBtn', statusId:'pdftoexcelStatus', endpoint:'/convert/excel', ext:'xlsx', label:'Excel' },
  { tool:'pdftopptx',  zoneId:'pdftopptxUploadZone',  infoId:'pdftopptxFileInfo',  btnId:'pdftopptxBtn',  statusId:'pdftopptxStatus',  endpoint:'/convert/pptx',  ext:'pptx', label:'PowerPoint' },
].forEach(({ tool, zoneId, infoId, btnId, statusId, endpoint, ext, label }) => {

  let storedFile = null;

  // Create a fresh file input dynamically — avoids hidden input issues across browsers
  function makeInput() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf';
    inp.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0;';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      if (inp.files[0]) handleFile(inp.files[0]);
      document.body.removeChild(inp);
    });
    return inp;
  }

  function setStatus(type, msg) {
    const el = $(statusId);
    if (!type) { hide(el); return; }
    el.className = `convert-status ${type}`;
    el.textContent = msg;
    show(el);
  }

  function handleFile(file) {
    if (!file || file.type !== 'application/pdf') { toast('Please select a valid PDF.', 'error'); return; }
    if (!okSize(file)) return;
    storedFile = file;
    $(infoId).innerHTML = `
      <i class="fa-solid fa-file-pdf fi-icon"></i>
      <div style="flex:1;min-width:0">
        <div class="fi-name">${file.name}</div>
        <div class="fi-size">${fmtSize(file.size)}</div>
      </div>
      <button class="fi-change" id="change-${tool}">Change</button>`;
    $(`change-${tool}`).addEventListener('click', () => resetServerTool(tool, zoneId, infoId, btnId, statusId));
    hide($(zoneId)); show($(infoId));
    $(btnId).disabled = false;
    setStatus(null);
    toast(`Loaded "${file.name}"`, 'success');
  }

  // Whole zone is clickable
  const zone = $(zoneId);
  zone.addEventListener('click', e => {
    // Don't trigger if they clicked the inner button (it will trigger too)
    if (e.target.tagName === 'BUTTON') return;
    makeInput().click();
  });
  // The "Choose PDF" button inside the zone
  zone.querySelector('button')?.addEventListener('click', e => {
    e.stopPropagation();
    makeInput().click();
  });

  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  $(btnId).addEventListener('click', async () => {
    if (!storedFile) return;
    $(btnId).disabled = true;

    // Step 1: ping to wake server (Render free tier sleeps after 15 min)
    setStatus('working', '⏳ Waking up server…');
    try {
      await fetch(`${SERVER_URL}/ping`, { method: 'GET', mode: 'cors', signal: AbortSignal.timeout(20000) });
    } catch (_) {
      await new Promise(r => setTimeout(r, 4000));
    }

    // Step 2: convert — server streams keep-alive spaces then ends with JSON
    setStatus('working', `⚙ Converting to ${label}… please wait`);
    try {
      const formData = new FormData();
      formData.append('file', storedFile, storedFile.name);

      let res;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          res = await fetch(`${SERVER_URL}${endpoint}`, {
            method: 'POST',
            body:   formData,
            mode:   'cors',
            signal: AbortSignal.timeout(180000), // 3 min max
          });
          break;
        } catch (fetchErr) {
          if (attempt === 2) throw fetchErr;
          setStatus('working', `Retrying… (attempt ${attempt}/2)`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      // Server always returns 200 with JSON (even on errors), because
      // it uses chunked streaming — parse the text and trim whitespace/spaces
      const raw  = await res.text();
      const json = JSON.parse(raw.trim());

      if (!json.ok) throw new Error(json.error || `Conversion failed`);

      // Decode base64 → Blob → download
      const byteChars = atob(json.data);
      const byteArr   = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteArr[i] = byteChars.charCodeAt(i);
      const blob   = new Blob([byteArr], { type: json.mime });
      const url    = URL.createObjectURL(blob);
      const a      = Object.assign(document.createElement('a'), { href: url, download: json.filename });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 15000);

      setStatus('done', `✓ Converted successfully — check your downloads`);
      toast(`${label} file downloaded!`, 'success');

    } catch (err) {
      console.error('[convert]', err);
      const isCors = err.name === 'TypeError' || err.message.includes('fetch');
      const msg = isCors
        ? 'Connection failed. Click Convert again — server may need another moment.'
        : err.message;
      setStatus('fail', `✗ ${msg}`);
      toast(msg, 'error', 7000);
    } finally {
      $(btnId).disabled = false;
    }
  });
});

function resetServerTool(tool, zoneId, infoId, btnId, statusId) {
  show($(zoneId)); hide($(infoId));
  $(btnId).disabled = true;
  hide($(statusId));
}
window.resetServerTool = resetServerTool;

/* ── INIT ── */
showHome();
console.log('%c PDF Studio v7 ','background:#4f8ef7;color:#fff;font-size:1rem;padding:3px 12px;border-radius:4px');
