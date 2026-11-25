// Запуск: node server.js  (нужен Node 18+, зависимости не нужны)
// Открыть: http://localhost:3000
const http = require('http'), fs = require('fs'), path = require('path');

// Тикеры Yahoo Finance
const SYM = {
  dxy: 'DX-Y.NYB', eurusd: 'EURUSD=X', gbpusd: 'GBPUSD=X', usdjpy: 'USDJPY=X', usdchf: 'USDCHF=X', audusd: 'AUDUSD=X',
  xau: 'GC=F', xag: 'SI=F', brent: 'BZ=F', wti: 'CL=F', ng: 'NG=F',
  spx: '^GSPC', ndx: '^NDX', dax: '^GDAXI', btc: 'BTC-USD', eth: 'ETH-USD', usdrub: 'RUB=X'
};
const TTL_Q = 15000, TTL_H = 60000;   // кэш: котировки 15 с, история 60 с
const MAX_PER_MIN = 100;              // защита: не больше 100 запросов в минуту к источнику
const IV = ['5m', '15m', '1h'];
const cache = new Map(), calls = [];

async function yahoo(id, range, interval, ttl) {
  const key = id + range + interval, hit = cache.get(key), now = Date.now();
  if (hit && now - hit.t < ttl) return hit.v;
  while (calls.length && now - calls[0] > 60000) calls.shift();
  if (calls.length >= MAX_PER_MIN) { if (hit) return hit.v; throw new Error('rate guard'); }
  calls.push(now);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYM[id])}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) { if (hit) return hit.v; throw new Error('upstream ' + r.status); }
  const j = await r.json(), res = j.chart && j.chart.result && j.chart.result[0];
  if (!res) throw new Error('no data');
  cache.set(key, { t: now, v: res });
  return res;
}

function series(res) {
  const t = res.timestamp || [], q = (res.indicators.quote || [{}])[0];
  return t.map((x, i) => ({ t: x, o: q.open && q.open[i], c: q.close && q.close[i] })).filter(p => p.c != null);
}

async function quote(id) {
  const r = await yahoo(id, '1d', '5m', TTL_Q), m = r.meta, s = series(r);
  const first = s.find(p => p.o != null);
  const price = m.regularMarketPrice;
  const prev = m.previousClose != null ? m.previousClose : m.chartPreviousClose;
  const open = first ? first.o : prev;                        // цена открытия дня
  const base = prev != null ? prev : open;
  const cl = s.map(p => p.c), step = Math.max(1, Math.floor(cl.length / 30));
  const spark = cl.filter((_, i) => i % step === 0).concat(price);
  return {
    id, price, prev, open, pct: (price / base - 1) * 100, time: m.regularMarketTime,
    hi: m.regularMarketDayHigh != null ? m.regularMarketDayHigh : Math.max(...cl),
    lo: m.regularMarketDayLow != null ? m.regularMarketDayLow : Math.min(...cl),
    t0: s.length ? s[0].t : null, spark
  };
}

async function history(id, iv) {
  const r = await yahoo(id, '2d', iv, TTL_H), min = Date.now() / 1000 - 86400;
  return { id, iv, points: series(r).filter(p => p.t >= min).map(p => [p.t, p.c]) };
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  try {
    if (u.pathname === '/api/quote') {
      const ids = (u.searchParams.get('ids') || '').split(',').filter(i => SYM[i]), out = {};
      await Promise.all(ids.map(async i => { try { out[i] = await quote(i); } catch (e) { /* пропускаем актив */ } }));
      return send(200, out);
    }
    if (u.pathname === '/api/history') {
      const id = u.searchParams.get('id'), iv = IV.includes(u.searchParams.get('iv')) ? u.searchParams.get('iv') : '15m';
      if (!SYM[id]) return send(400, { error: 'unknown id' });
      return send(200, await history(id, iv));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end();
  } catch (e) { send(502, { error: String(e.message) }); }
}).listen(process.env.PORT || 3000, () => console.log('Открой http://localhost:' + (process.env.PORT || 3000)));
