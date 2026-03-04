# PDF Studio Server

Converts PDFs to Word, Excel, and PowerPoint using LibreOffice.
Designed to deploy on Render.com free tier.

## Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | `/` | Health check |
| POST | `/convert/word` | PDF → DOCX |
| POST | `/convert/excel` | PDF → XLSX |
| POST | `/convert/pptx` | PDF → PPTX |

Send your PDF as multipart form data with field name `file`.

## Deploy to Render (Step by Step)

### 1. Push this folder to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/pdf-studio-server.git
git push -u origin main
```

### 2. Create a Render Web Service
1. Go to https://render.com and sign in
2. Click **New** → **Web Service**
3. Connect your GitHub account and select the **pdf-studio-server** repo
4. Render will auto-detect the `render.yaml` — click **Apply**
5. Click **Create Web Service**

### 3. Wait for the first deploy (~5 minutes)
Render will:
- Install LibreOffice (this is why first deploy takes a few minutes)
- Install Node dependencies
- Start your server

### 4. Copy your server URL
Once deployed, Render gives you a URL like:
`https://pdf-studio-server-xxxx.onrender.com`

Copy this — you'll paste it into your PDF Studio frontend.

### 5. Update your frontend
In your PDF Studio `script.js`, find this line:
```js
const SERVER_URL = 'https://YOUR_RENDER_URL_HERE.onrender.com';
```
Replace with your actual Render URL.

## Notes
- Free tier sleeps after 15 min of inactivity — first request after sleep takes ~30s
- Files are never stored — processed in memory and deleted immediately
- Max file size: 100MB
