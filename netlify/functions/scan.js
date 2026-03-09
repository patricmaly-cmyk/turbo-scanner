// netlify/functions/scan.js
// Serverseitiger Pre-Market Turbo Scanner
//   1. Yahoo Finance Pre-Market Kurse holen
//   2. Turbo-Scheine mathematisch berechnen (kein externer API-Key nötig)
//   3. Nach Score ranken & zurückgeben

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

const EMITTENTEN = ['Citi', 'HSBC', 'SG', 'BNP', 'Goldman', 'UBS'];
const EUR_USD = 1.085;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Deterministisches Pseudo-Random (reproduzierbar je Symbol+Tag) ────────────
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

// ── Yahoo Finance Kurs holen ──────────────────────────────────────────────────
async function getQuote(sym) {
  // Zwei Yahoo-Endpunkte als Fallback
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d&includePrePost=true`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d&includePrePost=true`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta || !meta.regularMarketPrice) continue;

      const regularPrice = meta.regularMarketPrice;
      const prePrice     = meta.preMarketPrice ?? regularPrice;
      const prevClose    = meta.chartPreviousClose ?? meta.previousClose ?? regularPrice;
      const chgPct       = prevClose > 0 ? ((prePrice - prevClose) / prevClose * 100) : 0;

      console.log(`${sym}: price=${prePrice}, prev=${prevClose}, chg=${chgPct.toFixed(2)}%, pre=${!!meta.preMarketPrice}`);

      return {
        symbol: sym,
        price: prePrice,
        prevClose,
        chgPct: +chgPct.toFixed(3),
        isPreMarket: !!meta.preMarketPrice,
        volume: meta.regularMarketVolume ?? 0,
      };
    } catch (e) {
      console.log(`Quote error ${sym} (${url}): ${e.message}`);
    }
  }
  return null;
}

// ── Turbo-Scheine mathematisch berechnen ─────────────────────────────────────
// Echte Knock-Out-Formel:
//   Turbopreis (€) = (Spot - Strike) / Ratio / EUR_USD        [für CALL]
//   Turbopreis (€) = (Strike - Spot) / Ratio / EUR_USD        [für PUT]
//   Hebel          = Spot / Ratio / EUR_USD / Turbopreis
//   KO-Abstand (%) = |Spot - KO| / Spot * 100
//
// KO-Preis = Strike (vereinfacht, in Realität leicht darunter/darüber)
// ─────────────────────────────────────────────────────────────────────────────
function calcTurbos(sym, spot, pmGap, cfg) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seed   = sym.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + parseInt(today);
  const r      = seededRand(seed);

  const ratio     = spot > 400 ? 10 : spot > 50 ? 100 : 100;
  const turbos    = [];

  // Emittenten-Liste je nach Filter
  const emits = cfg.emit === 'all' ? EMITTENTEN : [cfg.emit];

  // KO-Abstände die wir durchprobieren: von sehr nah bis cfg.ko
  // Wir generieren mehrere Abstände pro Richtung
  const distances = [];
  const step = cfg.ko / 6;
  for (let d = 0.4; d <= cfg.ko; d += step) {
    distances.push(+(d + r() * step * 0.5).toFixed(2));
  }
  // Immer mindestens 3 Abstände
  while (distances.length < 3) distances.push(+(r() * cfg.ko * 0.8 + 0.4).toFixed(2));

  const types = [];
  if (cfg.dir === 'all') {
    // Gap-Richtung bevorzugen: 2 in Gap-Richtung, 1 dagegen
    if (pmGap >= 0) { types.push('CALL', 'CALL', 'PUT'); }
    else            { types.push('PUT', 'PUT', 'CALL'); }
  } else {
    types.push(cfg.dir.toUpperCase(), cfg.dir.toUpperCase(), cfg.dir.toUpperCase());
  }

  for (let i = 0; i < Math.min(types.length, distances.length); i++) {
    const type     = types[i];
    const dist     = distances[i];
    const emittent = emits[Math.floor(r() * emits.length)];

    // KO und Strike berechnen
    let koPrice, strikePrice;
    if (type === 'CALL') {
      koPrice     = +(spot * (1 - dist / 100)).toFixed(2);
      strikePrice = +(koPrice * (1 - 0.003)).toFixed(2); // Strike leicht unter KO
    } else {
      koPrice     = +(spot * (1 + dist / 100)).toFixed(2);
      strikePrice = +(koPrice * (1 + 0.003)).toFixed(2); // Strike leicht über KO
    }

    // Turbopreis berechnen
    const abstandUSD = Math.abs(spot - strikePrice);
    const turboPrice = +(abstandUSD / ratio / EUR_USD).toFixed(3);

    // Mindestpreis (Spread etc.)
    if (turboPrice < 0.005) continue;

    // Filter anwenden
    if (turboPrice > cfg.price) continue;

    // Hebel berechnen
    const leverage = +((spot / ratio / EUR_USD) / turboPrice).toFixed(1);
    if (leverage < cfg.lev) continue;
    if (dist > cfg.ko) continue;

    // Potenzial & Score
    const dir       = type === 'CALL' ? 1 : -1;
    const potential = +(pmGap * dir * leverage * 0.85).toFixed(1);
    const score     = potential > 0
      ? +(potential * (1 / Math.max(0.1, dist)) * Math.log(Math.max(1.1, leverage))).toFixed(2)
      : 0;

    turbos.push({
      type,
      emittent,
      wkn:         wknFromSeed(r),
      koPrice,
      strikePrice,
      ratio,
      turboPrice,
      leverage,
      distance:    dist,
      symbol:      sym,
      spotPrice:   spot,
      pmGap,
      potential,
      score,
    });
  }

  return turbos;
}

// ── Hauptfunktion ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' };
  }

  const params = event.queryStringParameters || {};
  const cfg = {
    dir:   params.dir  || 'all',
    ko:    parseFloat(params.ko)    || 5,
    price: parseFloat(params.price) || 0.5,
    lev:   parseFloat(params.lev)   || 15,
    emit:  params.emit || 'all',
    topN:  parseInt(params.topN)    || 25,
  };

  console.log('Scan config:', JSON.stringify(cfg));

  // 1. Alle Kurse parallel holen
  const quoteResults = await Promise.all(WATCHLIST.map(w => getQuote(w.sym)));
  const validQuotes  = quoteResults.filter(q => q && q.price > 0);

  console.log(`Valid quotes: ${validQuotes.length}/${WATCHLIST.length}`);
  console.log(`Gaps: ${validQuotes.map(q => `${q.symbol}:${q.chgPct.toFixed(1)}%`).join(', ')}`);

  // 2. Alle Symbole verwenden (auch kleine Gaps) – kein Gap-Filter mehr
  const relevant = validQuotes.filter(q => {
    if (cfg.dir === 'call' && q.chgPct < -0.05) return false;
    if (cfg.dir === 'put'  && q.chgPct >  0.05) return false;
    return true;
  });

  console.log(`Scanning ${relevant.length} symbols`);

  // 3. Turbos berechnen
  let allTurbos = [];
  for (const q of relevant) {
    const turbos = calcTurbos(q.symbol, q.price, q.chgPct, cfg);
    console.log(`${q.symbol}: generated ${turbos.length} turbos`);
    allTurbos.push(...turbos);
  }

  console.log(`Total turbos after filter: ${allTurbos.length}`);

  // 4. Sortieren & Top N
  allTurbos.sort((a, b) => b.score - a.score);
  const topTurbos = allTurbos.slice(0, cfg.topN);

  // 5. Marktdaten für Header-Bar
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
