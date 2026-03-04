const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ── CORS ──────────────────────────────────────────────────────────────────────
// Allow requests from your GitHub Pages / any frontend
// Change this to your actual frontend URL once deployed, e.g.:
// 'https://yourusername.github.io'
const ALLOWED_ORIGINS = [
  'http://localhost',
  'http://127.0.0.1',
  /\.github\.io$/,        // any github pages site
  /\.netlify\.app$/,      // netlify
  /\.vercel\.app$/,       // vercel
];
app.use(cors({
  origin(origin, cb) {
    // allow non-browser tools (curl, Postman) and matched origins
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.some(p =>
      typeof p === 'string' ? origin.startsWith(p) : p.test(origin)
    );
    cb(ok ? null : new Error('CORS blocked'), ok);
  }
}));

app.use(express.json());

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'PDF Studio Server', version: '1.0.0' });
});

// ── LIBREOFFICE DETECTION ─────────────────────────────────────────────────────
function getLibreOfficePath() {
  const candidates = [
    'libreoffice',        // Linux (Render)
    'soffice',            // alternative name
    '/usr/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice',
  ];
  return candidates[0]; // exec will fail gracefully if not found
}

// ── CONVERT HELPER ────────────────────────────────────────────────────────────
/**
 * Converts a PDF buffer to the target format using LibreOffice.
 * format: 'docx' | 'xlsx' | 'pptx'
 * Returns a Buffer of the converted file.
 */
function convertWithLibreOffice(pdfBuffer, format) {
  return new Promise((resolve, reject) => {
    // Write PDF to a temp file
    const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfconv-'));
    const inFile  = path.join(tmpDir, 'input.pdf');
    const outFile = path.join(tmpDir, `input.${format}`);

    fs.writeFileSync(inFile, pdfBuffer);

    // Map format to LibreOffice filter name
    const filterMap = {
      docx: 'docx',
      xlsx: 'xlsx',
      pptx: 'pptx',
    };
    const filter = filterMap[format] || format;
    const lo     = getLibreOfficePath();
    const cmd    = `${lo} --headless --infilter="impress_pdf_import" --convert-to ${filter} --outdir "${tmpDir}" "${inFile}"`;

    // Timeout: 2 minutes
    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        cleanup(tmpDir);
        return reject(new Error(`LibreOffice error: ${stderr || err.message}`));
      }
      if (!fs.existsSync(outFile)) {
        cleanup(tmpDir);
        return reject(new Error('Conversion produced no output file'));
      }
      const result = fs.readFileSync(outFile);
      cleanup(tmpDir);
      resolve(result);
    });
  });
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// ── MIME TYPES ────────────────────────────────────────────────────────────────
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ── CONVERSION ENDPOINTS ──────────────────────────────────────────────────────

// POST /convert/word   → PDF → DOCX
// POST /convert/excel  → PDF → XLSX
// POST /convert/pptx   → PDF → PPTX
['word', 'excel', 'pptx'].forEach(route => {
  const formatMap = { word: 'docx', excel: 'xlsx', pptx: 'pptx' };
  const format    = formatMap[route];

  app.post(`/convert/${route}`, upload.single('file'), async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded. Send a PDF as multipart field "file".' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ error: 'Only PDF files are accepted.' });
    }

    console.log(`[${new Date().toISOString()}] Converting ${req.file.originalname} → ${format} (${(req.file.size/1024).toFixed(1)} KB)`);

    try {
      const converted = await convertWithLibreOffice(req.file.buffer, format);
      const outName   = req.file.originalname.replace(/\.pdf$/i, '') + '.' + format;

      res.set({
        'Content-Type':        MIME[format],
        'Content-Disposition': `attachment; filename="${outName}"`,
        'Content-Length':      converted.length,
      });
      res.send(converted);
      console.log(`[${new Date().toISOString()}] Done → ${outName} (${(converted.length/1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error('Conversion failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF Studio Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/`);
  console.log(`Convert: POST http://localhost:${PORT}/convert/word`);
  console.log(`Convert: POST http://localhost:${PORT}/convert/excel`);
  console.log(`Convert: POST http://localhost:${PORT}/convert/pptx`);
});
