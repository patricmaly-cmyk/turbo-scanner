// netlify/functions/debug.js
// Aufruf: /.netlify/functions/debug
// Zeigt genau was Yahoo Finance zurückgibt und ob die Turbo-Berechnung funktioniert

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

const EUR_USD = 1.085;

function calcTurbosDebug(sym, spot, pmGap, cfg) {
  const ratio = spot > 400 ? 10 : 100;
  const turbos = [];
  const emits = ['Citi', 'HSBC', 'SG'];

  // Teste 5 verschiedene Abstände
  const testDistances = [1.0, 2.0, 3.0, 4.0, 5.0];

  for (let i = 0; i < testDistances.length; i++) {
    const dist = testDistances[i];
    const type = i % 2 === 0 ? 'CALL' : 'PUT';

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
    const leverage   = +((spot / ratio / EUR_USD) / turboPrice).toFixed(1);

    turbos.push({
      type, dist, koPrice, strikePrice, ratio,
      turboPrice, leverage,
      passesPrice:  turboPrice <= cfg.price,
      passesLev:    leverage >= cfg.lev,
      passesDist:   dist <= cfg.ko,
      passesAll:    turboPrice <= cfg.price && leverage >= cfg.lev && dist <= cfg.ko,
    });
  }
  return turbos;
}

exports.handler = async (event) => {
  const log = [];

  // Test 1: Yahoo Finance für NVDA
  log.push('=== TEST 1: Yahoo Finance NVDA ===');
  let nvdaPrice = null;
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1m&range=1d&includePrePost=true';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json',
      }
    });
    log.push(`HTTP Status: ${res.status}`);
    if (res.ok) {
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      log.push(`meta keys: ${Object.keys(meta || {}).join(', ')}`);
      log.push(`regularMarketPrice: ${meta?.regularMarketPrice}`);
      log.push(`preMarketPrice: ${meta?.preMarketPrice}`);
      log.push(`chartPreviousClose: ${meta?.chartPreviousClose}`);
      nvdaPrice = meta?.preMarketPrice ?? meta?.regularMarketPrice;
      log.push(`→ Using price: ${nvdaPrice}`);
    } else {
      const txt = await res.text();
      log.push(`Error body: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    log.push(`EXCEPTION: ${e.message}`);
  }

  // Test 2: Turbo-Berechnung mit echtem oder Fallback-Preis
  log.push('');
  log.push('=== TEST 2: Turbo-Berechnung ===');
  const testPrice = nvdaPrice ?? 115.0;
  const testCfg   = { price: 5.0, lev: 5, ko: 10.0, emit: 'all' };
  log.push(`Test mit Preis: $${testPrice}, cfg: ${JSON.stringify(testCfg)}`);

  const turbos = calcTurbosDebug('NVDA', testPrice, 1.5, testCfg);
  turbos.forEach(t => {
    log.push(`  ${t.type} dist=${t.dist}% → Preis=€${t.turboPrice} Hebel=${t.leverage}x | passes: price=${t.passesPrice} lev=${t.passesLev} dist=${t.passesDist} ALL=${t.passesAll}`);
  });

  const passing = turbos.filter(t => t.passesAll);
  log.push(`→ ${passing.length}/${turbos.length} Turbos bestehen alle Filter`);

  // Test 3: Produktionsparameter simulieren
  log.push('');
  log.push('=== TEST 3: Standard-Parameter (KO=5%, Preis=€0.50, Hebel=15x) ===');
  const stdCfg = { price: 0.5, lev: 15, ko: 5.0, emit: 'all' };
  const stdTurbos = calcTurbosDebug('NVDA', testPrice, 1.5, stdCfg);
  stdTurbos.forEach(t => {
    log.push(`  ${t.type} dist=${t.dist}% → Preis=€${t.turboPrice} Hebel=${t.leverage}x | passes: price=${t.passesPrice} lev=${t.passesLev} dist=${t.passesDist} ALL=${t.passesAll}`);
  });
  const stdPassing = stdTurbos.filter(t => t.passesAll);
  log.push(`→ ${stdPassing.length}/${stdTurbos.length} bestehen Standard-Filter`);

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({ log, nvdaPrice, timestamp: new Date().toISOString() }, null, 2),
  };
};
