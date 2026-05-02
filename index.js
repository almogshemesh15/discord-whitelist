const express = require('express');
const ytdl = require('@distube/ytdl-core');
const yts = require('yt-search');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);
    const r = await yts(query);
    res.json(r.videos.slice(0, 5));
});

app.get('/download-process', async (req, res) => {
    const { url, format } = req.query;
    try {
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
        res.json({ url, title, format });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

app.get('/get-file', async (req, res) => {
    const { url, format, title } = req.query;
    const extension = format === 'mp4' ? 'mp4' : 'mp3';
    const filter = format === 'mp4' ? 'audioandvideo' : 'audioonly';
    
    res.header('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.${extension}"`);
    ytdl(url, { filter: filter, quality: 'highest' }).pipe(res);
});

app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <style>
            body {
                margin: 0;
                height: 100vh;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                background: linear-gradient(-45deg, #001f3f, #0074D9, #7FDBFF, #39CCCC);
                background-size: 400% 400%;
                animation: gradient 15s ease infinite;
                color: white;
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            }
            @keyframes gradient {
                0% { background-position: 0% 50%; }
                50% { background-position: 100% 50%; }
                100% { background-position: 0% 50%; }
            }
            .container {
                background: rgba(255, 255, 255, 0.1);
                padding: 30px;
                border-radius: 20px;
                backdrop-filter: blur(10px);
                box-shadow: 0 8px 32px rgba(0,0,0,0.3);
                text-align: center;
                width: 80%;
                max-width: 500px;
            }
            input, select, button {
                padding: 12px;
                margin: 10px 0;
                border-radius: 10px;
                border: none;
                width: 90%;
            }
            button {
                background: #2ECC40;
                color: white;
                font-weight: bold;
                cursor: pointer;
                transition: 0.3s;
            }
            button:hover { background: #3D9970; }
            .progress-container {
                display: none;
                margin-top: 20px;
            }
            .progress-bar {
                width: 100%;
                background: #ddd;
                border-radius: 5px;
                overflow: hidden;
            }
            .progress-fill {
                height: 10px;
                background: #01FF70;
                width: 0%;
                transition: width 0.5s;
            }
            .result-item {
                background: rgba(0,0,0,0.2);
                margin: 5px;
                padding: 10px;
                border-radius: 5px;
                cursor: pointer;
                text-align: right;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>Almog Downloader</h1>
            <input type="text" id="userInput" placeholder="שם שיר או קישור יוטיוב...">
            <select id="format">
                <option value="mp3">MP3 (מוזיקה)</option>
                <option value="mp4">MP4 (וידאו)</option>
            </select>
            <button onclick="handleAction()">חפש / הכן להורדה</button>
            
            <div id="results"></div>

            <div id="loadingArea" class="progress-container">
                <p id="statusText">מעבד את הבקשה...</p>
                <div class="progress-bar"><div id="fill" class="progress-fill"></div></div>
                <a id="finalDownload" style="display:none;"><button>להורדה למחשב</button></a>
            </div>
        </div>

        <script>
            async function handleAction() {
                const input = document.getElementById('userInput').value;
                if (input.includes('youtube.com') || input.includes('youtu.be')) {
                    startDownload(input);
                } else {
                    const res = await fetch('/search?q=' + input);
                    const videos = await res.json();
                    let html = '<h3>תוצאות חיפוש:</h3>';
                    videos.forEach(v => {
                        html += \`<div class="result-item" onclick="startDownload('\${v.url}')">\${v.title}</div>\`;
                    });
                    document.getElementById('results').innerHTML = html;
                }
            }

            async function startDownload(url) {
                document.getElementById('results').innerHTML = '';
                document.getElementById('loadingArea').style.display = 'block';
                const format = document.getElementById('format').value;
                const fill = document.getElementById('fill');
                
                fill.style.width = '30%';
                const res = await fetch(\`/download-process?url=\${encodeURIComponent(url)}&format=\${format}\`);
                const data = await res.json();
                
                fill.style.width = '100%';
                document.getElementById('statusText').innerText = 'הקובץ מוכן!';
                const btn = document.getElementById('finalDownload');
                btn.href = \`/get-file?url=\${encodeURIComponent(data.url)}&format=\${data.format}&title=\${encodeURIComponent(data.title)}\`;
                btn.style.display = 'block';
            }
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT);
