const express = require('express');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const app = express();
const PORT = process.env.PORT || 3000;

const agentOptions = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
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
            requestOptions: { headers: agentOptions }
        });
        res.json({ title: info.videoDetails.title });
    } catch (e) { 
        let errorMsg = e.message;
        if (errorMsg.includes('confirm you’re not a bot') || errorMsg.includes('403')) {
            errorMsg = 'שגיאה: יוטיוב דורש אימות אנושי (בוט). נסה שוב בעוד כמה דקות או השתמש בלינק אחר.';
        }
        res.status(400).json({ error: errorMsg }); 
    }
});

app.get('/get-file', async (req, res) => {
    const { url, format, title } = req.query;
    try {
        const extension = format === 'mp4' ? 'mp4' : 'mp3';
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title || 'download')}.${extension}"`);
        ytdl(url, {
            requestOptions: { headers: agentOptions },
            quality: format === 'mp4' ? 'highestvideo' : 'highestaudio',
            filter: format === 'mp4' ? 'audioandvideo' : 'audioonly'
        }).pipe(res);
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
                margin: 0; background: var(--bg); color: white; font-family: system-ui, sans-serif; 
                background-image: radial-gradient(circle at 50% -20%, #1a2a44 0%, transparent 50%);
                min-height: 100vh;
            }
            .nav { padding: 20px; display: flex; justify-content: space-between; border-bottom: 1px solid #1a1e26; background: rgba(5,7,10,0.8); backdrop-filter: blur(10px); position: sticky; top: 0; z-index: 100; }
            .logo { font-weight: 900; letter-spacing: 2px; color: var(--p); font-size: 14px; text-transform: uppercase; }
            .hero { padding: 40px 20px; text-align: center; }
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
            .v-title { font-weight: bold; font-size: 13px; height: 34px; overflow: hidden; }
            .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); backdrop-filter: blur(15px); z-index: 1000; align-items: center; justify-content: center; }
            .modal-content { background: var(--card); padding: 40px; border-radius: 30px; width: 90%; max-width: 400px; text-align: center; border: 1px solid #2a2e38; }
            #toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 9999; }
            .toast { background: #ff4b2b; color: white; padding: 15px 25px; border-radius: 12px; margin-top: 10px; animation: slideIn 0.3s ease; border-right: 4px solid #b32d15; font-weight: bold; }
            @keyframes slideIn { from { transform: translateX(120%); } to { transform: translateX(0); } }
            .opt-btn { width: 100%; padding: 15px; margin: 5px 0; border-radius: 12px; border: 1px solid #2a2e38; background: #1a1e26; color: white; cursor: pointer; font-weight: bold; }
            .opt-btn:hover { background: var(--p); }
        </style>
    </head>
    <body>
        <div class="nav"><div class="logo">ALMOG STUDIO // 2026</div></div>
        <div class="hero">
            <h1>הורדת תוכן מיוטיוב</h1>
            <div class="search-container">
                <div class="input-group">
                    <input type="text" id="q" placeholder="חפש שיר או הדבק לינק..." onkeypress="handleEnter(event)">
                    <button class="btn-search" id="sBtn" onclick="doSearch()">חפש</button>
                </div>
            </div>
        </div>
        <div id="results" class="results"></div>
        <div id="dlModal" class="modal">
            <div class="modal-content">
                <h3 id="dlTitle">טוען...</h3>
                <div id="dlActions" style="display:none">
                    <button class="opt-btn" onclick="executeDownload('mp3')">AUDIO MP3</button>
                    <button class="opt-btn" onclick="executeDownload('mp4')">VIDEO MP4</button>
                    <button onclick="closeModal()" style="margin-top:10px; background:none; border:none; color:#555; cursor:pointer;">ביטול</button>
                </div>
            </div>
        </div>
        <div id="toast-container"></div>
        <script>
            let currentUrl = '', currentTitle = '';
            const sounds = {
                hover: new Audio('https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3'),
                click: new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3'),
                error: new Audio('https://assets.mixkit.co/active_storage/sfx/2572/2572-preview.mp3'),
                success: new Audio('https://assets.mixkit.co/active_storage/sfx/1435/1435-preview.mp3')
            };
            Object.values(sounds).forEach(s => s.volume = 0.2);

            function play(name) { sounds[name].currentTime = 0; sounds[name].play().catch(()=>{}); }

            function handleEnter(e) { if(e.key === 'Enter') doSearch(); }

            function showToast(msg) {
                play('error');
                const t = document.createElement('div');
                t.className = 'toast';
                t.innerText = msg;
                document.getElementById('toast-container').appendChild(t);
                setTimeout(() => t.remove(), 5000);
            }

            async function doSearch() {
                play('click');
                const q = document.getElementById('q').value;
                if(!q) return;
                const sBtn = document.getElementById('sBtn');
                sBtn.disabled = true;
                try {
                    if(q.includes('http')) { openDownloadModal(q); }
                    else {
                        const res = await fetch('/search?q=' + encodeURIComponent(q));
                        const data = await res.json();
                        document.getElementById('results').innerHTML = data.map(v => \`
                            <div class="v-card" onmouseenter="play('hover')" onclick="openDownloadModal('\${v.url}')">
                                <img src="\${v.thumbnail}" class="v-thumb">
                                <div class="v-body">
                                    <div class="v-title">\${v.title}</div>
                                </div>
                            </div>
                        \`).join('');
                    }
                } catch(e) { showToast(e.message); }
                sBtn.disabled = false;
            }

            async function openDownloadModal(url) {
                play('click');
                currentUrl = url;
                document.getElementById('dlModal').style.display = 'flex';
                document.getElementById('dlActions').style.display = 'none';
                document.getElementById('dlTitle').innerText = 'מאמת קישור...';
                try {
                    const res = await fetch('/verify?url=' + encodeURIComponent(url));
                    const data = await res.json();
                    if(data.error) throw new Error(data.error);
                    currentTitle = data.title;
                    document.getElementById('dlTitle').innerText = data.title;
                    document.getElementById('dlActions').style.display = 'block';
                    play('success');
                } catch(e) { closeModal(); showToast(e.message); }
            }

            function executeDownload(fmt) {
                play('click');
                window.location.href = \`/get-file?url=\${encodeURIComponent(currentUrl)}&format=\${fmt}&title=\${encodeURIComponent(currentTitle)}\`;
                closeModal();
            }

            function closeModal() { document.getElementById('dlModal').style.display = 'none'; }
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT);
