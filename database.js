const axios = require('axios');
const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzlYXcPdq5BtPttfrHBC290DK6tzS69fdc95GKwDD8cSbsiZzmkD-rVogxuUeia0HeL/exec';

let data = { whitelist: { creators: [], places: [] }, pendingPlaces: [], keys: [] };

async function loadData() {
    try {
        const res = await axios.get(GOOGLE_SHEET_URL);
        if (res.data && res.data[1]) {
            data = JSON.parse(res.data[1][0]);
        }
    } catch (e) {}
}

async function save() {
    try {
        await axios.post(GOOGLE_SHEET_URL, { action: 'update', data: JSON.stringify(data) });
    } catch (e) {}
}

setInterval(loadData, 30000);
loadData();

module.exports = { getData: () => data, save, checkExpiration: () => {} };
