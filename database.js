const axios = require('axios');
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzlYXcPdq5BtPttfrHBC290DK6tzS69fdc95GKwDD8cSbsiZzmkD-rVogxuUeia0HeL/exec';

let data = { 
    whitelist: { creators: [], places: [] }, 
    pendingPlaces: [], 
    keys: [],
    logs: [] 
};

async function loadData() {
    try {
        const res = await axios.get(GOOGLE_SHEET_URL, { timeout: 10000 });
        if (res.data) {
            const מנוקה = res.data;
            if (!מנוקה.whitelist) מנוקה.whitelist = { creators: [], places: [] };
            if (!מנוקה.pendingPlaces) מנוקה.pendingPlaces = [];
            if (!מנוקה.keys) מנוקה.keys = [];
            if (!מנוקה.logs) מנוקה.logs = [];
            
            data = מנוקה;
        }
    } catch (e) {
        console.error("Error loading data from Google Sheets:", e.message);
    }
}

async function save() {
    try {
        await axios.post(GOOGLE_SHEET_URL, { 
            action: 'update', 
            data: JSON.stringify(data) 
        }, { timeout: 10000 });
    } catch (e) {
        console.error("Error saving data to Google Sheets:", e.message);
    }
}

function checkExpiration() {
    const now = Date.now();
    let changed = false;
    
    if (!data.whitelist) return;

    ['creators', 'places'].forEach(type => {
        if (data.whitelist[type] && Array.isArray(data.whitelist[type])) {
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
        }
    });
    
    if (changed) {
        save().catch(err => console.error(err));
    }
}

loadData().then(() => {
    setInterval(loadData, 30000);
}).catch(err => {
    console.error("Initial load failed, starting interval anyway:", err);
    setInterval(loadData, 30000);
});

module.exports = { 
    getData: () => data, 
    save, 
    checkExpiration 
};
