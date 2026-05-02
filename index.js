const express = require('express');
const ytdl = require('@distube/ytdl-core'); // גרסה מעודכנת יותר
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send(`
        <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
            <h1>Youtube Downloader</h1>
            <form action="/download" method="GET">
                <input type="text" name="url" placeholder="הדבק קישור מיוטיוב כאן" style="width: 300px; padding: 10px;">
                <button type="submit" style="padding: 10px 20px; cursor: pointer;">הורד MP3</button>
            </form>
        </body>
    `);
});

app.get('/download', async (req, res) => {
    const videoURL = req.query.url;
    if (!videoURL) return res.status(400).send('נא לספק קישור');

    try {
        res.header('Content-Disposition', 'attachment; filename="audio.mp3"');
        ytdl(videoURL, { filter: 'audioonly', quality: 'highestaudio' }).pipe(res);
    } catch (err) {
        console.error(err);
        res.status(500).send('שגיאה בהורדה. ייתכן והקישור לא תקין.');
    }
});

app.listen(PORT, () => console.log('Server is live!'));
