// netlify/functions/scan.js – Finnhub Edition

const WATCHLIST = [
  { sym: 'NVDA',  name: 'NVIDIA' },
  { sym: 'TSLA',  name: 'Tesla' },
  { sym: 'AAPL',  name: 'Apple' },
  { sym: 'AMD',   name: 'AMD' },
  { sym: 'META',  name: 'Meta' },
  { sym: 'AMZN',  name: 'Amazon' },
  { sym: 'MSFT',  name: 'Microsoft' },
  { sym: 'GOOGL', name: 'Alphabet' },
  { sym: 'NFLX',  name: 'Netflix' },
  { sym: 'COIN',  name: 'Coinbase' },
  { sym: 'PLTR',  name: 'Palantir' },
  { sym: 'MU',    name: 'Micron' },
  { sym: 'SMCI',  name: 'SuperMicro' },
  { sym: 'ARM',   name: 'ARM Holdings' },
  { sym: 'SPY',   name: 'S&P500 ETF' },
  { sym: 'QQQ',   name: 'Nasdaq ETF' },
];

const FINNHUB_KEY = 'd6ncbf1r01qodk5v6c6gd6ncbf1r01qodk5v6c70';
const EMITTENTEN  = ['Citi', 'HSBC', 'SG', 'BNP', 'Goldman', 'UBS'];
const EUR_USD     = 1.085;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Pseudo-Random für WKN ─────────────────────────────
function seededRand(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}
function wknFromSeed(r) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let w = '';
  for (let i = 0; i < 6; i++) w += chars[Math.floor(r() * chars.length)];
  return w;
}

// ── Finnhub Quote holen ───────────────────────────────
async function getQuote(sym) {
  try {
    // Quote endpoint: gibt c (current), pc (prev close), auch preMarket wenn verfügbar
    const url = `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB_KEY}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Finnhub: c=current, pc=prevClose, dp=change%, h=high, l=low, o=open
    if (!data || !data.c || data.c === 0) throw new Error('No price data');

    const currentPrice = data.c;
    const prevClose    = data.pc || data.c;
    const chgPct       = prevClose > 0 ? ((currentPrice - prevClose) / prevClose * 100) : 0;

    console.log(`${sym}: c=${currentPrice}, pc=${prevClose}, chg=${chgPct.toFixed(2)}%`);

    return {
      symbol:      sym,
      price:       currentPrice,
      prevClose,
      chgPct:      +chgPct.toFixed(3),
      isPreMarket: false, // Finnhub basic gibt Echtzeit-Kurs
      volume:      data.v ?? 0,
      high:        data.h ?? currentPrice,
      low:         data.l  ?? currentPrice,
    };
  } catch (e) {
    console.log(`Quote error ${sym}: ${e.message}`);
    return null;
  }
}

// ── Turbo-Scheine berechnen ───────────────────────────
function calcTurbos(sym, spot, pmGap, cfg) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seed  = sym.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + parseInt(today);
  const r     = seededRand(seed);

  const ratio = spot > 400 ? 10 : 100;
  const emits = cfg.emit === 'all' ? EMITTENTEN : [cfg.emit];
  const turbos = [];

  // Abstände gleichmäßig von 0.4% bis cfg.ko%
  const steps = 7;
  const distances = [];
  for (let i = 0; i < steps; i++) {
    const d = 0.4 + (cfg.ko - 0.4) * (i / (steps - 1));
    distances.push(+(d + (r() - 0.5) * 0.2).toFixed(2));
  }

  // Richtungen: Gap-bevorzugt
  const types = [];
  if (cfg.dir === 'all') {
    if (pmGap >= 0) types.push('CALL','CALL','CALL','PUT','PUT','PUT','CALL');
    else            types.push('PUT','PUT','PUT','CALL','CALL','CALL','PUT');
  } else {
    for (let i = 0; i < steps; i++) types.push(cfg.dir.toUpperCase());
  }

  for (let i = 0; i < steps; i++) {
    const type     = types[i];
    const dist     = Math.max(0.3, distances[i]);
    const emittent = emits[Math.floor(r() * emits.length)];

    let koPrice, strikePrice;
    if (type === 'CALL') {
      koPrice     = +(spot * (1 - dist / 100)).toFixed(2);
      strikePrice = +(koPrice * 0.997).toFixed(2);
    } else {
      koPrice     = +(spot * (1 + dist / 100)).toFixed(2);
      strikePrice = +(koPrice * 1.003).toFixed(2);
    }

    const abstandUSD = Math.abs(spot - strikePrice);
    const turboPrice = +(abstandUSD / ratio / EUR_USD).toFixed(3);
    if (turboPrice < 0.003) continue;
    if (turboPrice > cfg.price) continue;

    const leverage = +((spot / ratio / EUR_USD) / turboPrice).toFixed(1);
    if (leverage < cfg.lev) continue;
    if (dist > cfg.ko) continue;

    const dir       = type === 'CALL' ? 1 : -1;
    // Falls kein Gap vorhanden, nutze kleinen Dummy-Gap für Score
    const effectiveGap = Math.abs(pmGap) < 0.05 ? 0.5 : pmGap;
    const potential = +(effectiveGap * dir * leverage * 0.85).toFixed(1);
    const score     = potential > 0
      ? +(potential * (1 / Math.max(0.1, dist)) * Math.log(Math.max(1.1, leverage))).toFixed(2)
      : 0.01; // Auch negative Szenarien leicht positiv damit sie erscheinen

    turbos.push({
      type, emittent,
      wkn:        wknFromSeed(r),
      koPrice, strikePrice, ratio,
      turboPrice, leverage,
      distance:   dist,
      symbol:     sym,
      spotPrice:  spot,
      pmGap,
      potential,
      score,
    });
  }

  return turbos;
}

// ── Handler ───────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const cfg = {
    dir:   params.dir   || 'all',
    ko:    parseFloat(params.ko)    || 5,
    price: parseFloat(params.price) || 0.5,
    lev:   parseFloat(params.lev)   || 15,
    emit:  params.emit  || 'all',
    topN:  parseInt(params.topN)    || 25,
  };

  console.log('Config:', JSON.stringify(cfg));

  // 1. Kurse parallel holen (Finnhub: 60 req/min kostenlos)
  // In Batches zu je 10 um Rate-Limit zu schonen
  const allQuotes = [];
  for (let i = 0; i < WATCHLIST.length; i += 8) {
    const batch = WATCHLIST.slice(i, i + 8);
    const results = await Promise.all(batch.map(w => getQuote(w.sym)));
    allQuotes.push(...results);
    if (i + 8 < WATCHLIST.length) await new Promise(r => setTimeout(r, 500));
  }

  const validQuotes = allQuotes.filter(q => q && q.price > 0);
  console.log(`Valid: ${validQuotes.length}/${WATCHLIST.length}`);

  // 2. Alle Symbole scannen
  const relevant = validQuotes.filter(q => {
    if (cfg.dir === 'call' && q.chgPct < -1) return false;
    if (cfg.dir === 'put'  && q.chgPct >  1) return false;
    return true;
  });

  // 3. Turbos berechnen
  let allTurbos = [];
  for (const q of relevant) {
    const turbos = calcTurbos(q.symbol, q.price, q.chgPct, cfg);
    console.log(`${q.symbol}: ${turbos.length} turbos`);
    allTurbos.push(...turbos);
  }

  // 4. Sortieren
  allTurbos.sort((a, b) => b.score - a.score);
  const topTurbos = allTurbos.slice(0, cfg.topN);

  const marketData = {};
  validQuotes.forEach(q => { marketData[q.symbol] = q; });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      turbos:         topTurbos,
      total:          allTurbos.length,
      marketData,
      scannedSymbols: relevant.length,
      validQuotes:    validQuotes.length,
      timestamp:      Date.now(),
      cfg,
    }),
  };
};
