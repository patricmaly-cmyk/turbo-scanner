// netlify/functions/quote.js
// Proxy für Yahoo Finance – umgeht CORS im Browser
// Aufruf: /.netlify/functions/quote?symbols=NVDA,TSLA,AAPL

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const symbols = (event.queryStringParameters?.symbols || '').split(',').filter(Boolean);
  if (!symbols.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No symbols provided' }) };
  }

  const results = {};

  await Promise.all(symbols.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym.trim()}?interval=1m&range=1d&includePrePost=true`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible)',
          'Accept': 'application/json',
        }
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) throw new Error('No meta');

      const regularPrice = meta.regularMarketPrice ?? meta.chartPreviousClose;
      const prePrice     = meta.preMarketPrice ?? regularPrice;
      const prevClose    = meta.chartPreviousClose ?? regularPrice;
      const chgPct       = prevClose ? ((prePrice - prevClose) / prevClose * 100) : 0;

      results[sym] = {
        symbol:      sym,
        price:       prePrice,
        prevClose,
        chgPct:      +chgPct.toFixed(3),
        isPreMarket: !!meta.preMarketPrice,
        volume:      meta.regularMarketVolume ?? 0,
        name:        meta.longName ?? meta.shortName ?? sym,
        currency:    meta.currency ?? 'USD',
        ts:          Date.now(),
      };
    } catch (e) {
      results[sym] = { symbol: sym, error: e.message };
    }
  }));

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(results),
  };
};
