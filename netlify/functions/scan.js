// netlify/functions/scan.js
// Vollständiger serverseitiger Scan:
//   1. Yahoo Finance Pre-Market Kurse holen
//   2. Claude AI Turbo-Analyse pro Symbol
//   3. Ergebnisse ranken & zurückgeben

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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// ── Yahoo Finance Kurs holen ──────────────────────────
async function getQuote(sym) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1m&range=1d&includePrePost=true`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) throw new Error('No meta');

    const regularPrice = meta.regularMarketPrice ?? meta.chartPreviousClose ?? 0;
    const prePrice     = meta.preMarketPrice ?? regularPrice;
    const prevClose    = meta.chartPreviousClose ?? regularPrice;
    const chgPct       = prevClose ? ((prePrice - prevClose) / prevClose * 100) : 0;

    return {
      symbol: sym,
      price: prePrice,
      prevClose,
      chgPct: +chgPct.toFixed(3),
      isPreMarket: !!meta.preMarketPrice,
      volume: meta.regularMarketVolume ?? 0,
    };
  } catch (e) {
    console.log(`Quote error ${sym}: ${e.message}`);
    return null;
  }
}

// ── Turbo-Scheine via Claude AI generieren ────────────
async function generateTurbos(sym, spot, pmGap, cfg) {
  const emitLine = cfg.emit === 'all'
    ? 'Emittenten zur Auswahl: Citi, HSBC, SG, BNP Paribas, Goldman Sachs, UBS.'
    : `Nur Emittent: ${cfg.emit}.`;

  // Ratio sinnvoll wählen je nach Kurshöhe
  const ratio = spot > 500 ? 10 : spot > 100 ? 100 : 100;

  const prompt = `Du bist Spezialist für Knock-Out-Zertifikate (Turbos) auf US-Aktien, handelbar in Deutschland.

Basiswert: ${sym}
Aktueller Pre-Market-Kurs: $${spot.toFixed(2)}
Pre-Market-Gap heute: ${pmGap >= 0 ? '+' : ''}${pmGap.toFixed(2)}%
${emitLine}
EUR/USD Kurs: 1.085
Typische Ratio für diesen Kurs: 1:${ratio}

Erstelle genau 3 realistische Knock-Out-Scheine passend zu diesem Basiswert.
Richtung: ${Math.abs(pmGap) < 0.5 ? 'je 1-2 CALL und PUT' : pmGap > 0 ? 'bevorzugt CALL (Long), 1 PUT' : 'bevorzugt PUT (Short), 1 CALL'}

Regeln:
- KO-Abstand zum aktuellen Kurs: zwischen 0.5% und ${cfg.ko}%
- Turbopreis MUSS unter €${cfg.price} liegen
- Hebel MUSS mindestens ${cfg.lev}x sein
- Turbopreis = (Abstand Kurs zu Strike in USD) / Ratio / EUR-USD-Kurs
- Hebel = (Kurs in USD / Ratio) / (Turbopreis in EUR) / EUR-USD-Kurs  
- WKN: 6-stellig alphanumerisch (z.B. "HC5X2A")
- strikePrice ist ca. 0.5% weiter entfernt als koPrice

Antworte AUSSCHLIESSLICH mit einem JSON-Array, kein Text davor oder danach, keine Markdown-Backticks:
[{"type":"CALL","emittent":"Citi","wkn":"HC5X2A","koPrice":112.50,"strikePrice":112.00,"ratio":100,"turboPrice":0.28,"leverage":38.2,"distance":2.1},...]`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // schneller & günstiger für viele Calls
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Claude API ${res.status}: ${errText.slice(0, 100)}`);
    }

    const data = await res.json();
    const raw = (data?.content?.[0]?.text || '').trim();

    // JSON extrahieren (robust gegen Markdown-Backticks)
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error(`No JSON array found in: ${raw.slice(0, 100)}`);

    const arr = JSON.parse(jsonMatch[0]);

    return arr
      .filter(t =>
        t.leverage >= cfg.lev &&
        t.turboPrice <= cfg.price &&
        t.distance <= cfg.ko &&
        t.turboPrice > 0
      )
      .map(t => {
        const dir = t.type === 'CALL' ? 1 : -1;
        const potential = +(pmGap * dir * t.leverage * 0.85).toFixed(1);
        const score = potential > 0
          ? +(potential * (1 / Math.max(0.1, t.distance)) * Math.log(Math.max(1, t.leverage))).toFixed(2)
          : 0;
        return { ...t, symbol: sym, spotPrice: spot, pmGap, potential, score };
      });

  } catch (e) {
    console.log(`Turbo error ${sym}: ${e.message}`);
    return [];
  }
}

// ── Hauptfunktion ─────────────────────────────────────
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

  console.log('Scan config:', cfg);

  // 1. Alle Kurse parallel holen
  const quotes = await Promise.all(WATCHLIST.map(w => getQuote(w.sym)));
  const validQuotes = quotes.filter(q => q && q.price > 0);

  console.log(`Got ${validQuotes.length} valid quotes`);

  // 2. Relevante Symbole filtern (Gap > 0.1% oder immer wenn kein Gap-Filter)
  const relevant = validQuotes.filter(q => {
    if (Math.abs(q.chgPct) < 0.1) return false;
    if (cfg.dir === 'call' && q.chgPct < 0) return false;
    if (cfg.dir === 'put'  && q.chgPct > 0) return false;
    return true;
  });

  console.log(`Relevant symbols: ${relevant.map(q => q.symbol).join(', ')}`);

  // 3. Turbos generieren (sequenziell um API nicht zu überlasten)
  let allTurbos = [];
  for (const q of relevant) {
    const turbos = await generateTurbos(q.symbol, q.price, q.chgPct, cfg);
    allTurbos.push(...turbos);
    // Kurze Pause zwischen Calls
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`Generated ${allTurbos.length} turbos before filter`);

  // 4. Sortieren nach Score, Top N
  allTurbos.sort((a, b) => b.score - a.score);
  const topTurbos = allTurbos.slice(0, cfg.topN);

  // 5. Marktdaten für die Bar mitschicken
  const marketData = {};
  validQuotes.forEach(q => { marketData[q.symbol] = q; });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      turbos: topTurbos,
      total: allTurbos.length,
      marketData,
      scannedSymbols: relevant.length,
      timestamp: Date.now(),
      cfg,
    }),
  };
};
