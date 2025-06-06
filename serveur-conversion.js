const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = 5010;

let cachedRate = null;
let lastUpdated = 0;

// 🔁 Fonction pour récupérer le taux de Google Finance
async function fetchExchangeRate() {
  try {
    const res = await axios.get('https://www.google.com/finance/quote/USDT-EUR', {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    const $ = cheerio.load(res.data);
    const rateText = $('div.YMlKec.fxKbKc').first().text().replace(',', '.');
    const rate = parseFloat(rateText);

    if (!isNaN(rate)) {
      cachedRate = rate;
      lastUpdated = Date.now();
      console.log(`💱 Taux mis à jour : 1 USDT = ${rate} EUR`);
    }

  } catch (err) {
    console.warn('⚠️ Erreur récupération taux :', err.message);
  }
}

// 🔁 Met à jour le taux toutes les 30 secondes
setInterval(fetchExchangeRate, 30_000);
fetchExchangeRate();

// 📤 API simple
app.get('/convert', async (req, res) => {
  const amount = parseFloat(req.query.amount);
  const from = (req.query.from || '').toLowerCase();

  if (!amount || (from !== 'eur' && from !== 'usdt')) {
    return res.status(400).json({ error: 'Paramètres requis : amount, from (eur|usdt)' });
  }

  if (!cachedRate) {
    return res.status(503).json({ error: 'Taux indisponible pour le moment.' });
  }

  let result;
  if (from === 'usdt') {
    result = +(amount * cachedRate).toFixed(4); // USDT ➜ EUR
  } else {
    result = +(amount / cachedRate).toFixed(4); // EUR ➜ USDT
  }

  res.json({
    from,
    to: from === 'usdt' ? 'eur' : 'usdt',
    original: amount,
    converted: result,
    rate: cachedRate,
    updated: new Date(lastUpdated).toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur conversion USDT/EUR lancé sur http://localhost:${PORT}`);
});
