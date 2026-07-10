const axios = require('axios');

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GIST_ID = process.env.GIST_ID;
const FILE_NAME = 'database.json';

let data = {
    whitelist: { creators: [], places: [] },
    pendingPlaces: [],
    keys: []
};

async function loadData() {
    if (!GITHUB_TOKEN || !GIST_ID) {
        return;
    }
    try {
        const res = await axios.get(`https://api.github.com/gists/${GIST_ID}`, {
            headers: { Authorization: `token ${GITHUB_TOKEN}` }
        });
        const file = res.data.files[FILE_NAME];
        if (file && file.content) {
            const parsed = JSON.parse(file.content);
            if (parsed.whitelist) data.whitelist = parsed.whitelist;
            if (parsed.pendingPlaces) data.pendingPlaces = parsed.pendingPlaces;
            if (parsed.keys) {
                data.keys = parsed.keys.map(k => typeof k === 'string' ? { key: k } : { key: k.key });
            }
        }
    } catch (e) {}
}

async function save() {
    if (!GITHUB_TOKEN || !GIST_ID) {
        return;
    }
    try {
        const stringified = JSON.stringify(data, null, 2);
        await axios.patch(`https://api.github.com/gists/${GIST_ID}`, {
            files: {
                [FILE_NAME]: { content: stringified }
            }
        }, {
            headers: { Authorization: `token ${GITHUB_TOKEN}` }
        });
    } catch (e) {}
}

loadData();

function checkExpiration() {
    const now = Date.now();
    let changed = false;

    ['creators', 'places'].forEach(type => {
        data.whitelist[type].forEach(item => {
            if (item.keys && Array.isArray(item.keys)) {
                const initialLength = item.keys.length;
                item.keys = item.keys.filter(k => !k.expiresAt || k.expiresAt > now);
                if (item.keys.length !== initialLength) changed = true;
            }
        });

        const initialLength = data.whitelist[type].length;
        data.whitelist[type] = data.whitelist[type].filter(item => {
            if (item.keys && Array.isArray(item.keys) && item.keys.length > 0) {
                return true;
            }
            return !item.expiresAt || item.expiresAt > now;
        });

        if (data.whitelist[type].length !== initialLength) changed = true;
    });

    if (changed) save();
}
setInterval(checkExpiration, 1000);

module.exports = {
    getData: () => data,
    save,
    checkExpiration
};
