/**
 * PDF Studio v6 — script.js
 * Architecture: PDF.js renders pages → canvas → JPEG → pdf-lib embeds.
 * No pdf-lib parsing of existing PDFs. Works on all real-world PDFs.
 *
 * Tools: Upload, Merge, Split, Compress, Images→PDF, Organize Pages,
 *        Annotate, Add Text, Add Image, Watermark, Page Numbers,
 *        Redact, Signature, Protect, Download
 */
'use strict';

/* ── CONFIG ──────────────────────────────────────── */
const CFG = {
  MAX_MB:        100,
  WORKER:        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  RENDER_SCALE:  2.0,
  PREVIEW_SCALE: 1.4,
  THUMB_SCALE:   0.9,
  ZOOM_STEP:     0.25,
  ZOOM_MIN:      0.5,
  ZOOM_MAX:      3.0,
};
pdfjsLib.GlobalWorkerOptions.workerSrc = CFG.WORKER;

/* ── STATE ───────────────────────────────────────── */
const S = {
  pages:       [],   // [{ pdfJsDoc, pageNum, rotation, overlays[] }]
  totalPages:  0,
  curPage:     1,
  zoom:        1.0,
  isDark:      true,
  selectedPgs: new Set(),

  mergeSources:  [],  // [{ name, file, pdfJsDoc, curPage }]
  _mergeViewIdx: 0,

  imgToPdfFiles: [],  // [{ file, imgEl }]

  sigDrawing:    false,
  placeMode:     null,

  // Annotate state
  annoteTool:   'freehand',
  annoteStrokes: [],   // strokes on current preview (not yet applied)
  annoteDrawing: false,
  annoteStart:   null,
  annoteCurStroke: null,

  // Redact state
  redactBoxes:  [],
  redactDrawing: false,
  redactStart:  null,

  compressQuality: 0.92,
};

/* ── DOM HELPERS ─────────────────────────────────── */
const $    = id => document.getElementById(id);
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
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(2) + ' MB';
}
function okSize(f) {
  if (f.size/1048576 > CFG.MAX_MB) { toast(`Too large (max ${CFG.MAX_MB} MB).`, 'error'); return false; }
  return true;
}
function okPage(n) {
  if (!Number.isFinite(n) || n < 1 || n > S.totalPages) {
    toast(`Page must be 1–${S.totalPages}.`, 'error'); return false;
  }
  return true;
}
window.togglePwd = id => { const e = $(id); e.type = e.type === 'password' ? 'text' : 'password'; };

/* ── THEME ───────────────────────────────────────── */
$('themeToggle').addEventListener('click', () => {
  S.isDark = !S.isDark;
  document.documentElement.setAttribute('data-theme', S.isDark ? 'dark' : 'light');
  $('themeToggle').innerHTML = S.isDark ? '<i class="fa-solid fa-moon"></i>' : '<i class="fa-solid fa-sun"></i>';
});

/* ── HOME / EDITOR SCREENS ───────────────────────── */
function showHome() {
  show($('homeScreen')); hide($('editorScreen'));
}
function showEditor(panel) {
  hide($('homeScreen')); show($('editorScreen'));
  if (panel) activatePanel(panel);
}

$('goHome').addEventListener('click', showHome);

// Tool cards on home screen
document.querySelectorAll('.tool-card').forEach(card => {
  card.addEventListener('click', () => showEditor(card.dataset.tool));
});

/* ── PANEL NAV ───────────────────────────────────── */
function activatePanel(name) {
  document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === `panel-${name}`));
  if (name === 'pages' && S.pages.length) renderGrid();
  if (name === 'merge') refreshMergePreview();
  if (name === 'annotate') enterAnnotateMode();
  if (name === 'redact') enterRedactMode();
  if (name !== 'annotate') exitAnnotateMode();
  if (name !== 'redact') exitRedactMode();
}

document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => { showEditor(btn.dataset.panel); activatePanel(btn.dataset.panel); });
});

/* ── PDF LOAD ────────────────────────────────────── */
async function loadPdfJs(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice() }).promise;
}
function buildPages(doc) {
  S.pdfJsDoc   = doc;
  S.totalPages = doc.numPages;
  S.pages      = Array.from({ length: S.totalPages }, (_, i) => ({
    pdfJsDoc: doc, pageNum: i + 1, rotation: 0, overlays: [],
  }));
  S.curPage = 1; S.selectedPgs.clear();
}

async function handleUpload(file) {
  if (!file || file.type !== 'application/pdf') { toast('Please select a valid PDF.', 'error'); return; }
  if (!okSize(file)) return;
  loading(true, 'Loading PDF…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc   = await loadPdfJs(bytes);
    buildPages(doc);
    $('fileName').textContent = file.name;
    $('fileSize').textContent = `${fmtSize(file.size)} · ${S.totalPages} pages`;
    hide($('dropZone')); show($('fileInfo'));
    enableBtns(true); updateSplitHint();
    await previewMain(1);
    toast(`Loaded "${file.name}" — ${S.totalPages} pages`, 'success');
  } catch (e) { console.error(e); toast(`Load failed: ${e.message}`, 'error'); }
  finally { loading(false); }
}

function enableBtns(on) {
  ['downloadBtn','splitBtn','addTextBtn','addImageBtn','addSigBtn','applyPwdBtn',
   'zoomIn','zoomOut','compressBtn','wmBtn','pnBtn','annotateApplyBtn','redactApplyBtn']
    .forEach(id => { const el=$(id); if(el) el.disabled = !on; });
  updateNav();
}

const dz = $('dropZone');
$('fileInput').addEventListener('change', e => { if(e.target.files[0]) handleUpload(e.target.files[0]); });
dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('drag-over'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); if(e.dataTransfer.files[0]) handleUpload(e.dataTransfer.files[0]); });
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { if(e.target !== dz) e.preventDefault(); });

$('clearFile').addEventListener('click', () => {
  Object.assign(S, { pages:[], pdfJsDoc:null, totalPages:0, curPage:1 });
  S.selectedPgs.clear();
  show($('dropZone')); hide($('fileInfo'));
  $('fileInput').value = '';
  $('pageIndicator').textContent = '— / —';
  hide($('previewCanvas')); show($('previewPlaceholder'));
  $('pageGrid').innerHTML = '<p class="hint center">Upload a PDF to manage pages.</p>';
  clearPlacementOverlay(); enableBtns(false);
});

/* ── MAIN PREVIEW ────────────────────────────────── */
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
  const ctx = canvas.getContext('2d');
  const sc  = vp.scale;
  overlays.forEach(o => {
    ctx.save();
    if (o.type === 'text') {
      ctx.font      = `${o.size * sc}px Arial`;
      ctx.fillStyle = o.color || '#000';
      ctx.fillText(o.text, o.x * sc, o.y * sc + o.size * sc);
    } else if (o.type === 'image' || o.type === 'signature') {
      if (o.imgEl) ctx.drawImage(o.imgEl, o.x*sc, o.y*sc, o.w*sc, o.h*sc);
    } else if (o.type === 'watermark') {
      ctx.globalAlpha = o.opacity;
      ctx.translate(canvas.width/2, canvas.height/2);
      ctx.rotate(o.angle * Math.PI/180);
      if (o.imgEl) {
        ctx.drawImage(o.imgEl, -o.w*sc/2, -o.h*sc/2, o.w*sc, o.h*sc);
      } else {
        ctx.font      = `bold ${o.size * sc}px Arial`;
        ctx.fillStyle = o.color || '#000';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(o.text, 0, 0);
      }
    } else if (o.type === 'pagenumber') {
      ctx.font      = `${o.size * sc}px Arial`;
      ctx.fillStyle = o.color || '#333';
      ctx.textAlign = o.align || 'center';
      ctx.fillText(o.text, o.x * sc, o.y * sc);
    } else if (o.type === 'annotation') {
      drawAnnotation(ctx, o, sc);
    } else if (o.type === 'redact') {
      ctx.fillStyle = '#000000';
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
    o.points.slice(1).forEach(p => ctx.lineTo(p.x*sc, p.y*sc));
    ctx.stroke();
  } else if (o.tool === 'highlight') {
    ctx.globalAlpha = 0.35; ctx.fillStyle = o.color;
    ctx.fillRect(o.x*sc, o.y*sc, o.w*sc, o.h*sc);
  } else if (o.tool === 'rect') {
    ctx.strokeRect(o.x*sc, o.y*sc, o.w*sc, o.h*sc);
  } else if (o.tool === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse((o.x + o.w/2)*sc, (o.y + o.h/2)*sc, Math.abs(o.w/2)*sc, Math.abs(o.h/2)*sc, 0, 0, Math.PI*2);
    ctx.stroke();
  } else if (o.tool === 'line') {
    ctx.beginPath(); ctx.moveTo(o.x*sc, o.y*sc); ctx.lineTo((o.x+o.w)*sc, (o.y+o.h)*sc); ctx.stroke();
  } else if (o.tool === 'arrow') {
    const ex=(o.x+o.w)*sc, ey=(o.y+o.h)*sc, sx=o.x*sc, sy=o.y*sc;
    const angle = Math.atan2(ey-sy, ex-sx);
    const hw = Math.max(8, o.size*sc*3);
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
  const desc = S.pages[pg - 1];
  const { canvas, viewport } = await renderPageToCanvas(desc, CFG.PREVIEW_SCALE * S.zoom);
  const cv = $('previewCanvas');
  cv.width = canvas.width; cv.height = canvas.height;
  cv.getContext('2d').drawImage(canvas, 0, 0);
  show(cv); hide($('previewPlaceholder'));
  updateNav();
  // Sync overlay layers
  syncLayer('drawingLayer', cv);
  syncLayer('placementOverlay', cv);
}

function syncLayer(id, cv) {
  const el = $(id); if (!el) return;
  el.width = cv.width; el.height = cv.height;
}

function updateNav() {
  $('pageIndicator').textContent = S.totalPages ? `${S.curPage} / ${S.totalPages}` : '— / —';
  $('prevPage').disabled = !S.totalPages || S.curPage <= 1;
  $('nextPage').disabled = !S.totalPages || S.curPage >= S.totalPages;
}
$('prevPage').addEventListener('click', () => previewMain(S.curPage - 1));
$('nextPage').addEventListener('click', () => previewMain(S.curPage + 1));
$('zoomIn').addEventListener('click',  () => { S.zoom = Math.min(CFG.ZOOM_MAX, +(S.zoom+CFG.ZOOM_STEP).toFixed(2)); $('zoomLabel').textContent = Math.round(S.zoom*100)+'%'; previewMain(); });
$('zoomOut').addEventListener('click', () => { S.zoom = Math.max(CFG.ZOOM_MIN, +(S.zoom-CFG.ZOOM_STEP).toFixed(2)); $('zoomLabel').textContent = Math.round(S.zoom*100)+'%'; previewMain(); });

/* ── PLACEMENT OVERLAY ───────────────────────────── */
function clearPlacementOverlay() {
  const ov = $('placementOverlay'); if(!ov) return;
  ov.getContext('2d').clearRect(0,0,ov.width,ov.height);
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
  if (S.placeMode==='signature') { $('sigX').value=px;  $('sigY').value=py; }
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
  ['textPickBtn','imgPickBtn','sigPickBtn'].forEach(id => {
    const b=$(id); if(!b) return;
    b.classList.remove('active-pick');
    b.innerHTML='<i class="fa-solid fa-crosshairs"></i> Pick on Page';
  });
  const ov=$('placementOverlay');
  if (S.placeMode) {
    ov.style.pointerEvents='all';
    $('previewWrap').classList.add('placement-active');
    const b=$(btnId);
    if(b){b.classList.add('active-pick');b.innerHTML='<i class="fa-solid fa-xmark"></i> Cancel';}
    toast('Click on the preview to set position.','info',3000);
  } else { clearPlacementOverlay(); }
}
$('textPickBtn').addEventListener('click', () => setPlaceMode('text',      'textPickBtn'));
$('imgPickBtn' ).addEventListener('click', () => setPlaceMode('image',     'imgPickBtn'));
$('sigPickBtn' ).addEventListener('click', () => setPlaceMode('signature', 'sigPickBtn'));

/* ── BUILD PDF ───────────────────────────────────────
   Renders all pages via PDF.js → canvas → JPEG → embeds
   into a new pdf-lib document. Quality param for compression.
─────────────────────────────────────────────────── */
async function buildPdf(pageDescs, quality = 0.92) {
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pageDescs.length; i++) {
    loading(true, `Building PDF… ${i+1} / ${pageDescs.length}`);
    const desc = pageDescs[i];
    const { canvas, viewport } = await renderPageToCanvas(desc, CFG.RENDER_SCALE);
    const jpeg    = canvas.toDataURL('image/jpeg', quality);
    const imgBytes = dataUrlToBytes(jpeg);
    const img     = await doc.embedJpg(imgBytes);
    // Get true point dimensions from PDF.js viewport at scale=1
    const pg1 = await desc.pdfJsDoc.getPage(desc.pageNum);
    const vp1 = pg1.getViewport({ scale:1, rotation:(pg1.getViewport({scale:1}).rotation + desc.rotation)%360 });
    const page = doc.addPage([vp1.width, vp1.height]);
    page.drawImage(img, { x:0, y:0, width:vp1.width, height:vp1.height });
  }
  return doc.save();
}

/* ── MERGE ───────────────────────────────────────── */
async function addMergeFiles(files) {
  loading(true, 'Loading…');
  try {
    for (const f of Array.from(files)) {
      if (f.type !== 'application/pdf') { toast(`Not a PDF: ${f.name}`, 'error'); continue; }
      if (!okSize(f)) continue;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const doc   = await loadPdfJs(bytes);
      S.mergeSources.push({ name:f.name, file:f, pdfJsDoc:doc, curPage:1 });
    }
    S._mergeViewIdx = Math.max(0, S.mergeSources.length-1);
    refreshMergeList(); await refreshMergePreview();
  } catch(e){ console.error(e); toast(e.message,'error'); }
  finally { loading(false); }
}

function refreshMergeList() {
  const list = $('mergeList'); list.innerHTML='';
  S.mergeSources.forEach((src,i) => {
    const li = document.createElement('li');
    li.className = 'merge-item'+(i===S._mergeViewIdx?' merge-item-active':'');
    li.innerHTML = `<i class="fa-solid fa-file-pdf"></i>
      <span class="merge-item-name" title="${src.name}">${src.name}</span>
      <small class="merge-item-size">${src.pdfJsDoc.numPages}p</small>
      <button class="icon-btn" onclick="viewMergeDoc(${i})" title="Preview"><i class="fa-solid fa-eye"></i></button>
      <button class="icon-btn danger" onclick="removeMergeDoc(${i})"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(li);
  });
  $('mergeBtn').disabled = S.mergeSources.length < 2;
  const src = S.mergeSources[S._mergeViewIdx];
  $('mergeDocLabel').textContent = src ? `${src.name.slice(0,22)} — pg ${src.curPage}/${src.pdfJsDoc.numPages}` : 'No PDFs added';
  $('mergePrevDoc').disabled = S._mergeViewIdx <= 0;
  $('mergeNextDoc').disabled = S._mergeViewIdx >= S.mergeSources.length-1;
  $('mergePrevPg').disabled  = !src || src.curPage <= 1;
  $('mergeNextPg').disabled  = !src || src.curPage >= src.pdfJsDoc.numPages;
}
window.viewMergeDoc  = i => { S._mergeViewIdx=i; S.mergeSources[i].curPage=1; refreshMergeList(); refreshMergePreview(); };
window.removeMergeDoc= i => { S.mergeSources.splice(i,1); S._mergeViewIdx=Math.max(0,Math.min(S._mergeViewIdx,S.mergeSources.length-1)); refreshMergeList(); refreshMergePreview(); };

async function refreshMergePreview() {
  const cv=$('mergePreviewCanvas'), ph=$('mergePreviewPlaceholder');
  const src = S.mergeSources[S._mergeViewIdx];
  if (!src) { hide(cv); show(ph); refreshMergeList(); return; }
  src.curPage = Math.max(1, Math.min(src.curPage, src.pdfJsDoc.numPages));
  const pg = await src.pdfJsDoc.getPage(src.curPage);
  const vp = pg.getViewport({ scale: CFG.PREVIEW_SCALE });
  cv.width=vp.width; cv.height=vp.height;
  show(cv); hide(ph);
  await pg.render({ canvasContext:cv.getContext('2d'), viewport:vp }).promise;
  refreshMergeList();
}
$('mergeInput').addEventListener('change', async e => { await addMergeFiles(e.target.files); e.target.value=''; });
const mdz=$('mergeDropZone');
mdz.addEventListener('dragover',e=>{e.preventDefault();mdz.classList.add('drag-over');});
mdz.addEventListener('dragleave',()=>mdz.classList.remove('drag-over'));
mdz.addEventListener('drop',async e=>{e.preventDefault();mdz.classList.remove('drag-over');await addMergeFiles(e.dataTransfer.files);});
$('mergePrevDoc').addEventListener('click',()=>{S._mergeViewIdx--;S.mergeSources[S._mergeViewIdx].curPage=1;refreshMergeList();refreshMergePreview();});
$('mergeNextDoc').addEventListener('click',()=>{S._mergeViewIdx++;S.mergeSources[S._mergeViewIdx].curPage=1;refreshMergeList();refreshMergePreview();});
$('mergePrevPg').addEventListener('click',()=>{const s=S.mergeSources[S._mergeViewIdx];if(s){s.curPage--;refreshMergePreview();}});
$('mergeNextPg').addEventListener('click',()=>{const s=S.mergeSources[S._mergeViewIdx];if(s){s.curPage++;refreshMergePreview();}});
$('mergeBtn').addEventListener('click', async () => {
  if (S.mergeSources.length < 2) return;
  loading(true,'Merging…');
  try {
    const descs = S.mergeSources.flatMap(src =>
      Array.from({length:src.pdfJsDoc.numPages},(_,i)=>({pdfJsDoc:src.pdfJsDoc,pageNum:i+1,rotation:0,overlays:[]}))
    );
    dlBytes(await buildPdf(descs), 'merged.pdf');
    toast(`Merged ${S.mergeSources.length} PDFs!`, 'success');
  } catch(e){ console.error(e); toast(`Merge failed: ${e.message}`,'error'); }
  finally { loading(false); }
});

/* ── SPLIT ───────────────────────────────────────── */
function updateSplitHint() {
  $('splitPageCount').textContent = S.totalPages ? `Document has ${S.totalPages} pages` : '';
  if (S.totalPages) { $('splitTo').value=S.totalPages; $('splitFrom').max=$('splitTo').max=S.totalPages; }
}
$('splitBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  const from=parseInt($('splitFrom').value,10), to=parseInt($('splitTo').value,10);
  if (!Number.isFinite(from)||!Number.isFinite(to)||from<1||to>S.totalPages||from>to){toast('Invalid range.','error');return;}
  loading(true,'Splitting…');
  try { dlBytes(await buildPdf(S.pages.slice(from-1,to)), `pages_${from}-${to}.pdf`); toast(`Pages ${from}–${to} extracted!`,'success'); }
  catch(e){ console.error(e); toast(`Split failed: ${e.message}`,'error'); }
  finally { loading(false); }
});

/* ── COMPRESS ────────────────────────────────────── */
document.querySelectorAll('.compress-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.compress-opt').forEach(o=>o.classList.remove('active'));
    opt.classList.add('active');
    S.compressQuality = parseFloat(opt.dataset.quality);
  });
  opt.querySelector('input').addEventListener('change', () => {});
});
$('compressBtn').addEventListener('click', async () => {
  if (!S.pages.length) return;
  loading(true,'Compressing…');
  try { dlBytes(await buildPdf(S.pages, S.compressQuality), 'compressed.pdf'); toast('Compressed PDF downloaded!','success'); }
  catch(e){ console.error(e); toast(`Compress failed: ${e.message}`,'error'); }
  finally { loading(false); }
});

/* ── IMAGES TO PDF ───────────────────────────────── */
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
    li.className='img-to-pdf-item'; li.dataset.idx=i;
    li.innerHTML=`<img src="${item.imgEl.src}" alt=""/>
      <span>${item.file.name}</span>
      <button class="icon-btn danger" onclick="removeImgFile(${i})"><i class="fa-solid fa-xmark"></i></button>`;
    list.appendChild(li);
  });
  $('imgToPdfBtn').disabled = S.imgToPdfFiles.length === 0;
  if (S.imgToPdfFiles.length > 1 && !S._imgSortable) {
    S._imgSortable = Sortable.create(list, {
      animation:150,
      onEnd(ev){const m=S.imgToPdfFiles.splice(ev.oldIndex,1)[0];S.imgToPdfFiles.splice(ev.newIndex,0,m);}
    });
  }
}
window.removeImgFile = i => { S.imgToPdfFiles.splice(i,1); refreshImgToPdfList(); };
const idz=$('imgToPdfDropZone');
$('imgToPdfInput').addEventListener('change',async e=>{await addImgToPdfFiles(e.target.files);e.target.value='';});
idz.addEventListener('dragover',e=>{e.preventDefault();idz.classList.add('drag-over');});
idz.addEventListener('dragleave',()=>idz.classList.remove('drag-over'));
idz.addEventListener('drop',async e=>{e.preventDefault();idz.classList.remove('drag-over');await addImgToPdfFiles(e.dataTransfer.files);});

$('imgToPdfBtn').addEventListener('click', async () => {
  if (!S.imgToPdfFiles.length) return;
  loading(true,'Converting images…');
  try {
    const doc  = await PDFLib.PDFDocument.create();
    const size = $('imgToPdfPageSize').value;
    const ori  = $('imgToPdfOrientation').value;
    const PAGE_SIZES = { A4:[595.28,841.89], Letter:[612,792] };

    for (const item of S.imgToPdfFiles) {
      const cv = document.createElement('canvas');
      cv.width=item.imgEl.naturalWidth; cv.height=item.imgEl.naturalHeight;
      cv.getContext('2d').drawImage(item.imgEl,0,0);
      const jpeg = cv.toDataURL('image/jpeg',0.92);
      const img  = await doc.embedJpg(dataUrlToBytes(jpeg));
      const iw=item.imgEl.naturalWidth, ih=item.imgEl.naturalHeight;
      let pw,ph;
      if (size==='fit') { pw=iw; ph=ih; }
      else {
        [pw,ph] = PAGE_SIZES[size]||PAGE_SIZES.A4;
        if (ori==='landscape') [pw,ph]=[ph,pw];
      }
      const page = doc.addPage([pw,ph]);
      const scale = Math.min(pw/iw, ph/ih);
      const dw=iw*scale, dh=ih*scale;
      page.drawImage(img,{ x:(pw-dw)/2, y:(ph-dh)/2, width:dw, height:dh });
    }
    dlBytes(await doc.save(), 'images.pdf');
    toast(`Converted ${S.imgToPdfFiles.length} image(s) to PDF!`,'success');
  } catch(e){ console.error(e); toast(`Conversion failed: ${e.message}`,'error'); }
  finally { loading(false); }
});

/* ── PAGE GRID ───────────────────────────────────── */
let sortable=null;
async function renderGrid() {
  if (!S.pages.length) return;
  const grid=$('pageGrid'); grid.innerHTML='';
  loading(true,'Rendering thumbnails…');
  try {
    for (let i=0;i<S.pages.length;i++){
      const {canvas}=await renderPageToCanvas(S.pages[i],CFG.THUMB_SCALE);
      const thumb=document.createElement('div');
      thumb.className='page-thumb'+(S.selectedPgs.has(i)?' selected':'');
      thumb.dataset.idx=i; canvas.style.cssText='width:100%;height:auto;display:block;';
      const lbl=document.createElement('div');
      lbl.className='page-thumb-label'; lbl.textContent=`Page ${i+1}`;
      const chk=document.createElement('div');
      chk.className='page-thumb-select';
      chk.innerHTML='<i class="fa-solid fa-check" style="font-size:.6rem"></i>';
      thumb.append(canvas,lbl,chk);
      if (S.pages[i].rotation){const rb=document.createElement('div');rb.className='page-rotation-badge';rb.textContent=`${S.pages[i].rotation}°`;thumb.appendChild(rb);}
      thumb.addEventListener('click',()=>{
        const idx=+thumb.dataset.idx;
        if(S.selectedPgs.has(idx)){S.selectedPgs.delete(idx);thumb.classList.remove('selected');}
        else{S.selectedPgs.add(idx);thumb.classList.add('selected');}
        updateGridBtns();
      });
      grid.appendChild(thumb);
    }
    if(sortable)sortable.destroy();
    sortable=Sortable.create(grid,{animation:150,ghostClass:'sortable-ghost',onEnd(ev){
      const m=S.pages.splice(ev.oldIndex,1)[0];S.pages.splice(ev.newIndex,0,m);
      grid.querySelectorAll('.page-thumb').forEach((el,i)=>{el.dataset.idx=i;el.querySelector('.page-thumb-label').textContent=`Page ${i+1}`;});
      S.selectedPgs.clear(); toast('Reordered. Download to save.','info');
    }});
  } finally { loading(false); }
  updateGridBtns();
}
function updateGridBtns(){const h=S.selectedPgs.size>0;$('deleteSelectedBtn').disabled=!h;$('rotateLeftBtn').disabled=!h;$('rotateRightBtn').disabled=!h;}
$('selectAllBtn').addEventListener('click',()=>{S.pages.forEach((_,i)=>S.selectedPgs.add(i));document.querySelectorAll('.page-thumb').forEach(t=>t.classList.add('selected'));updateGridBtns();});
$('deselectAllBtn').addEventListener('click',()=>{S.selectedPgs.clear();document.querySelectorAll('.page-thumb').forEach(t=>t.classList.remove('selected'));updateGridBtns();});
$('deleteSelectedBtn').addEventListener('click',async()=>{
  if(!S.selectedPgs.size||S.selectedPgs.size>=S.pages.length){toast('Cannot delete all pages.','error');return;}
  if(!confirm(`Delete ${S.selectedPgs.size} page(s)?`))return;
  [...S.selectedPgs].sort((a,b)=>b-a).forEach(i=>S.pages.splice(i,1));
  S.selectedPgs.clear(); S.totalPages=S.pages.length; S.curPage=Math.min(S.curPage,S.totalPages);
  updateNav(); updateSplitHint(); await renderGrid(); previewMain(S.curPage);
  toast('Deleted.','success');
});
async function rotateSel(deg){
  if(!S.selectedPgs.size)return; const cnt=S.selectedPgs.size;
  S.selectedPgs.forEach(i=>{S.pages[i].rotation=(S.pages[i].rotation+deg+360)%360;});
  S.selectedPgs.clear(); await renderGrid(); previewMain(S.curPage);
  toast(`Rotated ${cnt} page(s).`,'success');
}
$('rotateLeftBtn').addEventListener('click',()=>rotateSel(-90));
$('rotateRightBtn').addEventListener('click',()=>rotateSel(90));

/* ── ANNOTATE ────────────────────────────────────── */
document.querySelectorAll('.annotate-tool-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.annotate-tool-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active'); S.annoteTool=btn.dataset.atool;
  });
});

function enterAnnotateMode(){
  if(!S.pages.length)return;
  const dl=$('drawingLayer');
  show(dl); dl.classList.add('active');
  $('previewWrap').classList.add('drawing-active');
  S.annoteStrokes=[];
}
function exitAnnotateMode(){
  const dl=$('drawingLayer');
  if(dl){hide(dl);dl.classList.remove('active');dl.getContext('2d').clearRect(0,0,dl.width,dl.height);}
  $('previewWrap').classList.remove('drawing-active');
}

const dl=$('drawingLayer');
function getDrawPos(e){
  const rect=dl.getBoundingClientRect(),src=e.touches?e.touches[0]:e;
  return{x:(src.clientX-rect.left)*(dl.width/rect.width),y:(src.clientY-rect.top)*(dl.height/rect.height)};
}
function redrawAnnoteLayer(){
  const ctx=dl.getContext('2d'); ctx.clearRect(0,0,dl.width,dl.height);
  const sc=CFG.PREVIEW_SCALE*S.zoom;
  S.annoteStrokes.forEach(o=>drawAnnotation(ctx,o,sc));
}

dl.addEventListener('mousedown',e=>{
  if(!dl.classList.contains('active'))return;
  e.preventDefault(); S.annoteDrawing=true;
  const p=getDrawPos(e); const sc=CFG.PREVIEW_SCALE*S.zoom;
  const color=$('annotateColor').value, size=+$('annotateSize').value;
  if(S.annoteTool==='freehand'){
    S.annoteCurStroke={type:'annotation',tool:'freehand',color,size,points:[{x:p.x/sc,y:p.y/sc}]};
  } else {
    S.annoteStart=p;
    S.annoteCurStroke={type:'annotation',tool:S.annoteTool,color,size,x:p.x/sc,y:p.y/sc,w:0,h:0};
  }
});
dl.addEventListener('mousemove',e=>{
  if(!S.annoteDrawing||!S.annoteCurStroke)return;
  e.preventDefault();
  const p=getDrawPos(e); const sc=CFG.PREVIEW_SCALE*S.zoom;
  if(S.annoteTool==='freehand'){
    S.annoteCurStroke.points.push({x:p.x/sc,y:p.y/sc});
  } else {
    const st=S.annoteStart;
    S.annoteCurStroke.w=(p.x-st.x)/sc; S.annoteCurStroke.h=(p.y-st.y)/sc;
  }
  redrawAnnoteLayer();
  drawAnnotation(dl.getContext('2d'),S.annoteCurStroke,sc);
});
dl.addEventListener('mouseup',()=>{
  if(!S.annoteDrawing)return; S.annoteDrawing=false;
  if(S.annoteCurStroke){S.annoteStrokes.push(S.annoteCurStroke);S.annoteCurStroke=null;}
  redrawAnnoteLayer();
});
dl.addEventListener('mouseleave',()=>{if(S.annoteDrawing){S.annoteDrawing=false;if(S.annoteCurStroke){S.annoteStrokes.push(S.annoteCurStroke);S.annoteCurStroke=null;}redrawAnnoteLayer();}});

$('annotateUndoBtn').addEventListener('click',()=>{S.annoteStrokes.pop();redrawAnnoteLayer();});
$('annotateClearBtn').addEventListener('click',()=>{S.annoteStrokes=[];redrawAnnoteLayer();});
$('annotateApplyBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const pgNum=parseInt($('annotatePage').value,10); if(!okPage(pgNum))return;
  S.pages[pgNum-1].overlays.push(...S.annoteStrokes);
  S.annoteStrokes=[];
  exitAnnotateMode();
  await previewMain(pgNum);
  enterAnnotateMode();
  toast('Annotations applied!','success');
});

/* ── TEXT OVERLAY ────────────────────────────────── */
$('addTextBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const text=$('overlayText').value.trim();
  if(!text){toast('Enter some text.','error');return;}
  const pgNum=parseInt($('textPage').value,10); if(!okPage(pgNum))return;
  S.pages[pgNum-1].overlays.push({type:'text',text,size:+$('textSize').value||24,
    x:parseFloat($('textX').value)||0,y:parseFloat($('textY').value)||0,color:$('textColor').value});
  await previewMain(pgNum); setPlaceMode(null);
  toast('Text added!','success');
});

/* ── IMAGE OVERLAY ───────────────────────────────── */
$('addImageBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const fi=$('overlayImageInput'); if(!fi.files[0]){toast('Select an image.','error');return;}
  const pgNum=parseInt($('imgPage').value,10); if(!okPage(pgNum))return;
  loading(true,'Loading image…');
  try {
    const imgEl=await loadImgEl(fi.files[0]);
    S.pages[pgNum-1].overlays.push({type:'image',imgEl,
      x:parseFloat($('imgX').value)||0,y:parseFloat($('imgY').value)||0,
      w:parseFloat($('imgW').value)||150,h:parseFloat($('imgH').value)||100});
    await previewMain(pgNum); setPlaceMode(null);
    toast('Image added!','success');
  } catch(e){toast(`Image error: ${e.message}`,'error');}
  finally{loading(false);}
});

/* ── WATERMARK ───────────────────────────────────── */
document.querySelectorAll('.tab-btn[data-wtab]').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab-btn[data-wtab]').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    $('wmTextTab').classList.toggle('hidden',btn.dataset.wtab!=='text');
    $('wmImageTab').classList.toggle('hidden',btn.dataset.wtab!=='image');
  });
});
$('wmOpacity').addEventListener('input',()=>$('wmOpacityVal').textContent=$('wmOpacity').value+'%');

$('wmBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const isImg = !$('wmImageTab').classList.contains('hidden');
  const opacity=(+$('wmOpacity').value)/100;
  const angle  =+$('wmAngle').value;
  const filter =$('wmPages').value;
  let wmData={type:'watermark',opacity,angle};
  if(isImg){
    const fi=$('wmImageInput'); if(!fi.files[0]){toast('Select a watermark image.','error');return;}
    loading(true,'Applying watermark…');
    try{
      const imgEl=await loadImgEl(fi.files[0]);
      wmData={...wmData,imgEl,w:+$('wmImgW').value||300,h:+$('wmImgH').value||200};
    }catch(e){toast(e.message,'error');loading(false);return;}
  } else {
    const text=$('wmText').value.trim();
    if(!text){toast('Enter watermark text.','error');return;}
    wmData={...wmData,text,size:+$('wmSize').value||60,color:$('wmColor').value};
    loading(true,'Applying watermark…');
  }
  S.pages.forEach((p,i)=>{
    const pgNum=i+1;
    if(filter==='all'||(filter==='odd'&&pgNum%2!==0)||(filter==='even'&&pgNum%2===0)||(filter==='first'&&pgNum===1))
      p.overlays.push({...wmData});
  });
  await previewMain(S.curPage);
  loading(false);
  toast('Watermark applied to pages!','success');
});

/* ── PAGE NUMBERS ────────────────────────────────── */
$('pnBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const pos   =$('pnPosition').value;
  const start =parseInt($('pnStart').value,10)||1;
  const size  =+$('pnSize').value||14;
  const color =$('pnColor').value;
  const fmt   =$('pnFormat').value;
  const total =S.pages.length;
  loading(true,'Adding page numbers…');

  S.pages.forEach(async(p,i)=>{
    const n=i+start;
    let text;
    if(fmt==='n')    text=`${n}`;
    else if(fmt==='of')   text=`${n} of ${total}`;
    else if(fmt==='dash') text=`— ${n} —`;
    else text=`Page ${n}`;

    // We need page dimensions — get from pdfJsDoc
    const pdfPage=await p.pdfJsDoc.getPage(p.pageNum);
    const vp=pdfPage.getViewport({scale:1,rotation:(pdfPage.getViewport({scale:1}).rotation+p.rotation)%360});
    const W=vp.width,H=vp.height,pad=20;
    let x,y,align='center';
    if(pos==='bottom-center'){x=W/2;y=H-pad;align='center';}
    else if(pos==='bottom-right'){x=W-pad;y=H-pad;align='right';}
    else if(pos==='bottom-left'){x=pad;y=H-pad;align='left';}
    else if(pos==='top-center'){x=W/2;y=pad+size;align='center';}
    else if(pos==='top-right'){x=W-pad;y=pad+size;align='right';}
    else{x=pad;y=pad+size;align='left';}
    p.overlays.push({type:'pagenumber',text,size,color,x,y,align});
  });

  // Wait a tick for all async getPage calls to settle then refresh
  setTimeout(async()=>{
    await previewMain(S.curPage);
    loading(false);
    toast('Page numbers added!','success');
  },S.pages.length*5+100);
});

/* ── REDACT ──────────────────────────────────────── */
function enterRedactMode(){
  if(!S.pages.length)return;
  const dl=$('drawingLayer'); show(dl); dl.classList.add('active');
  $('previewWrap').classList.add('redact-active');
  S.redactBoxes=[];
}
function exitRedactMode(){
  const dl=$('drawingLayer');
  if(dl){dl.getContext('2d').clearRect(0,0,dl.width,dl.height);hide(dl);dl.classList.remove('active');}
  $('previewWrap').classList.remove('redact-active');
}
function redrawRedactLayer(){
  const ctx=dl.getContext('2d'); ctx.clearRect(0,0,dl.width,dl.height);
  const sc=CFG.PREVIEW_SCALE*S.zoom;
  ctx.fillStyle='rgba(0,0,0,0.85)';
  S.redactBoxes.forEach(b=>ctx.fillRect(b.x*sc,b.y*sc,b.w*sc,b.h*sc));
}

dl.addEventListener('mousedown',e=>{
  if(!$('previewWrap').classList.contains('redact-active'))return;
  e.preventDefault(); S.redactDrawing=true;
  const p=getDrawPos(e), sc=CFG.PREVIEW_SCALE*S.zoom;
  S.redactStart={x:p.x/sc,y:p.y/sc};
},true);
dl.addEventListener('mousemove',e=>{
  if(!S.redactDrawing)return; e.preventDefault();
  const p=getDrawPos(e), sc=CFG.PREVIEW_SCALE*S.zoom;
  redrawRedactLayer();
  const st=S.redactStart;
  dl.getContext('2d').fillStyle='rgba(0,0,0,0.85)';
  dl.getContext('2d').fillRect(st.x*sc,st.y*sc,(p.x/sc-st.x)*sc,(p.y/sc-st.y)*sc);
},true);
dl.addEventListener('mouseup',e=>{
  if(!S.redactDrawing)return; S.redactDrawing=false;
  const p=getDrawPos(e), sc=CFG.PREVIEW_SCALE*S.zoom;
  const st=S.redactStart;
  const box={x:st.x,y:st.y,w:p.x/sc-st.x,h:p.y/sc-st.y};
  if(Math.abs(box.w)>2&&Math.abs(box.h)>2) S.redactBoxes.push(box);
  redrawRedactLayer();
},true);

$('redactUndoBtn').addEventListener('click',()=>{S.redactBoxes.pop();redrawRedactLayer();});
$('redactClearBtn').addEventListener('click',()=>{S.redactBoxes=[];redrawRedactLayer();});
$('redactApplyBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const pgNum=parseInt($('redactPage').value,10); if(!okPage(pgNum))return;
  if(!S.redactBoxes.length){toast('Draw at least one redaction box.','error');return;}
  S.pages[pgNum-1].overlays.push(...S.redactBoxes.map(b=>({type:'redact',...b})));
  S.redactBoxes=[];
  exitRedactMode();
  await previewMain(pgNum);
  enterRedactMode();
  toast('Redactions applied permanently.','success');
});

/* ── SIGNATURE ───────────────────────────────────── */
const sigCv=  $('sigCanvas');
const sigCtx= sigCv.getContext('2d');
$('clearSig').addEventListener('click',()=>sigCtx.clearRect(0,0,sigCv.width,sigCv.height));
function sigPos(e){const r=sigCv.getBoundingClientRect(),src=e.touches?e.touches[0]:e;return{x:(src.clientX-r.left)*(sigCv.width/r.width),y:(src.clientY-r.top)*(sigCv.height/r.height)};}
function sigDraw(e){e.preventDefault();if(!S.sigDrawing)return;const p=sigPos(e);sigCtx.strokeStyle=$('sigColor').value;sigCtx.lineWidth=+$('sigStroke').value;sigCtx.lineCap='round';sigCtx.lineJoin='round';sigCtx.lineTo(p.x,p.y);sigCtx.stroke();}
sigCv.addEventListener('mousedown',e=>{e.preventDefault();S.sigDrawing=true;const p=sigPos(e);sigCtx.beginPath();sigCtx.moveTo(p.x,p.y);});
sigCv.addEventListener('mousemove',e=>sigDraw(e));
sigCv.addEventListener('mouseup',()=>{S.sigDrawing=false;});
sigCv.addEventListener('mouseleave',()=>{S.sigDrawing=false;});
sigCv.addEventListener('touchstart',e=>{e.preventDefault();S.sigDrawing=true;const p=sigPos(e);sigCtx.beginPath();sigCtx.moveTo(p.x,p.y);},{passive:false});
sigCv.addEventListener('touchmove',e=>sigDraw(e),{passive:false});
sigCv.addEventListener('touchend',()=>{S.sigDrawing=false;});

$('addSigBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const px=sigCtx.getImageData(0,0,sigCv.width,sigCv.height);
  if(!px.data.some(v=>v>0)){toast('Draw a signature first.','error');return;}
  const pgNum=parseInt($('sigPage').value,10); if(!okPage(pgNum))return;
  const img=new Image(); img.src=sigCv.toDataURL('image/png');
  await new Promise(r=>{img.onload=r;});
  S.pages[pgNum-1].overlays.push({type:'signature',imgEl:img,
    x:parseFloat($('sigX').value)||50,y:parseFloat($('sigY').value)||50,
    w:parseFloat($('sigW').value)||200,h:parseFloat($('sigH').value)||80});
  await previewMain(pgNum); setPlaceMode(null);
  toast('Signature added!','success');
});

/* ── SECURITY ────────────────────────────────────── */
$('applyPwdBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  const up=$('userPassword').value; if(!up){toast('Enter a user password.','error');return;}
  loading(true,'Building PDF…');
  try{
    dlBytes(await buildPdf(S.pages),'document.pdf');
    const op=$('ownerPassword').value||up;
    toast(`Saved. To encrypt: qpdf --encrypt ${up} ${op} 256 -- document.pdf encrypted.pdf`,'info',10000);
  }catch(e){console.error(e);toast(`Failed: ${e.message}`,'error');}
  finally{loading(false);}
});

/* ── DOWNLOAD ────────────────────────────────────── */
$('downloadBtn').addEventListener('click',async()=>{
  if(!S.pages.length)return;
  loading(true,'Building PDF…');
  try{dlBytes(await buildPdf(S.pages),'edited.pdf');toast('Downloaded!','success');}
  catch(e){console.error(e);toast(`Failed: ${e.message}`,'error');}
  finally{loading(false);}
});

/* ── UTILS ───────────────────────────────────────── */
function dlBytes(bytes,name){
  if(!(bytes instanceof Uint8Array))bytes=new Uint8Array(bytes);
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));
  const a=Object.assign(document.createElement('a'),{href:url,download:name});
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),15000);
}
function dataUrlToBytes(du){
  const b=atob(du.split(',')[1]),u=new Uint8Array(b.length);
  for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i); return u;
}
function loadImgEl(file){
  return new Promise((res,rej)=>{
    const img=new Image();
    img.onload=()=>res(img); img.onerror=()=>rej(new Error('Image load failed'));
    img.src=URL.createObjectURL(file);
  });
}

/* ── INIT ────────────────────────────────────────── */
showHome();
enableBtns(false);
refreshMergeList();
console.log('%c PDF Studio v6 ','background:#4f8ef7;color:#fff;font-size:1rem;padding:3px 12px;border-radius:4px');
