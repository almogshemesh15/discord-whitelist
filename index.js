const express = require('express');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const app = express();
const PORT = process.env.PORT || 3000;

const agentOptions = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"'
};

app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    try {
        const r = await yts(query);
        res.json(r.videos.slice(0, 40));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/verify', async (req, res) => {
    const { url } = req.query;
    try {
        if (!ytdl.validateURL(url)) throw new Error('קישור לא תקין');
        const info = await ytdl.getInfo(url, { 
            requestOptions: { headers: agentOptions },
            lang: 'he'
        });
        res.json({ title: info.videoDetails.title });
    } catch (e) { 
        res.status(400).json({ error: e.message.includes('bot') ? 'יוטיוב חסם את הגישה (בוט). נסה שוב בעוד דקה.' : e.message }); 
    }
});

app.get('/get-file', async (req, res) => {
    const { url, format, title } = req.query;
    try {
        const extension = format === 'mp4' ? 'mp4' : 'mp3';
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title || 'download')}.${extension}"`);
        
        const options = {
            requestOptions: { headers: agentOptions },
            quality: format === 'mp4' ? 'highestvideo' : 'highestaudio',
            filter: format === 'mp4' ? 'audioandvideo' : 'audioonly',
            dlChunkSize: 1024 * 1024
        };

        ytdl(url, options).pipe(res);
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
            body { 
                margin: 0; background: var(--bg); color: white; font-family: system-ui, sans-serif; overflow-x: hidden;
                background-image: radial-gradient(circle at 50% -20%, #1a2a44 0%, transparent 50%);
                min-height: 100vh;
            }
            .nav { padding: 20px; display: flex; justify-content: space-between; border-bottom: 1px solid #1a1e26; background: rgba(5,7,10,0.8); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 100; }
            .logo { font-weight: 900; letter-spacing: 2px; color: var(--p); font-size: 14px; text-transform: uppercase; }
            .hero { padding: 40px 20px; text-align: center; }
            h1 { font-size: 2.5rem; margin: 10px 0; background: linear-gradient(to right, #fff, #888); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .search-container { max-width: 700px; margin: 0 auto; }
            .input-group { display: flex; background: var(--card); padding: 8px; border-radius: 20px; border: 1px solid #2a2e38; transition: 0.3s; }
            .input-group:focus-within { border-color: var(--p); box-shadow: 0 0 30px rgba(0,210,255,0.15); }
            input { flex: 1; background: none; border: none; color: white; padding: 15px; outline: none; font-size: 16px; }
            .btn-search { background: linear-gradient(to right, var(--p), var(--p2)); color: white; border: none; padding: 0 30px; border-radius: 15px; font-weight: bold; cursor: pointer; }
            .results { max-width: 1200px; margin: 40px auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; padding: 0 20px; }
            .v-card { background: var(--card); border-radius: 15px; overflow: hidden; transition: 0.3s; cursor: pointer; border: 1px solid #1a1e26; }
            .v-card:hover { transform: translateY(-8px); border-color: var(--p); }
            .v-thumb { width: 100%; height: 140px; object-fit: cover; }
            .v-body { padding: 12px; }
            .v-title { font-weight: bold; font-size: 13px; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; height: 34px; }
            .v-meta { font-size: 10px; color: #6a6e78; display: flex; justify-content: space-between; }
            .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); backdrop-filter: blur(15px); z-index: 1000; align-items: center; justify-content: center; }
            .modal-content { background: var(--card); padding: 40px; border-radius: 30px; width: 90%; max-width: 400px; text-align: center; border: 1px solid #2a2e38; }
            .loader { width: 40px; height: 40px; border: 3px solid #222; border-top-color: var(--p); border-radius: 50%; animation: spin 0.8s linear infinite; margin: 20px auto; }
            @keyframes spin { to { transform: rotate(360deg); } }
            #toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; }
            .toast { background: #ff4b2b; color: white; padding: 15px 25px; border-radius: 12px; margin-top: 10px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); animation: slideIn 0.3s ease; border-right: 4px solid #b32d15; font-weight: bold; }
            @keyframes slideIn { from { transform: translateX(120%); } to { transform: translateX(0); } }
            .download-options { display: flex; gap: 10px; margin-top: 20px; }
            .opt-btn { flex: 1; padding: 15px; border-radius: 12px; border: 1px solid #2a2e38; background: #1a1e26; color: white; cursor: pointer; transition: 0.2s; font-weight: bold; }
            .opt-btn:hover { background: var(--p); border-color: var(--p); }
        </style>
    </head>
    <body>
        <div class="nav"><div class="logo">ALMOG STUDIO // 2026</div></div>
        <div class="hero">
            <h1>הורדת תוכן מיוטיוב</h1>
            <div class="search-container">
                <div class="input-group">
                    <input type="text" id="q" placeholder="חפש שיר או הדבק לינק...">
                    <button class="btn-search" id="sBtn" onclick="doSearch()">חפש</button>
                </div>
            </div>
        </div>
        <div id="results" class="results"></div>
        <div id="dlModal" class="modal">
            <div class="modal-content">
                <h3 id="dlTitle">מאמת סרטון...</h3>
                <div id="dlLoader" class="loader"></div>
                <div id="dlActions" style="display:none">
                    <div class="download-options">
                        <button class="opt-btn" onclick="executeDownload('mp3')">AUDIO MP3</button>
                        <button class="opt-btn" onclick="executeDownload('mp4')">VIDEO MP4</button>
                    </div>
                    <button onclick="closeModal()" style="margin-top:20px; background:none; border:none; color:#555; cursor:pointer;">ביטול</button>
                </div>
            </div>
        </div>
        <div id="toast-container"></div>
        <script>
            let currentUrl = '', currentTitle = '';
            const hoverSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3');
            const clickSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3');
            const errorSnd = new Audio('https://assets.mixkit.co/active_storage/sfx/2572/2572-preview.mp3');
            hoverSnd.volume = 0.1; clickSnd.volume = 0.3; errorSnd.volume = 0.4;

            function playHover() { hoverSnd.currentTime = 0; hoverSnd.play().catch(()=>{}); }
            function playClick() { clickSnd.currentTime = 0; clickSnd.play().catch(()=>{}); }
            function playError() { errorSnd.currentTime = 0; errorSnd.play().catch(()=>{}); }

            function showToast(msg) {
                playError();
                const t = document.createElement('div');
                t.className = 'toast';
                t.innerText = msg;
                document.getElementById('toast-container').appendChild(t);
                setTimeout(() => t.remove(), 6000);
            }

            async function doSearch() {
                playClick();
                const q = document.getElementById('q').value;
                if(!q) return;
                const sBtn = document.getElementById('sBtn');
                sBtn.disabled = true; sBtn.innerText = 'טוען...';
                try {
                    if(q.includes('http')) { openDownloadModal(q); }
                    else {
                        const res = await fetch('/search?q=' + encodeURIComponent(q));
                        const data = await res.json();
                        document.getElementById('results').innerHTML = data.map(v => \`
                            <div class="v-card" onmouseenter="playHover()" onclick="openDownloadModal('\${v.url}')">
                                <img src="\${v.thumbnail}" class="v-thumb">
                                <div class="v-body">
                                    <div class="v-title">\${v.title}</div>
                                    <div class="v-meta"><span>\${v.timestamp}</span><span>\${v.views.toLocaleString()} צפיות</span></div>
                                </div>
                            </div>
                        \`).join('');
                    }
                } catch(e) { showToast('שגיאה בחיפוש: ' + e.message); }
                sBtn.disabled = false; sBtn.innerText = 'חפש';
            }

            async function openDownloadModal(url) {
                playClick();
                currentUrl = url;
                document.getElementById('dlModal').style.display = 'flex';
                document.getElementById('dlLoader').style.display = 'block';
                document.getElementById('dlActions').style.display = 'none';
                document.getElementById('dlTitle').innerText = 'מאמת קישור...';
                try {
                    const res = await fetch('/verify?url=' + encodeURIComponent(url));
                    const data = await res.json();
                    if(data.error) throw new Error(data.error);
                    currentTitle = data.title;
                    document.getElementById('dlTitle').innerText = data.title;
                    document.getElementById('dlLoader').style.display = 'none';
                    document.getElementById('dlActions').style.display = 'block';
                } catch(e) { closeModal(); showToast(e.message); }
            }

            function executeDownload(fmt) {
                playClick();
                window.location.href = \`/get-file?url=\${encodeURIComponent(currentUrl)}&format=\${fmt}&title=\${encodeURIComponent(currentTitle)}\`;
                closeModal();
            }

            function closeModal() { document.getElementById('dlModal').style.display = 'none'; }
            document.querySelectorAll('input, button').forEach(el => el.addEventListener('mouseenter', playHover));
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT);
