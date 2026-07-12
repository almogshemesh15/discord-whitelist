const axios = require('axios');
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzlYXcPdq5BtPttfrHBC290DK6tzS69fdc95GKwDD8cSbsiZzmkD-rVogxuUeia0HeL/exec';

let data = { 
    whitelist: { creators: [], places: [] }, 
    pendingPlaces: [], 
    keys: [],
    activeSessions: [],
    logs: []
};

async function loadData() {
    try {
        const res = await axios.get(GOOGLE_SHEET_URL, { timeout: 5000 });
        if (res.data && res.data.whitelist) {
            data = JSON.parse(JSON.stringify(res.data));
            console.log('✅ Data loaded from Google Sheets');
        }
    } catch (e) {
        console.error('⚠️ Failed to load from Google Sheets:', e.message);
        // זה לא קריטי, נמשיך עם הנתונים הקיימים
    }
}

async function save() {
    try {
        await axios.post(GOOGLE_SHEET_URL, { 
            action: 'update', 
            data: JSON.stringify(data) 
        }, { timeout: 5000 });
        console.log('✅ Data saved to Google Sheets');
    } catch (e) {
        console.error('⚠️ Failed to save to Google Sheets:', e.message);
    }
}

function checkExpiration() {
    const now = Date.now();
    let changed = false;

    ['creators', 'places'].forEach(type => {
        if (!data.whitelist[type]) return;
        
        data.whitelist[type].forEach(item => {
            if (item.keys && Array.isArray(item.keys)) {
                const initialLength = item.keys.length;
                item.keys = item.keys.filter(k => !k.expiresAt || k.expiresAt > now);
                if (item.keys.length !== initialLength) changed = true;
            }
            if (item.expiresAt && item.expiresAt <= now) {
                item.expiresAt = null;
                changed = true;
            }
        });
    });

    if (changed) save();
}

// Load data on startup
loadData();

// Reload every 30 seconds
setInterval(loadData, 30000);

// Check expiration every minute
setInterval(checkExpiration, 60000);

module.exports = { 
    getData: () => data, 
    save, 
    checkExpiration 
};
