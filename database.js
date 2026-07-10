const axios = require('axios');

const GOOGLE_SHEET_URL = 'https://script.google.com/macros/s/AKfycbzlYXcPdq5BtPttfrHBC290DK6tzS69fdc95GKwDD8cSbsiZzmkD-rVogxuUeia0HeL/exec';

let data = {
    whitelist: { creators: [], places: [] },
    pendingPlaces: [],
    keys: []
};

async function loadData() {
    try {
        const res = await axios.get(GOOGLE_SHEET_URL);
        const rows = res.data;
        data.whitelist = { creators: [], places: [] };
        data.pendingPlaces = [];
        data.keys = [];
        rows.forEach((row, index) => {
            if (index === 0) return;
            const [name, id, key, type] = row;
            if (type === 'creators' || type === 'places') {
                data.whitelist[type].push({ id: Number(id), name, keys: [{ key }] });
            } else if (type === 'key') {
                data.keys.push({ key: id });
            }
        });
    } catch (e) {}
}

async function save() {
    try {
        await axios.post(GOOGLE_SHEET_URL, {
            action: 'update',
            data: data
        });
    } catch (e) {}
}

setInterval(loadData, 30000);
loadData();

function checkExpiration() {}

module.exports = {
    getData: () => data,
    save,
    checkExpiration
};
