// Запуск: node server.js  (нужен Node 18+, зависимости не нужны)
// Открыть: http://localhost:3000
// Для ИИ-сигналов: OPENROUTER_API_KEY=ваш_ключ node server.js  (запасной: GROQ_API_KEY; без ключа работает встроенный анализатор)
// ИИ анализирует все 5 активов одним запросом, результат кэшируется на 15 минут (кэш лежит в ai-cache.json),
// досрочно обновляется только если в ленте FinancialJuice появился новый заголовок
// Настоящие японские свечи: последние 20 свечей по каждому активу
//   BTC: Binance klines (запасные: data-api.binance.vision, затем Yahoo), остальные активы: Yahoo Finance chart (5m / 15m / 1h)
//   GET /api/candles?ids=eurusd,xau&iv=15m  ->  { eurusd: { id, iv, src, candles: [{ t, o, h, l, c, time, open, high, low, close }, ...] }, ... }
// Анализ строго по 20 последним свечам: коридор (мин/макс), наклон тренда, положение цены в коридоре, пробой или отскок.
// Цвет одной последней свечи на решение не влияет ни у ИИ, ни у запасного анализатора, ни при расчёте уровней.
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

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const fn = v => String(v).replace('.', ',');

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
  return t.map((x, i) => ({ t: x, o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i] })).filter(p => p.c != null);
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
  const r = await yahoo(id, '5d', iv, TTL_H), min = Date.now() / 1000 - 86400;   // окно 5d общее с candles(): один запрос к источнику на оба случая
  return { id, iv, points: series(r).filter(p => p.t >= min).map(p => [p.t, p.c]) };
}

/* ===================== Японские свечи (OHLC) ===================== */
const CANDLES_N = 20;       // сколько последних свечей отдаём и анализируем
const AI_IV = '15m';        // таймфрейм свечей, которые видит ИИ (общий запрос на все активы, поэтому один для всех)
const fixC = p => ({ t: p.t, o: p.o, h: Math.max(p.h, p.o, p.c), l: Math.min(p.l, p.o, p.c), c: p.c });   // тени всегда охватывают тело

const BIN_IV = { '5m': '5m', '15m': '15m', '1h': '1h' };
const BIN_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];   // второй хост работает там, где основной закрыт по региону

// BTC: настоящие свечи Binance (klines), от старых к новым, последняя ещё формируется
async function binanceCandles(iv) {
  let err = new Error('binance недоступен');
  for (const host of BIN_HOSTS) {
    try {
      const r = await fetch(host + '/api/v3/klines?symbol=BTCUSDT&interval=' + (BIN_IV[iv] || '15m') + '&limit=' + CANDLES_N, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('binance ' + r.status);
      const list = (await r.json()).map(k => fixC({ t: Math.floor(k[0] / 1000), o: +k[1], h: +k[2], l: +k[3], c: +k[4] })).filter(p => p.c > 0 && isFinite(p.o + p.h + p.l));
      if (list.length < 2) throw new Error('binance: мало свечей');
      return list;
    } catch (e) { err = e; }
  }
  throw err;
}

const cJobs = new Map();
async function loadCandles(id, iv, key, hit) {
  let list = null, src = 'yahoo';
  if (id === 'btc') { try { list = await binanceCandles(iv); src = 'binance'; } catch (e) { list = null; } }   // Yahoo остаётся запасным источником
  if (!list) {
    try { list = series(await yahoo(id, '5d', iv, TTL_Q)).filter(p => p.o != null && p.h != null && p.l != null).slice(-CANDLES_N).map(fixC); src = 'yahoo'; }
    catch (e) { if (hit) return hit.v; throw e; }
  }
  if (!list.length) { if (hit) return hit.v; throw new Error('нет свечей'); }
  const v = { id, iv, src, candles: list };
  cache.set(key, { t: Date.now(), v });
  return v;
}

// Последние 20 свечей актива: [{ t, o, h, l, c }]; параллельные запросы одного и того же склеиваются в один
function candles(id, iv) {
  const key = 'c:' + id + iv, hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_Q) return Promise.resolve(hit.v);
  if (cJobs.has(key)) return cJobs.get(key);
  const job = loadCandles(id, iv, key, hit).finally(() => cJobs.delete(key));
  cJobs.set(key, job);
  return job;
}

// Для фронтенда: те же свечи, плюс поля time / open / high / low / close
const pubCandles = v => Object.assign({}, v, { candles: v.candles.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, time: c.t, open: c.o, high: c.h, low: c.l, close: c.c })) });

const dp = p => p >= 10000 ? 1 : p >= 100 ? 2 : p >= 10 ? 3 : 5;       // знаков после запятой по масштабу цены
const rnd = (v, p) => v == null ? null : +v.toFixed(dp(p));

// Сводка по ВСЕМ 20 свечам: коридор, наклон тренда, положение цены, пробой или отскок.
// Цвет или форма одной последней свечи в выводах не участвуют.
function candleStats(cs, price) {
  if (!cs || cs.length < 8) return null;
  const n = cs.length, prev = cs.slice(0, -1), r = v => rnd(v, price);
  const hi = Math.max(...cs.map(c => c.h)), lo = Math.min(...cs.map(c => c.l)), rg = hi - lo;
  const pHi = Math.max(...prev.map(c => c.h)), pLo = Math.min(...prev.map(c => c.l));             // коридор без текущей (формирующейся) свечи
  const a = avg(cs.map(c => c.h - c.l)) || rg / n || price * .001;
  const pos = rg ? clamp((price - lo) / rg * 100, 0, 100) : 50, zone = pos >= 75 ? 'upper' : pos <= 25 ? 'lower' : 'middle';
  // общий наклон: линейная регрессия по ценам закрытия всех 20 свечей
  const ys = cs.map(c => c.c), mx = (n - 1) / 2, my = avg(ys);
  let sxy = 0, sxx = 0, syy = 0;
  ys.forEach((y, i) => { sxy += (i - mx) * (y - my); sxx += (i - mx) ** 2; syy += (y - my) ** 2; });
  const slope = sxx ? sxy / sxx : 0, r2 = sxx && syy ? sxy * sxy / (sxx * syy) : 0, move = slope * (n - 1);
  const trend = r2 >= .4 && rg && Math.abs(move) >= .45 * rg ? (move > 0 ? 'вверх' : 'вниз') : 'боковой';
  const lastIdx = f => { for (let i = n - 1; i >= 0; i--) if (f(cs[i])) return i; return -1; };
  const iLo = lastIdx(c => c.l === lo), iHi = lastIdx(c => c.h === hi);                          // где в последний раз был экстремум коридора
  let setup, bias = 0, w = 0;
  if (price > pHi + .1 * a) { setup = 'пробой вверх: цена выше максимума предыдущих 19 свечей'; bias = 1; w = 1; }
  else if (price < pLo - .1 * a) { setup = 'пробой вниз: цена ниже минимума предыдущих 19 свечей'; bias = -1; w = 1; }
  else if (zone === 'lower' && trend !== 'вниз' && iLo >= n - 6 && price - lo >= .5 * a) { setup = 'отскок вверх от нижней границы коридора'; bias = 1; w = .8; }
  else if (zone === 'upper' && trend !== 'вверх' && iHi >= n - 6 && hi - price >= .5 * a) { setup = 'отскок вниз от верхней границы коридора'; bias = -1; w = .8; }
  else if (zone === 'upper' && trend === 'вверх') { setup = 'восходящий тренд 20 свечей, цена у верхней границы коридора'; bias = 1; w = .6; }
  else if (zone === 'lower' && trend === 'вниз') { setup = 'нисходящий тренд 20 свечей, цена у нижней границы коридора'; bias = -1; w = .6; }
  else if (zone === 'middle') setup = 'середина коридора: пробоя и отскока нет';
  else setup = zone === 'upper' ? 'у верхней границы коридора, пробоя и подтверждённого тренда нет' : 'у нижней границы коридора, пробоя и подтверждённого тренда нет';
  const last5 = cs.slice(-5);
  return {
    timeframe: AI_IV,
    ohlc: cs.map(c => [r(c.o), r(c.h), r(c.l), r(c.c)]),       // [open, high, low, close], от старых свечей к новым
    hi20: r(hi), lo20: r(lo), range20: r(rg), hi_prev19: r(pHi), lo_prev19: r(pLo),
    price_pos_in_range_pct: Math.round(pos),                   // 0 = цена у минимума 20 свечей, 100 = у максимума
    position: zone === 'upper' ? 'у верхней границы коридора' : zone === 'lower' ? 'у нижней границы коридора' : 'в середине коридора',
    trend20: trend, trend20_pct: +((cs[n - 1].c / cs[0].o - 1) * 100).toFixed(3), trend_r2: +r2.toFixed(2),
    bull_candles_of_20: cs.filter(c => c.c > c.o).length, bear_candles_of_20: cs.filter(c => c.c < c.o).length,
    hi5: r(Math.max(...last5.map(c => c.h))), lo5: r(Math.min(...last5.map(c => c.l))),
    avg_candle_range: r(a),
    setup, structure_bias: bias > 0 ? 'вверх' : bias < 0 ? 'вниз' : 'нейтрально', bias, bias_weight: w
  };
}

/* ===================== Новости ===================== */
// Основной источник FinancialJuice, при сбое по очереди пробуем резервные
const FEEDS = [
  ['FinancialJuice', 'https://www.financialjuice.com/feed.ashx?xy=rss'],
  ['Investing.com', 'https://www.investing.com/rss/news.rss'],
  ['ForexLive', 'https://www.forexlive.com/feed']
];
const TAGS = [
  ['DXY', /\b(dollar|dxy|usd index|greenback|fed\b|fomc|powell|treasur|yields?|payrolls?|nfp|cpi|pce|inflation|jobless)/i],
  ['EUR/USD', /\b(euro\b|eur\/usd|eurusd|ecb|lagarde|eurozone|bund)/i],
  ['XAU/USD', /\b(gold|xau|bullion|safe.haven)/i],
  ['BRENT', /\b(oil|brent|crude|opec|wti|barrel|refiner|saudi)/i],
  ['BTC/USD', /\b(bitcoin|btc|crypto|ethereum|stablecoin|coinbase|binance)/i]
];
let news = { items: [], src: null, t: 0, err: null };

const decode = x => x.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function parseRss(xml, src) {
  const out = [], re = /<(item|entry)[\s>][\s\S]*?<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const b = m[0];
    const g = tag => { const x = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i').exec(b); return x ? decode(x[1]) : ''; };
    const title = g('title').replace(/^FinancialJuice:\s*/i, '');
    if (!title) continue;
    let link = g('link'); if (!link) { const h = /<link[^>]*href=["']([^"']+)["']/i.exec(b); link = h ? h[1] : ''; }
    const d = Date.parse(g('pubDate') || g('published') || g('updated') || g('dc:date'));
    out.push({ title, link: /^https:\/\//.test(link) ? link : '', ts: isNaN(d) ? Date.now() : d, src, tags: TAGS.filter(t => t[1].test(title)).map(t => t[0]).slice(0, 3) });
  }
  return out;
}

async function refreshNews() {
  let err = null;
  for (const [name, url] of FEEDS) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VerdeBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml, */*' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const items = parseRss(await r.text(), name);
      if (!items.length) throw new Error('пустая лента');
      const seen = new Set();
      news = { items: items.filter(i => !seen.has(i.title) && seen.add(i.title)).sort((a, b) => b.ts - a.ts).slice(0, 15), src: name, t: Date.now(), err: null };
      return;
    } catch (e) { err = name + ': ' + e.message; }
  }
  news.err = err;   // все источники недоступны: оставляем последние удачные заголовки
}
refreshNews(); setInterval(refreshNews, 60000);

/* ===================== Сигналы: новости + свечи ===================== */
const CORE = ['dxy', 'eurusd', 'xau', 'brent', 'btc'];
const CORE_IDX = { dxy: 0, eurusd: 1, xau: 2, brent: 3, btc: 4 };
const TN = { dxy: 'DXY', eurusd: 'EUR/USD', gbpusd: 'GBP/USD', usdjpy: 'USD/JPY', usdchf: 'USD/CHF', audusd: 'AUD/USD', xau: 'XAU/USD', xag: 'XAG/USD', brent: 'BRENT', wti: 'WTI', ng: 'NG', spx: 'S&P 500', ndx: 'NASDAQ 100', dax: 'DAX', btc: 'BTC/USD', eth: 'ETH/USD' };
const PROXY = { gbpusd: 'eurusd', audusd: 'eurusd', usdjpy: 'dxy', usdchf: 'dxy', wti: 'brent', xag: 'xau', eth: 'btc', spx: 'btc', ndx: 'btc', dax: 'btc', ng: 'brent' };
// Темы новостей и их эффект на [DXY, EUR/USD, XAU, BRENT, BTC], от −1 до +1
const THEMES = [
  [/\b(hike|hawkish|higher for longer|hot (cpi|inflation)|strong (jobs|payrolls|nfp)|yields? (rise|jump|surge)|inflation (rises?|accelerat))/i, 'ястребиная политика или сильная макростатистика США', [1, -1, -1, -.2, -.7]],
  [/\b(rate cuts?|dovish|cuts? rates?|weak (jobs|payrolls|nfp)|inflation (cools?|eases?|slows?|falls?)|yields? (fall|drop|slump)|unemployment (rises?|jumps?))/i, 'смягчение политики или слабая макростатистика США', [-1, 1, 1, .2, .7]],
  [/\b(war|attack|strike[sd]?|missile|escalat|tensions?|sanctions?|geopolitic|conflict|invasion|terror)/i, 'рост геополитической напряжённости', [.5, -.4, 1, .7, -.5]],
  [/\b(ceasefire|peace|de-?escalat|truce|stimulus|risk[- ]on|rally|record high)/i, 'снижение напряжённости, аппетит к риску', [-.3, .2, -.3, -.2, .6]],
  [/\b(opec\+? (cut|cuts|curb)|output cuts?|supply (cut|disruption|outage)|inventor(y|ies) (draw|fell|drop)|crude draw|pipeline (outage|attack))/i, 'сокращение предложения нефти', [0, 0, 0, 1, 0]],
  [/\b(opec\+? (hike|raise|boost|increase)|oversupply|inventor(y|ies) (build|rose|rise)|crude build|demand (weak|fears|slump)|output (rise|increase))/i, 'избыток предложения или слабый спрос на нефть', [0, 0, 0, -1, 0]],
  [/\b(strait of hormuz|red sea|houthi|middle east|iran|libya|iraq)\b/i, 'Ближний Восток: риск перебоев поставок нефти', [.1, -.1, .4, .6, -.3]],
  [/\b(ecb (hike|hawkish)|lagarde (hawkish|hike)|eurozone (inflation (rises|jumps)|growth (beats|accelerat)))/i, 'ястребиная позиция ЕЦБ', [-.5, 1, -.1, 0, 0]],
  [/\b(ecb (cut|dovish)|lagarde (dovish|cut)|eurozone (recession|contraction|slump)|german (recession|contraction))/i, 'мягкая позиция ЕЦБ или слабая экономика еврозоны', [.5, -1, .1, 0, 0]],
  [/\b(etf (inflows?|approval|approved)|bitcoin (surge|rally|record|adoption)|crypto (rally|inflows?)|institutional (buying|adoption))/i, 'позитив для криптовалют', [0, 0, 0, 0, 1]],
  [/\b(spot (bitcoin|ether|eth) etf|bitcoin etf|strategic bitcoin reserve|microstrategy|strategy (buys|bought|purchas))/i, 'крупные фонды и ETF наращивают позиции в BTC', [0, 0, 0, 0, .6]],
  [/\b(hack(ed)?|exploit|crypto ban|lawsuit|etf outflows?|bitcoin (plunge|crash|slump)|crypto (selloff|outflows?|crackdown))/i, 'негатив для криптовалют', [0, 0, 0, 0, -1]],
  [/\b(central banks? (buy|buying|purchas)|gold (record|surge|rally|jump)|safe.haven (demand|buying))/i, 'спрос на золото', [0, 0, 1, 0, 0]],
  [/\b(gold (slump|falls?|drops?|selloff|plunge))/i, 'давление на золото', [0, 0, -1, 0, 0]]
];
const sg2 = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2).replace('.', ',') + '%';

function newsScore(id) {
  const idx = CORE_IDX[PROXY[id] || id];
  if (idx == null) return { v: 0, drivers: [] };
  let sum = 0; const hits = {};
  for (const it of news.items) {
    const w = Math.pow(.5, Math.max(0, Date.now() - it.ts) / 5400000);       // свежесть: полураспад 90 минут
    for (const [re, label, eff] of THEMES) if (eff[idx] && re.test(it.title)) { sum += w * eff[idx]; hits[label] = (hits[label] || 0) + w * eff[idx]; }
  }
  const drivers = Object.entries(hits).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2).map(([l, v]) => l + (v > 0 ? ' (в пользу роста)' : ' (в пользу падения)'));
  return { v: Math.tanh(sum / 1.5), drivers };
}

async function corrOf(a, b) {   // корреляция доходностей за 24 часа (15-минутные свечи)
  try {
    const [x, y] = await Promise.all([history(a, '15m'), history(b, '15m')]), m = new Map(y.points), xa = [], ya = [];
    x.points.forEach(p => { if (m.has(p[0])) { xa.push(p[1]); ya.push(m.get(p[0])); } });
    if (xa.length < 12) return null;
    const rt = c => c.slice(1).map((v, i) => v / c[i] - 1), r1 = rt(xa), r2 = rt(ya), mx = avg(r1), my = avg(r2);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < r1.length; i++) { sxy += (r1[i] - mx) * (r2[i] - my); sxx += (r1[i] - mx) ** 2; syy += (r2[i] - my) ** 2; }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  } catch (e) { return null; }
}

const statusOf = t => t >= .2 ? 'ПОКУПАТЬ' : t <= -.2 ? 'ПРОДАВАТЬ' : 'ЖДАТЬ';

// Общий контроль для ИИ и запасного анализатора: ПОКУПАТЬ / ПРОДАВАТЬ допустимы только если структура 20 свечей
// подтверждает сторону (пробой, отскок, тренд у границы) или есть сильная новость в ту же сторону.
// В середине коридора без сильной новости остаётся только ЖДАТЬ. Возвращает причину отказа или null.
const STRONG_NEWS = .4;   // оценка новостей newsScore по модулю, начиная с которой новость считается сильной
function gateNote(side, cs, nv) {
  if (!side) return null;
  if (side * (nv || 0) >= STRONG_NEWS) return null;
  if (cs && cs.bias === side) return null;
  if (!cs) return 'свечи недоступны, структура не подтверждена, сильной новости нет';
  if (cs.bias === 0) return cs.price_pos_in_range_pct > 25 && cs.price_pos_in_range_pct < 75
    ? 'цена в середине коридора 20 свечей без пробоя и отскока, сильной новости нет'
    : 'цена у границы коридора 20 свечей, но пробоя и отскока нет, сильной новости нет';
  return 'структура 20 свечей идёт против такого сигнала, сильной новости в его пользу нет';
}

// Уровни по структуре 20 свечей (запасной анализатор): стоп за экстремумом последних 5 свечей с запасом от среднего размаха,
// тейк 1 у границы коридора или на расстоянии 1,5 риска, тейк 2 дальше. Цвет последней свечи не используется.
function candleLevels(cs, side, price) {
  if (!side || !cs || cs.length < 8 || !(price > 0)) return null;
  const hi = Math.max(...cs.map(c => c.h)), lo = Math.min(...cs.map(c => c.l)), a = avg(cs.map(c => c.h - c.l)) || price * .001, l5 = cs.slice(-5);
  const e = price, sl = side > 0 ? Math.min(Math.min(...l5.map(c => c.l)), e - 1.2 * a) - .4 * a : Math.max(Math.max(...l5.map(c => c.h)), e + 1.2 * a) + .4 * a;
  const R = Math.abs(e - sl), t1 = side > 0 ? Math.max(hi, e + 1.5 * R) : Math.min(lo, e - 1.5 * R), t2 = t1 + side * Math.max(R, .5 * Math.abs(t1 - e));
  return parseLevels({ entry: e, stop: sl, tp1: t1, tp2: t2 }, side, { price, avg: a });
}

/* ----- Запасной анализатор: индивидуальная логика по каждому активу ----- */
// Веса: s = структура 20 свечей актива, n = новости актива, m = макро-фон (см. macroOf)
const PROFILE = {
  dxy: { s: .5, n: .5, m: 0 },        // 20 свечей DXY + доходности США, рынок труда, риторика ФРС
  eurusd: { s: .4, n: .3, m: .3 },    // 20 свечей пары + обратная корреляция с DXY + новости США и еврозоны (ФРС, ЕЦБ, инфляция)
  xau: { s: .35, n: .35, m: .3 },     // 20 свечей золота + защитный спрос (геополитика, ставки) + ослабление DXY
  brent: { s: .4, n: .5, m: .1 },     // 20 свечей нефти + ОПЕК+, запасы, Ближний Восток, перебои поставок
  btc: { s: .4, n: .35, m: .25 }      // 20 свечей BTC + крипто-новости (ETF, регуляторы, фонды) + аппетит к риску
};
const structScore = cs => cs ? cs.bias * cs.bias_weight : 0;
const eff = v => v > .05 ? 'в пользу роста' : v < -.05 ? 'в пользу падения' : 'нейтрально';

async function macroOf(pid, id, snap) {   // макро-фон по структуре свечей других активов: { v: от −1 до +1, txt }
  const dx = id !== 'dxy' && snap.dxy && snap.dxy.cs ? structScore(snap.dxy.cs) : null;
  const dxTxt = dx == null ? 'структура DXY не оценена' : dx > 0 ? 'DXY усиливается на 20 свечах' : dx < 0 ? 'DXY слабеет на 20 свечах' : 'DXY в боковике на 20 свечах';
  const k = async def => { const c = await corrOf(id, 'dxy'); return c != null && Math.abs(c) > .3 ? c : def; };
  if (pid === 'eurusd') {
    if (dx == null) return { v: 0, txt: 'Связь с DXY не оценена.' };
    const c = await k(-.8), v = clamp(c * dx, -1, 1);
    return { v, txt: `Обратная корреляция с DXY (${fn(c.toFixed(2))}): ${dxTxt}, влияние на пару ${eff(v)}.` };
  }
  if (pid === 'xau') {
    if (dx == null) return { v: 0, txt: 'Долларовый фон не оценён, защитный спрос учтён по новостям.' };
    const c = await k(-.6), v = clamp(c * dx, -1, 1);
    return { v, txt: `Защитный спрос и долларовый фон: ${dxTxt}, влияние на золото ${eff(v)}.` };
  }
  if (pid === 'brent') {
    if (dx == null) return { v: 0, txt: 'Долларовый фон не оценён.' };
    const c = await k(-.3), v = clamp(c * dx, -1, 1);
    return { v, txt: `Долларовый фон слабо влияет на нефть: ${dxTxt}, ${eff(v)}.` };
  }
  if (pid === 'btc') {
    const rs = id !== 'spx' && snap.spx && snap.spx.cs ? structScore(snap.spx.cs) : null;
    if (rs != null) return { v: rs, txt: `Аппетит к риску по S&P 500 (20 свечей): ${eff(rs)}.` };
    if (dx != null) return { v: -.5 * dx, txt: `Аппетит к риску по долларовому фону (${dxTxt}): ${eff(-.5 * dx)}.` };
    return { v: 0, txt: 'Аппетит к риску не оценён.' };
  }
  return { v: 0, txt: 'Доходности США, рынок труда и риторика ФРС учтены в новостях.' };
}

// Встроенный анализатор: структура 20 свечей + новости + макро-фон со своими весами для каждого актива
async function localSignal(id, snap) {
  const q = snap[id], pid = PROXY[id] || id, pf = PROFILE[pid] || PROFILE.dxy, cs = q.cs || null, ns = newsScore(id), hasNews = news.items.length > 0;
  const mac = await macroOf(pid, id, snap), S = structScore(cs);
  const total = hasNews ? pf.s * S + pf.n * ns.v + pf.m * mac.v : (pf.s * S + pf.m * mac.v) / ((pf.s + pf.m) || 1);
  let status = statusOf(total), side = status === 'ПОКУПАТЬ' ? 1 : status === 'ПРОДАВАТЬ' ? -1 : 0;
  const g = gateNote(side, cs, ns.v);
  if (g) { status = 'ЖДАТЬ'; side = 0; }
  const conf = Math.round(Math.min(92, 35 + Math.abs(total) * 110)), confidence = status === 'ЖДАТЬ' ? Math.min(conf, 50) : conf;
  const cTxt = cs
    ? `${TN[id]}, 20 свечей ${AI_IV}: коридор ${fn(cs.lo20)}–${fn(cs.hi20)}, цена ${cs.position} (${cs.price_pos_in_range_pct}% диапазона), тренд ${cs.trend20} (${sg2(cs.trend20_pct)}); ${cs.setup}.`
    : `${TN[id]}: свечи недоступны, структура не оценена.`;
  const nTxt = hasNews ? (ns.drivers.length ? 'Новости: ' + ns.drivers.join('; ') + '.' : 'В свежих новостях нет явных драйверов.') : 'Лента новостей недоступна.';
  const tail = g ? `Проверка: ${g}, поэтому ЖДАТЬ.` : status === 'ЖДАТЬ' ? 'Факторы слабые или противоречат друг другу.' : 'Структура свечей, новости и фон поддерживают сигнал.';
  return { status, confidence, reason: `${cTxt} ${nTxt} ${mac.txt} ${tail}`, levels: candleLevels(q.candles, side, q.price) };
}

// ===== ИИ-анализ: один пакетный запрос на все 5 активов + умный кэш =====
const AI_TTL = 15 * 60 * 1000;          // результат ИИ живёт 15 минут (поставьте 30 * 60 * 1000, чтобы уложиться в 50 запросов в сутки)
const AI_MIN_GAP = 3 * 60 * 1000;       // досрочное обновление по новой новости не чаще раза в 3 минуты
const AI_MAX_AGE = 60 * 60 * 1000;      // если обновить не удаётся, старый результат ИИ годен не дольше часа
const AI_BACKOFF = 5 * 60 * 1000;       // после неудачи ИИ не дёргаем 5 минут
const AI_DAILY_MAX = 45;                // запас под лимит OpenRouter (50 запросов в сутки), считаются и запросы к запасным моделям
// openrouter/free сам выбирает свободную рабочую модель; остальные: запасные
const MODELS = ['openrouter/free', 'qwen/qwen3-next-80b-a3b-instruct:free', 'nvidia/nemotron-3-nano-30b-a3b:free'];
const ALIAS = { dxy: ['dxy'], eurusd: ['eurusd', 'eur/usd'], xau: ['xau', 'xauusd', 'xau/usd', 'gold'], brent: ['brent'], btc: ['btc', 'btcusd', 'btc/usd'] };
const AI_FILE = path.join(__dirname, 'ai-cache.json');   // кэш переживает перезапуск сервера

const AI_VER = 3;                       // версия формата кэша: результаты со старой сводкой свечей отбрасываются
let ai = { t: 0, v: null, source: null, model: null, err: null, seen: new Set(), tryT: 0, backoff: 0, ver: AI_VER };
let usage = { day: '', n: 0 }, aiJob = null;
try { const d = JSON.parse(fs.readFileSync(AI_FILE, 'utf8')); ai = Object.assign(ai, d.ai, { seen: new Set(d.ai.seen || []) }); usage = d.usage || usage; if (ai.ver !== AI_VER) { ai.v = null; ai.t = 0; ai.ver = AI_VER; } } catch (e) { /* кэша нет */ }
function saveAi() { try { fs.writeFileSync(AI_FILE, JSON.stringify({ ai: Object.assign({}, ai, { seen: [...ai.seen] }), usage })); } catch (e) { /* не критично */ } }
function budgetLeft() { const day = new Date().toISOString().slice(0, 10); if (usage.day !== day) usage = { day, n: 0 }; return AI_DAILY_MAX - usage.n; }

const SYSTEM_PROMPT = [
  'Ты аналитик рынков. Проанализируй сразу пять активов: dxy (индекс доллара), eurusd (EUR/USD), xau (золото XAU/USD), brent (нефть Brent), btc (BTC/USD). Для КАЖДОГО дай краткосрочный (на несколько часов) сигнал о направлении цены самого актива.',
  'Данные: по каждому активу переданы котировка (price, change_day_pct, open) и блок candles, то есть сводка по последним 20 настоящим японским свечам (последняя ещё формируется). Поля: ohlc (массивы [open, high, low, close] от старых свечей к новым), timeframe, hi20 и lo20 (границы коридора за 20 свечей), hi_prev19 и lo_prev19 (границы коридора без текущей свечи), price_pos_in_range_pct (положение цены в коридоре: 0 у минимума, 100 у максимума), position (у верхней границы, у нижней границы или в середине коридора), trend20 (общий наклон тренда за 20 свечей: вверх, вниз или боковой), trend20_pct и trend_r2 (ход за 20 свечей и чёткость тренда), bull_candles_of_20 и bear_candles_of_20, hi5 и lo5 (экстремумы последних 5 свечей), avg_candle_range (средний размах свечи), setup (есть ли пробой границы, отскок от неё или тренд у границы), structure_bias (в какую сторону структура 20 свечей даёт основание: вверх, вниз или нейтрально). Также переданы заголовки новостей headlines (minutes_ago: давность в минутах).',
  'Главное правило. Решение принимай строго по структуре всех 20 свечей вместе с новостями. ЗАПРЕЩЕНО принимать решение по цвету или форме одной последней свечи (а также двух-трёх последних): одна свеча ничего не доказывает и не может быть причиной сигнала. Сначала определи коридор (lo20 и hi20), положение цены в нём и общий наклон за 20 свечей, затем проверь, есть ли пробой или отскок от границы (setup).',
  'Когда ставить статус. ПОКУПАТЬ или ПРОДАВАТЬ ставь только если выполнено одно из двух: а) structure_bias подтверждает эту сторону (пробой, отскок от границы или тренд у границы) и новости ей не противоречат; б) есть СИЛЬНАЯ свежая новость (давность до 90 минут), прямо относящаяся к активу и направленная в ту же сторону, а структура 20 свечей не идёт жёстко против неё. Если цена болтается в середине коридора (position в середине коридора, structure_bias нейтрально) и сильной новости нет, ОБЯЗАТЕЛЬНО ставь ЖДАТЬ. Если новости противоречивы или несущественны, а структура неясна, тоже ЖДАТЬ. Опирайся только на переданные данные, ничего не выдумывай.',
  'Индивидуальная логика по активам (везде сначала 20 свечей самого актива, затем драйверы). EUR/USD: 20 свечей пары, обратная корреляция с DXY (если у DXY пробой вверх или тренд вверх, это давление на EUR/USD, и наоборот; сверяй со свечами DXY из переданных данных), новости США и еврозоны: ФРС, ЕЦБ, инфляция. XAU/USD (золото): 20 свечей золота и защитный спрос: геополитика, конфликты, ожидания снижения ставок, ослабление DXY (слабый доллар и снижение ставок в пользу золота, сильный доллар и рост доходностей давят на него). BRENT (нефть): 20 свечей нефти, новости по ОПЕК+, запасам нефти, Ближнему Востоку и перебоям поставок (сокращение предложения и перебои поддерживают цену, рост запасов и слабый спрос давят на неё). BTC/USD (биткоин): 20 свечей BTC, крипто-новости (ETF, регуляторы, крупные фонды) и общий аппетит к риску (риск-офф и геополитика давят на BTC, приток в ETF и смягчение регулирования поддерживают). DXY (индекс доллара): 20 свечей DXY, доходности США, рынок труда и риторика ФРС (ястребиная риторика, сильные данные и рост доходностей поддерживают DXY, мягкая риторика и слабый рынок труда давят на него).',
  'Уровни. Вход (entry) около текущей цены или на откате внутри коридора 20 свечей; стоп (stop) за экстремумом последних 3-5 свечей (hi5 и lo5) или за границей коридора hi20 и lo20 с запасом примерно 0,3-0,5 avg_candle_range (для покупки ниже входа, для продажи выше); тейки (tp1, tp2) у ближайших границ коридора 20 свечей или на расстоянии 1,5-3 avg_candle_range, с соотношением риска к прибыли не хуже 1:1,5. Уровни не привязывай к телу или тени одной последней свечи. Для покупки stop < entry < tp1 < tp2, для продажи stop > entry > tp1 > tp2. Все цены в тех же единицах, что и price, числами без символов валют. Если статус ЖДАТЬ, levels равен null.',
  'В поле reason (2-3 коротких предложения на русском языке, до 450 символов) ОБЯЗАТЕЛЬНО укажи, что видно на 20 свечах (положение цены в коридоре, наклон тренда, пробой или отскок), и какая новость или драйвер это подтверждает; если значимых новостей по активу нет, так и скажи (в середине коридора это основание для ЖДАТЬ). Для ПОКУПАТЬ и ПРОДАВАТЬ кратко объясни, на чём основаны стоп и тейки. Не называй цвет последней свечи причиной решения.',
  'Ответь ТОЛЬКО JSON без пояснений и без markdown, с ключами dxy, eurusd, xau, brent, btc. Значение каждого: {"status":"ПОКУПАТЬ"|"ПРОДАВАТЬ"|"ЖДАТЬ","confidence":число от 0 до 100,"levels":{"entry":число,"stop":число,"tp1":число,"tp2":число} или null,"reason":"текст"}.'
].join(' ');

function buildMessages(snap) {
  const quotes = {};
  for (const k of Object.keys(snap)) quotes[k] = { name: TN[k], price: snap[k].price, change_day_pct: +snap[k].pct.toFixed(3), open: snap[k].open, candles: snap[k].cs || 'свечи недоступны' };
  const headlines = news.items.map(i => ({ title: i.title, minutes_ago: Math.round((Date.now() - i.ts) / 60000), tags: i.tags }));
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify({ quotes, headlines }) }
  ];
}

// Контекст проверки ответа ИИ: текущая цена, средний размах свечи, сводка по 20 свечам и оценка новостей по каждому активу
function levelCtx(snap) {
  const o = {};
  for (const k of CORE) { const q = snap[k]; if (q) o[k] = { price: q.price, avg: q.candles && q.candles.length ? avg(q.candles.map(c => c.h - c.l)) : 0, cs: q.cs || null, news: newsScore(k).v }; }
  return o;
}

// Уровни ИИ принимаем только если они логичны: правильный порядок для стороны сделки и разумная дистанция от цены (иначе клиент посчитает уровни по процентам из настроек)
function parseLevels(lv, side, c) {
  if (!side || !lv || typeof lv !== 'object' || !c || !(c.price > 0)) return null;
  const num = k => Number(String(lv[k]).replace(/\s/g, '').replace(',', '.'));
  const e = num('entry'), sl = num('stop'), t1 = num('tp1'), t2 = num('tp2');
  if (![e, sl, t1, t2].every(v => isFinite(v) && v > 0)) return null;
  if (!(side * (e - sl) > 0 && side * (t1 - e) > 0 && side * (t2 - t1) >= 0)) return null;
  const a = c.avg > 0 ? c.avg : c.price * .001, near = Math.max(a * 4, c.price * .003), far = Math.max(a * 12, c.price * .008);
  if (Math.abs(e - c.price) > near || [sl, t1, t2].some(v => Math.abs(v - c.price) > far)) return null;
  const r = v => +v.toFixed(dp(c.price));
  return { entry: r(e), stop: r(sl), tp1: r(t1), tp2: r(t2) };
}

function parseSignal(j, c) {
  const map = { 'ПОКУПАТЬ': 'ПОКУПАТЬ', 'BUY': 'ПОКУПАТЬ', 'ПРОДАВАТЬ': 'ПРОДАВАТЬ', 'SELL': 'ПРОДАВАТЬ', 'ЖДАТЬ': 'ЖДАТЬ', 'WAIT': 'ЖДАТЬ', 'HOLD': 'ЖДАТЬ' };
  const status = map[String(j.status).trim().toUpperCase()], conf = Math.round(Number(j.confidence));
  if (!status || isNaN(conf) || !j.reason) throw new Error('неверный формат');
  const side = status === 'ПОКУПАТЬ' ? 1 : status === 'ПРОДАВАТЬ' ? -1 : 0;
  const g = gateNote(side, c && c.cs, c && c.news);   // страховка: без подтверждения структурой 20 свечей или сильной новости сигнала не будет
  if (g) return { status: 'ЖДАТЬ', confidence: Math.min(clamp(conf, 0, 100), 45), reason: (String(j.reason).slice(0, 540) + ' Проверка сервера: ' + g + ', поэтому ЖДАТЬ.').slice(0, 700), levels: null };
  return { status, confidence: clamp(conf, 0, 100), reason: String(j.reason).slice(0, 700), levels: parseLevels(j.levels, side, c) };
}

function parseBatch(j, ctx) {
  const src = j && typeof j.signals === 'object' && j.signals ? j.signals : j, low = {}, out = {};
  Object.keys(src || {}).forEach(k => { low[k.toLowerCase()] = src[k]; });
  for (const id of CORE) for (const a of ALIAS[id]) {
    if (low[a] && typeof low[a] === 'object') { try { out[id] = parseSignal(low[a], ctx && ctx[id]); break; } catch (e) { /* пробуем другой ключ */ } }
  }
  if (!Object.keys(out).length) throw new Error('в ответе нет ни одного актива');
  return out;
}

// Достаём JSON из текста ответа (модель могла добавить пояснения или ```json)
function extractBatch(text, ctx) {
  const t = String(text || ''), cands = [], g = t.match(/\{[\s\S]*\}/);
  if (g) cands.push(g[0]);
  for (let i = t.indexOf('{'); i !== -1 && cands.length < 20; i = t.indexOf('{', i + 1)) {   // запасной вариант: сбалансированные блоки {...}
    let d = 0, str = false, esc = false;
    for (let k = i; k < t.length; k++) {
      const c = t[k];
      if (str) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') str = false; continue; }
      if (c === '"') str = true; else if (c === '{') d++; else if (c === '}' && --d === 0) { cands.push(t.slice(i, k + 1)); break; }
    }
  }
  for (const c of cands) { try { return parseBatch(JSON.parse(c), ctx); } catch (e) { /* следующий кандидат */ } }
  throw new Error('JSON не найден в ответе: ' + t.slice(0, 120));
}

// Один запрос анализирует все 5 активов и возвращает { dxy: {...}, eurusd: {...}, xau: {...}, brent: {...}, btc: {...} }
async function askOpenRouter(snap) {
  const messages = buildMessages(snap), ctx = levelCtx(snap), errs = [], t0 = Date.now();
  for (const model of MODELS) {
    if (budgetLeft() <= 0) { errs.push('исчерпан дневной лимит запросов (' + AI_DAILY_MAX + ')'); break; }
    if (Date.now() - t0 > 60000) { errs.push('превышено общее время ожидания'); break; }
    try {
      usage.n++; saveAi();
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Verde' },
        body: JSON.stringify({ model, messages, temperature: .2, max_tokens: 2500, reasoning: { max_tokens: 300 } }),   // reasoning ограничен, чтобы thinking-модель не съела весь лимит до JSON; без response_format: часть бесплатных моделей отвечает на него ошибкой 400
        signal: AbortSignal.timeout(35000)   // промпт со свечами больше прежнего, ответ длиннее (уровни), поэтому таймаут увеличен
      });
      const raw = await r.text();
      let j = null; try { j = JSON.parse(raw); } catch (e) { /* не JSON */ }
      if (!r.ok || (j && j.error)) throw new Error('HTTP ' + r.status + ' ' + String((j && j.error && (j.error.message || JSON.stringify(j.error))) || raw).slice(0, 300));
      const m = j && j.choices && j.choices[0] && j.choices[0].message;
      return { map: extractBatch(m && (m.content || m.reasoning), ctx), model: (j && j.model) || model };
    } catch (e) { errs.push(model + ': ' + e.message); }
  }
  throw new Error(errs.join(' | ').slice(0, 800));
}

async function askGroq(snap) {   // запасной ИИ, если задан GROQ_API_KEY
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: .2, max_tokens: 1800, response_format: { type: 'json_object' }, messages: buildMessages(snap) }),
    signal: AbortSignal.timeout(30000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return { map: extractBatch((await r.json()).choices[0].message.content, levelCtx(snap)), model: 'llama-3.3-70b-versatile' };
}

// Какие активы нужны для анализа id: сам актив, пятёрка основных и (для крипто и индексов) S&P 500 как мерило аппетита к риску
const needs = id => [...new Set([id, ...CORE, ...((PROXY[id] || id) === 'btc' && id !== 'spx' ? ['spx'] : [])])];

async function snapshot(id, withCandles) {
  const out = {};
  await Promise.all(needs(id).map(async i => {
    try { out[i] = await quote(i); } catch (e) { return; /* нет котировки */ }
    if (withCandles) {
      try {
        const v = await candles(i, AI_IV), c = v.candles;
        out[i].candles = c;
        if (v.src === 'binance') out[i].price = c[c.length - 1].c;   // цена и свечи BTC из одного источника, чтобы положение в коридоре и уровни были согласованы
        out[i].cs = candleStats(c, out[i].price);
      } catch (e) { /* свечей нет: анализ получит только котировку */ }
    }
  }));
  return out;
}

async function runAi() {
  const snap = await snapshot('dxy', true), errs = [];   // с 20 свечами по каждому активу
  ai.tryT = Date.now();
  let res = null;
  if (process.env.OPENROUTER_API_KEY) { try { res = await askOpenRouter(snap); res.source = 'openrouter'; } catch (e) { errs.push('OpenRouter: ' + e.message); } }
  if (!res && process.env.GROQ_API_KEY) { try { res = await askGroq(snap); res.source = 'groq'; } catch (e) { errs.push('Groq: ' + e.message); } }
  if (res) { ai.v = res.map; ai.model = res.model; ai.source = res.source; ai.t = Date.now(); ai.seen = new Set(news.items.map(i => i.title)); }
  else ai.backoff = Date.now() + AI_BACKOFF;
  ai.err = errs.length ? errs.join(' | ').slice(0, 900) : null;
  if (ai.err) console.warn('ИИ:', ai.err);
  saveAi();
}

// Обновляем ИИ только если кэш старше 15 минут или в ленте FinancialJuice появился новый заголовок
async function aiBatch() {
  const now = Date.now();
  if (!process.env.OPENROUTER_API_KEY && !process.env.GROQ_API_KEY) { ai.err = 'ключ ИИ не задан (OPENROUTER_API_KEY)'; return ai; }
  const fresh = ai.v && now - ai.t < AI_TTL;
  const newNews = news.src === 'FinancialJuice' && news.items.some(i => !ai.seen.has(i.title));
  const due = !fresh || (newNews && now - ai.tryT >= AI_MIN_GAP);
  if (due && now >= ai.backoff && !aiJob) aiJob = runAi().finally(() => { aiJob = null; });
  if (aiJob && !(ai.v && now - ai.t < AI_MAX_AGE)) await aiJob;   // старого результата нет: ждём; иначе обновляем в фоне
  return ai;
}

const sigCache = new Map(), sigJobs = new Map();
async function signal(id) {
  const st = CORE.includes(id) ? await aiBatch() : ai, base = { news: { src: news.src, updated: news.t, count: news.items.length, error: news.err }, aiError: st.err, t: Date.now() };
  if (CORE.includes(id) && st.v && st.v[id] && Date.now() - st.t < AI_MAX_AGE) {
    const r = st.v[id];
    return Object.assign({ id, status: r.status, side: r.status === 'ПОКУПАТЬ' ? 1 : r.status === 'ПРОДАВАТЬ' ? -1 : 0, confidence: r.confidence, reason: r.reason, levels: r.levels || null, candlesIv: AI_IV, source: st.source, model: st.model, aiUpdated: st.t }, base);
  }
  const hit = sigCache.get(id);                       // запасной путь: встроенный анализатор по 20 свечам
  if (hit && Date.now() - hit.t < 60000) return Object.assign({}, hit.v, { aiError: st.err });
  if (sigJobs.has(id)) return sigJobs.get(id);
  const job = (async () => {
    const snap = await snapshot(id, true);
    if (!snap[id]) throw new Error('нет котировки ' + id);
    const r = await localSignal(id, snap);
    const v = Object.assign({ id, status: r.status, side: r.status === 'ПОКУПАТЬ' ? 1 : r.status === 'ПРОДАВАТЬ' ? -1 : 0, confidence: r.confidence, reason: r.reason, levels: r.levels || null, candlesIv: AI_IV, source: 'rules', model: null, aiUpdated: st.t || null }, base);
    sigCache.set(id, { t: Date.now(), v });
    return v;
  })().finally(() => sigJobs.delete(id));
  sigJobs.set(id, job);
  return job;
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
    if (u.pathname === '/api/candles') {
      const iv = IV.includes(u.searchParams.get('iv')) ? u.searchParams.get('iv') : '15m';
      const ids = (u.searchParams.get('ids') || u.searchParams.get('id') || '').split(',').filter(i => SYM[i]), out = {};
      await Promise.all(ids.map(async i => { try { out[i] = pubCandles(await candles(i, iv)); } catch (e) { /* пропускаем актив */ } }));
      return send(200, out);
    }
    if (u.pathname === '/api/news') return send(200, { items: news.items, src: news.src, updated: news.t, error: news.err });
    if (u.pathname === '/api/signal') {
      const id = u.searchParams.get('id') || 'eurusd';
      if (!SYM[id]) return send(400, { error: 'unknown id' });
      return send(200, await signal(id));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end();
  } catch (e) { send(502, { error: String(e.message) }); }
}).listen(process.env.PORT || 3000, () => console.log('Открой http://localhost:' + (process.env.PORT || 3000)));
