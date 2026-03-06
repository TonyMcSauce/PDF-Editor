# PDF Studio — Client-Side PDF Editor

A fully client-side PDF editor that runs entirely in the browser. No backend, no uploads, no tracking.

## Features

- **Upload PDF** — Drag & drop or file picker, up to 50 MB
- **Preview** — Render pages with zoom and page navigation
- **Merge** — Combine multiple PDFs into one
- **Split** — Extract a page range and download as new PDF
- **Manage Pages** — Drag-to-reorder, delete, rotate (left/right 90°)
- **Add Text** — Custom font size, color, X/Y position
- **Add Image** — Embed PNG or JPEG overlays
- **Signature** — Draw a signature on canvas, embed into PDF
- **Dark/Light Mode** — Toggle with the moon/sun icon
- **Password Protection** — Note: pdf-lib v1.x does not support writing encrypted PDFs in-browser. The PDF is saved without encryption. Use the command below for real encryption.

## Tech Stack

| Library | Purpose |
|---|---|
| [PDF.js 3.11](https://mozilla.github.io/pdf.js/) | Render PDF pages to canvas |
| [pdf-lib 1.17](https://pdf-lib.js.org/) | Edit, create, merge PDFs |
| [SortableJS 1.15](https://sortablejs.github.io/Sortable/) | Drag-and-drop page reordering |
| [Font Awesome 6](https://fontawesome.com/) | Icons |

## Deployment on GitHub Pages

1. Fork or clone this repo
2. Push to a GitHub repository
3. Go to **Settings → Pages → Source: main branch / root**
4. Your site will be live at `https://<username>.github.io/<repo>/`

No build step required. Pure HTML/CSS/JS.

## Password Protection (Real Encryption)

pdf-lib v1.x does not support writing AES-256 encrypted PDFs from the browser. To truly encrypt your PDF after downloading:

```bash
# Using qpdf (install via brew/apt)
qpdf --encrypt <userPassword> <ownerPassword> 256 -- input.pdf output.pdf

# Using Ghostscript
gs -dNOPAUSE -dBATCH -sDEVICE=pdfwrite \
   -sOwnerPassword=<ownerPwd> -sUserPassword=<userPwd> \
   -dEncryptionR=6 -dKeyLength=256 \
   -sOutputFile=output.pdf input.pdf
```

## File Structure

```
/pdf-editor
├── index.html    — Main HTML layout
├── style.css     — All styling (dark/light themes)
├── script.js     — All JavaScript logic
└── README.md     — This file
```

## Privacy

All PDF processing happens **locally in your browser**. No files are sent to any server. No analytics. No ads.
