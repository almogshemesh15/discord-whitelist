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
        res.json(r.videos.slice(0, 8));
    } catch (e) { res.status(500).json([]); }
});

app.get('/get-file', async (req, res) => {
    const { url, format, title } = req.query;
    if (!url || url === 'undefined') return res.status(400).send('Invalid URL');
    
    const extension = format === 'mp4' ? 'mp4' : 'mp3';
    res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(title || 'download')}.${extension}"`);
    
    const options = format === 'mp4' 
        ? { quality: 'highestvideo', filter: 'audioandvideo' } 
        : { quality: 'highestaudio', filter: 'audioonly' };

    ytdl(url, options).pipe(res).on('error', (err) => {
        console.error(err);
        if (!res.headersSent) res.status(500).send('Error downloading');
    });
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Almog Downloader Pro</title>
        <style>
            :root {
                --primary: #0084ff;
                --bg: #0a0a0c;
                --card: #16161a;
                --text: #ffffff;
            }
            body {
                margin: 0;
                background-color: var(--bg);
                color: var(--text);
                font-family: 'Segoe UI', system-ui, sans-serif;
                display: flex;
                justify-content: center;
                min-height: 100vh;
            }
            .app-container {
                width: 95%;
                max-width: 800px;
                padding: 40px 20px;
            }
            .header { text-align: center; margin-bottom: 40px; }
            .logo-text { font-size: 12px; color: var(--primary); letter-spacing: 3px; font-weight: bold; }
            
            .search-box {
                display: flex;
                gap: 10px;
                background: var(--card);
                padding: 10px;
                border-radius: 15px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.5);
            }
            input {
                flex: 1;
                background: transparent;
                border: none;
                color: white;
                padding: 10px;
                font-size: 16px;
                outline: none;
            }
            select {
                background: #252529;
                color: white;
                border: none;
                padding: 10px;
                border-radius: 10px;
                cursor: pointer;
            }
            .main-btn {
                background: var(--primary);
                color: white;
                border: none;
                padding: 10px 25px;
                border-radius: 10px;
                font-weight: bold;
                cursor: pointer;
                transition: 0.3s;
            }
            .main-btn:disabled { opacity: 0.5; cursor: not-allowed; }

            .results-container {
                margin-top: 30px;
                display: grid;
                grid-template-columns: 1fr;
                gap: 15px;
            }
            .video-card {
                background: var(--card);
                display: flex;
                gap: 15px;
                padding: 12px;
                border-radius: 15px;
                cursor: pointer;
                transition: 0.2s;
                border: 1px solid transparent;
            }
            .video-card:hover { border-color: var(--primary); background: #1f1f24; }
            .thumb-container { position: relative; flex-shrink: 0; }
            .thumb-container img { width: 160px; height: 90px; border-radius: 10px; object-fit: cover; }
            .duration {
                position: absolute;
                bottom: 5px;
                right: 5px;
                background: rgba(0,0,0,0.8);
                padding: 2px 5px;
                border-radius: 4px;
                font-size: 11px;
            }
            .video-info { overflow: hidden; }
            .video-title { font-weight: bold; font-size: 15px; margin-bottom: 5px; white-space: nowrap; text-overflow: ellipsis; overflow: hidden; }
            .video-desc { font-size: 12px; color: #aaa; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

            .overlay {
                display: none;
                position: fixed;
                top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.9);
                z-index: 100;
                flex-direction: column;
                align-items: center;
                justify-content: center;
            }
            .loader-bar { width: 200px; height: 4px; background: #333; border-radius: 2px; margin-top: 20px; overflow: hidden; }
            .loader-fill { width: 0%; height: 100%; background: var(--primary); transition: 0.3s; }
            .final-btn {
                background: #2ecc71;
                color: white;
                padding: 15px 40px;
                border-radius: 10px;
                text-decoration: none;
                font-weight: bold;
                display: none;
                margin-top: 20px;
            }
        </style>
    </head>
    <body>
        <div class="app-container">
            <div class="header">
                <div class="logo-text">@ALMOGTT12</div>
                <h1>YouTube Downloader</h1>
            </div>

            <div class="search-box">
                <input type="text" id="query" placeholder="חפש שיר או הדבק קישור...">
                <select id="format">
                    <option value="mp3">MP3</option>
                    <option value="mp4">MP4</option>
                </select>
                <button class="main-btn" id="searchBtn" onclick="runSearch()">חפש</button>
            </div>

            <div id="results" class="results-container"></div>
        </div>

        <div id="overlay" class="overlay">
            <h2 id="status">מכין את הקובץ...</h2>
            <div class="loader-bar"><div id="fill" class="loader-fill"></div></div>
            <a id="downloadLink" href="#" class="final-btn">להורדה למחשב</a>
            <button onclick="closeOverlay()" style="margin-top:30px; background:none; border:1px solid #444; color:#888; padding:5px 15px; border-radius:5px; cursor:pointer;">ביטול</button>
        </div>

        <script>
            async function runSearch() {
                const q = document.getElementById('query').value;
                if(!q) return;
                
                const btn = document.getElementById('searchBtn');
                btn.disabled = true;
                btn.innerText = 'טוען...';
                
                try {
                    const res = await fetch('/search?q=' + encodeURIComponent(q));
                    const videos = await res.json();
                    
                    let html = '';
                    videos.forEach(v => {
                        html += \`
                        <div class="video-card" onclick="initDownload('\${v.url}', '\${v.title.replace(/'/g, "")}')">
                            <div class="thumb-container">
                                <img src="\${v.thumbnail}">
                                <span class="duration">\${v.timestamp}</span>
                            </div>
                            <div class="video-info">
                                <div class="video-title">\${v.title}</div>
                                <div class="video-desc">\${v.description || 'אין תיאור זמין'}</div>
                            </div>
                        </div>\`;
                    });
                    document.getElementById('results').innerHTML = html;
                } catch(e) {}
                
                btn.disabled = false;
                btn.innerText = 'חפש';
            }

            function initDownload(url, title) {
                const overlay = document.getElementById('overlay');
                const fill = document.getElementById('fill');
                const link = document.getElementById('downloadLink');
                const status = document.getElementById('status');
                const fmt = document.getElementById('format').value;

                overlay.style.display = 'flex';
                link.style.display = 'none';
                status.innerText = 'מכין את הקובץ להורדה...';
                fill.style.width = '0%';

                let p = 0;
                const interval = setInterval(() => {
                    p += Math.random() * 15;
                    if(p >= 100) {
                        p = 100;
                        clearInterval(interval);
                        status.innerText = 'הקובץ מוכן!';
                        link.href = \`/get-file?url=\${encodeURIComponent(url)}&format=\${fmt}&title=\${encodeURIComponent(title)}\`;
                        link.style.display = 'block';
                    }
                    fill.style.width = p + '%';
                }, 200);
            }

            function closeOverlay() {
                document.getElementById('overlay').style.display = 'none';
            }
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT);
