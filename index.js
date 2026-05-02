const express = require('express');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    try {
        const r = await yts(query);
        res.json(r.videos.slice(0, 10));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/verify', async (req, res) => {
    const { url } = req.query;
    try {
        const isValid = ytdl.validateURL(url);
        if (!isValid) throw new Error('קישור לא תקין');
        const info = await ytdl.getBasicInfo(url);
        res.json({ title: info.videoDetails.title });
    } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/get-file', async (req, res) => {
    const { url, format, title } = req.query;
    try {
        const extension = format === 'mp4' ? 'mp4' : 'mp3';
        const fileName = `${encodeURIComponent(title || 'download')}.${extension}`;
        
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Type', format === 'mp4' ? 'video/mp4' : 'audio/mpeg');

        const downloadOptions = format === 'mp4' 
            ? { quality: 'highestvideo', filter: 'audioandvideo' } 
            : { quality: 'highestaudio', filter: 'audioonly' };

        ytdl(url, downloadOptions).pipe(res);
    } catch (e) {
        if (!res.headersSent) res.status(500).send(e.message);
    }
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Almog Studio Downloader</title>
        <style>
            :root { --p: #00d2ff; --p2: #3a7bd5; --bg: #05070a; --card: #11141b; }
            body { margin: 0; background: var(--bg); color: white; font-family: system-ui, -apple-system, sans-serif; overflow-x: hidden; }
            .nav { padding: 20px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #1a1e26; }
            .logo { font-weight: 900; letter-spacing: 2px; color: var(--p); font-size: 14px; }
            
            .hero { padding: 60px 20px; text-align: center; background: radial-gradient(circle at top, #1a2a44 0%, transparent 70%); }
            h1 { font-size: 3rem; margin: 10px 0; background: linear-gradient(to right, #fff, #888); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            
            .search-container { max-width: 700px; margin: 0 auto; position: relative; }
            .input-group { display: flex; background: var(--card); padding: 8px; border-radius: 20px; border: 1px solid #2a2e38; transition: 0.3s; }
            .input-group:focus-within { border-color: var(--p); box-shadow: 0 0 20px rgba(0,210,255,0.2); }
            input { flex: 1; background: none; border: none; color: white; padding: 15px; outline: none; font-size: 16px; }
            
            .btn-search { background: linear-gradient(to right, var(--p), var(--p2)); color: white; border: none; padding: 0 30px; border-radius: 15px; font-weight: bold; cursor: pointer; }
            
            .results { max-width: 900px; margin: 40px auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 25px; padding: 0 20px; }
            .v-card { background: var(--card); border-radius: 20px; overflow: hidden; transition: 0.3s; cursor: pointer; border: 1px solid #1a1e26; }
            .v-card:hover { transform: translateY(-10px); border-color: var(--p); }
            .v-thumb { width: 100%; height: 160px; object-fit: cover; }
            .v-body { padding: 15px; }
            .v-title { font-weight: bold; font-size: 14px; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
            .v-meta { font-size: 12px; color: #6a6e78; display: flex; justify-content: space-between; }

            .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); backdrop-filter: blur(10px); z-index: 1000; align-items: center; justify-content: center; }
            .modal-content { background: var(--card); padding: 40px; border-radius: 30px; width: 90%; max-width: 400px; text-align: center; border: 1px solid #2a2e38; }
            .loader { width: 50px; height: 50px; border: 3px solid #222; border-top-color: var(--p); border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { to { transform: rotate(360deg); } }

            #toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; }
            .toast { background: #ff4b2b; color: white; padding: 15px 25px; border-radius: 12px; margin-top: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); animation: slideIn 0.3s ease; }
            @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }
            
            .download-options { display: flex; gap: 10px; margin-top: 20px; }
            .opt-btn { flex: 1; padding: 15px; border-radius: 12px; border: 1px solid #2a2e38; background: #1a1e26; color: white; cursor: pointer; transition: 0.2s; }
            .opt-btn:hover { background: var(--p); border-color: var(--p); }
        </style>
    </head>
    <body>
        <div class="nav">
            <div class="logo">ALMOG STUDIO // 2026</div>
        </div>

        <div class="hero">
            <h1>הורדת תוכן מיוטיוב</h1>
            <p>חפש שיר או הדבק קישור וקבל הורדה ישירה בשניות</p>
            <div class="search-container">
                <div class="input-group">
                    <input type="text" id="q" placeholder="שם השיר או לינק ליוטיוב...">
                    <button class="btn-search" id="sBtn" onclick="doSearch()">חפש</button>
                </div>
            </div>
        </div>

        <div id="results" class="results"></div>

        <div id="dlModal" class="modal">
            <div class="modal-content">
                <h3 id="dlTitle">מכין את ההורדה...</h3>
                <div id="dlLoader" class="loader"></div>
                <div id="dlActions" style="display:none">
                    <p>בחר פורמט להורדה:</p>
                    <div class="download-options">
                        <button class="opt-btn" onclick="executeDownload('mp3')">MP3 (אודיו)</button>
                        <button class="opt-btn" onclick="executeDownload('mp4')">MP4 (וידאו)</button>
                    </div>
                    <button onclick="closeModal()" style="margin-top:20px; background:none; border:none; color:#666; cursor:pointer;">ביטול</button>
                </div>
            </div>
        </div>

        <div id="toast-container"></div>

        <script>
            let currentUrl = '';
            let currentTitle = '';

            function showToast(msg) {
                const t = document.createElement('div');
                t.className = 'toast';
                t.innerText = msg;
                document.getElementById('toast-container').appendChild(t);
                setTimeout(() => t.remove(), 4000);
            }

            async function doSearch() {
                const q = document.getElementById('q').value;
                if(!q) return;
                
                const sBtn = document.getElementById('sBtn');
                sBtn.disabled = true;
                sBtn.innerText = 'מחפש...';

                try {
                    if(q.includes('http')) {
                        openDownloadModal(q);
                    } else {
                        const res = await fetch('/search?q=' + encodeURIComponent(q));
                        const data = await res.json();
                        if(data.error) throw new Error(data.error);
                        
                        document.getElementById('results').innerHTML = data.map(v => \`
                            <div class="v-card" onclick="openDownloadModal('\${v.url}')">
                                <img src="\${v.thumbnail}" class="v-thumb">
                                <div class="v-body">
                                    <div class="v-title">\${v.title}</div>
                                    <div class="v-meta">
                                        <span>\${v.timestamp}</span>
                                        <span>\${v.views.toLocaleString()} צפיות</span>
                                    </div>
                                </div>
                            </div>
                        \`).join('');
                    }
                } catch(e) { showToast('שגיאה: ' + e.message); }
                sBtn.disabled = false;
                sBtn.innerText = 'חפש';
            }

            async function openDownloadModal(url) {
                currentUrl = url;
                const modal = document.getElementById('dlModal');
                const loader = document.getElementById('dlLoader');
                const actions = document.getElementById('dlActions');
                const titleElem = document.getElementById('dlTitle');

                modal.style.display = 'flex';
                loader.style.display = 'block';
                actions.style.display = 'none';
                titleElem.innerText = 'בודק קישור...';

                try {
                    const res = await fetch('/verify?url=' + encodeURIComponent(url));
                    const data = await res.json();
                    if(data.error) throw new Error(data.error);
                    
                    currentTitle = data.title;
                    titleElem.innerText = data.title;
                    loader.style.display = 'none';
                    actions.style.display = 'block';
                } catch(e) {
                    closeModal();
                    showToast('שגיאה באימות: ' + e.message);
                }
            }

            function executeDownload(fmt) {
                const downloadUrl = \`/get-file?url=\${encodeURIComponent(currentUrl)}&format=\${fmt}&title=\${encodeURIComponent(currentTitle)}\`;
                window.location.href = downloadUrl;
                closeModal();
                showToast('ההורדה התחילה!');
            }

            function closeModal() { document.getElementById('dlModal').style.display = 'none'; }
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT);
