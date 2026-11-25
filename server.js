// Запуск: node server.js  (нужен Node 18+, зависимости не нужны)
// Открыть: http://localhost:3000
// Сигналы через ИИ: GROQ_API_KEY=ключ node server.js  (без ключа работает встроенный анализатор)
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

/* ===================== НОВОСТИ (RSS) ===================== */
// Основной источник — FinancialJuice, дальше резервные: Investing и ForexLive.
const FEEDS = [
  { name: 'FinancialJuice', url: 'https://www.financialjuice.com/feed.ashx?xy=rss' },
  { name: 'Investing', url: 'https://www.investing.com/rss/news_1.rss' },
  { name: 'ForexLive', url: 'https://www.forexlive.com/feed/news' }
];
const NEWS_N = 15, NEWS_EVERY = 60000;          // 15 заголовков, обновление раз в 60 секунд
let news = { t: 0, source: '', items: [] };

const clean = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
  .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (x, n) => {
  const m = x.match(new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>', 'i'));
  return m ? clean(m[1]) : '';
};

function parseRss(xml, src) {
  const now = Math.floor(Date.now() / 1000);
  return (xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []).map(it => {
    const title = tag(it, 'title').replace(/^FinancialJuice:\s*/i, '');
    const ms = Date.parse(tag(it, 'pubDate') || tag(it, 'dc:date'));
    const t = isNaN(ms) ? now : Math.min(Math.floor(ms / 1000), now);
    return { t, title, link: tag(it, 'link') || tag(it, 'guid'), src };
  }).filter(n => n.title);
}

// Теги активов для Live-ленты (id совпадают с id активов в index.html)
const TAGS = [
  ['dxy', /\b(dollar|usd|dxy|fed|fomc|powell|treasur\w*|yields?|nfp|payrolls?|cpi|pce|ppi|jobless|ism)\b/i],
  ['eurusd', /\b(euro|eur|ecb|lagarde|eurozone|euro zone|euro area|german\w*|bund)\b/i],
  ['xau', /\b(gold|bullion|xau|safe[- ]haven)\b/i],
  ['brent', /\b(oil|brent|crude|opec|wti|barrels?|refiner\w*|hormuz|iran\w*|saudi)\b/i],
  ['btc', /\b(bitcoin|btc|crypto\w*|ethereum|stablecoin\w*)\b/i],
  ['usdjpy', /\b(yen|jpy|boj|japan\w*|ueda)\b/i],
  ['gbpusd', /\b(sterling|gbp|boe|bailey|uk|britain|british)\b/i],
  ['spx', /\b(s&p|nasdaq|dow|wall street|equities|stocks?)\b/i]
];
function tagsOf(title, f) {
  const out = TAGS.filter(x => x[1].test(title)).map(x => x[0]);
  if (f.geo) ['xau', 'brent'].forEach(i => out.includes(i) || out.push(i));
  return out.slice(0, 3);
}

async function pullFeed(f) {
  const r = await fetch(f.url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error(f.name + ' ' + r.status);
  return parseRss(await r.text(), f.name);
}

async function refreshNews() {
  const all = [], used = [];
  for (const f of FEEDS) {
    try { const it = await pullFeed(f); if (it.length) { all.push(...it); used.push(f.name); } }
    catch (e) { /* источник недоступен — идём к резервному */ }
    if (all.length >= NEWS_N) break;
  }
  const seen = new Set(), items = [];
  all.sort((a, b) => b.t - a.t).forEach(n => {
    const k = n.title.toLowerCase().replace(/[^a-z0-9а-я]+/g, '').slice(0, 60);
    if (seen.has(k)) return;
    seen.add(k);
    items.push(Object.assign(n, { tags: tagsOf(n.title, factors(n.title)) }));
  });
  if (items.length) news = { t: Date.now(), source: used.join(' + '), items: items.slice(0, NEWS_N) };
}

/* ===================== АНАЛИЗ НОВОСТЕЙ ===================== */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const KEY = ['dxy', 'eurusd', 'xau', 'brent', 'btc'];           // активы, которые уходят в анализ всегда
const NAME = {
  dxy: 'DXY', eurusd: 'EUR/USD', gbpusd: 'GBP/USD', usdjpy: 'USD/JPY', usdchf: 'USD/CHF', audusd: 'AUD/USD',
  xau: 'XAU/USD', xag: 'XAG/USD', brent: 'BRENT', wti: 'WTI', ng: 'NG', spx: 'S&P 500', ndx: 'NDX', dax: 'DAX',
  btc: 'BTC/USD', eth: 'ETH/USD'
};

// Ключевые слова (английские заголовки) → факторы: usd, eur, oil, geo (напряжённость), risk, btc, xau
const RX = {
  hawk: /hawkish|rate hikes?|raises? (interest )?rates?|higher for longer|hotter|stronger[- ]than[- ]expected|(above|tops?|beats?) (expectations|forecasts?|consensus|estimates)|inflation (rises|rose|accelerates|jumps|picks up)|yields? (rise|rose|jump|surge|climb)|(jobs|payrolls|nfp|retail sales|gdp|pmi|ism) (rise|rose|beat|beats|strong|stronger|above|jump)|jobless claims (fall|fell|drop|lower|below)/,
  dove: /dovish|rate cuts?|cuts? (interest )?rates?|easing|softer|cooler|weaker[- ]than[- ]expected|(below|misses?|missed) (expectations|forecasts?|consensus|estimates)|inflation (falls|fell|cools|slows|eases|drops)|yields? (fall|fell|drop|slide|tumble|plunge)|(jobs|payrolls|nfp|retail sales|gdp|pmi|ism) (fall|fell|miss|misses|weak|weaker|below|contract|slump)|unemployment (rises|rose|jumps|higher)|jobless claims (rise|rose|jump|higher|above)/,
  usUp: /\b(dollar|dxy|greenback)\b.*\b(rises?|rose|gains?|climbs?|jumps?|firm|firmer|higher|strengthens?|surges?)/,
  usDn: /\b(dollar|dxy|greenback)\b.*\b(falls?|fell|slips?|drops?|slides?|weaker|lower|weakens?|retreats?|declines?)/,
  us: /\b(fed|fomc|powell|treasur\w*|nfp|payrolls?|dollar|usd|u\.s\.|us)\b/,
  eu: /\b(ecb|lagarde|eurozone|euro zone|euro area|german\w*|bund|france|italy)\b/,
  ot: /\b(boj|boe|rba|snb|boc|japan\w*|uk|britain|british|australia\w*|swiss|china|chinese|canada|canadian)\b/,
  oilUp: /opec.*(cut|extend|curb)|output cuts?|supply (disruption|cut|outage|loss|risk)|(inventories|stocks|stockpiles) (draw|fall|fell|drop)|crude (draw|inventories fall)|sanctions? (on|against|imposed)|pipeline (attack|outage|blast)|hormuz|refinery (attack|fire|outage)|(attack|strike|drone).*(tanker|oil|refinery|saudi|pipeline)|oil (rises?|rose|jumps?|climbs?|surges?|gains?)|(brent|crude|wti) (rises?|rose|jumps?|climbs?|surges?|gains?|higher)/,
  oilDn: /opec.*(hike|raise|boost|increase|ramp)|output (hike|increase|boost)|(inventories|stocks|stockpiles) (build|rise|rose|jump|surge)|crude (build|inventories rise)|demand (fears?|concerns?|worries|weak\w*|slump|slows?)|oversupply|glut|sanctions? (eased|lifted|relief|waiver)|oil (falls?|fell|drops?|slides?|slumps?|tumbles?|declines?)|(brent|crude|wti) (falls?|fell|drops?|slides?|slumps?|tumbles?|declines?|lower)/,
  esc: /\bwar\b|missile|strikes?\b|attack|escalat|invasion|invade|drone|explosion|retaliat|nuclear|troops|shelling|hostilit|conflict/,
  de: /ceasefire|cease-fire|truce|peace|de-escalat|talks (progress|resume|restart)|deal reached|withdraw/,
  on: /rall(y|ies)|record highs?|(stocks|equities|shares|futures) (rise|rose|jump|gain|surge|climb|higher)|risk[- ]on|soft landing/,
  off: /(stocks|equities|shares|futures) (fall|fell|drop|slide|plunge|tumble|lower)|sell-?off|risk[- ]off|crash|plunge|recession (fears?|risk|warning)|slump/,
  cr: /\b(bitcoin|btc|crypto\w*|ethereum|ether|stablecoin\w*)\b/,
  crUp: /etf (inflows?|approv\w*)|inflows?|adoption|approv\w*|record|surge|rall(y|ies)|jumps?|soars?|gains?|climbs?|reserve/,
  crDn: /hack\w*|exploit|\bbans?\b|crackdown|lawsuit|sues?|outflows?|liquidat\w*|plunge|sell-?off|drops?|falls?|slides?|tumbles?|crash|rejects?/,
  au: /\b(gold|bullion|xau)\b/,
  auUp: /rises?|rose|rall(y|ies)|record|jumps?|gains?|surges?|climbs?|higher|soars?/,
  auDn: /falls?|fell|drops?|slides?|slumps?|lower|retreats?|dips?|declines?|tumbles?/
};

function factors(title) {
  const s = title.toLowerCase(), f = { usd: 0, eur: 0, oil: 0, geo: 0, risk: 0, btc: 0, xau: 0 };
  const pol = (RX.hawk.test(s) ? 1 : 0) - (RX.dove.test(s) ? 1 : 0);   // ястребиный (+) / голубиный (−) фон
  if (RX.usUp.test(s)) f.usd = 1;
  else if (RX.usDn.test(s)) f.usd = -1;
  else if (pol) {
    if (RX.us.test(s)) f.usd = pol;
    else if (RX.eu.test(s)) f.eur = pol;
    else if (!RX.ot.test(s)) f.usd = pol;
  }
  f.oil = (RX.oilUp.test(s) ? 1 : 0) - (RX.oilDn.test(s) ? 1 : 0);
  f.geo = (RX.esc.test(s) ? 1 : 0) - (RX.de.test(s) ? 1 : 0);
  f.risk = (RX.on.test(s) ? 1 : 0) - (RX.off.test(s) ? 1 : 0);
  if (RX.cr.test(s)) f.btc = (RX.crUp.test(s) ? 1 : 0) - (RX.crDn.test(s) ? 1 : 0);
  if (RX.au.test(s)) f.xau = (RX.auUp.test(s) ? 1 : 0) - (RX.auDn.test(s) ? 1 : 0);
  return f;
}

// Чувствительность актива к новостным факторам
const BETA = {
  dxy: { usd: 1 }, eurusd: { usd: -.8, eur: .8, risk: .2 }, gbpusd: { usd: -.7, risk: .4 }, audusd: { usd: -.7, risk: .5 },
  usdjpy: { usd: .7, geo: -.3, risk: .2 }, usdchf: { usd: .7, geo: -.3 },
  xau: { usd: -.6, geo: .5, xau: 1 }, xag: { usd: -.6, geo: .4, xau: .6 },
  brent: { oil: 1, geo: .3, usd: -.2 }, wti: { oil: 1, geo: .3, usd: -.2 }, ng: { oil: .3, geo: .2 },
  spx: { risk: 1, geo: -.5, usd: -.1 }, ndx: { risk: 1, geo: -.5, usd: -.1 }, dax: { risk: 1, geo: -.5, eur: .2 },
  btc: { risk: .5, btc: 1, usd: -.3 }, eth: { risk: .5, btc: 1, usd: -.3 }
};
// Типичное дневное движение, % (для нормировки динамики цены)
const VOL = {
  dxy: .35, eurusd: .4, gbpusd: .45, audusd: .5, usdjpy: .5, usdchf: .45, xau: 1, xag: 1.8, brent: 1.6, wti: 1.6,
  ng: 2.5, spx: .8, ndx: 1, dax: .9, btc: 2.5, eth: 3
};
// Связь актива с дневным движением DXY и Brent (знак — корреляция, модуль — сила)
const MB = {
  dxy: [0, 0], eurusd: [-.8, 0], gbpusd: [-.7, 0], audusd: [-.6, .1], usdjpy: [.6, -.1], usdchf: [.6, 0],
  xau: [-.5, .1], xag: [-.4, .1], brent: [-.2, 0], wti: [-.2, .9], ng: [0, .2],
  spx: [-.2, -.1], ndx: [-.2, -.1], dax: [-.3, -.1], btc: [-.3, 0], eth: [-.3, 0]
};

const f2 = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2).replace('.', ',') + '%';
const short = t => t.length > 110 ? t.slice(0, 107) + '…' : t;
const STATUS = { 1: 'ПОКУПАТЬ', '-1': 'ПРОДАВАТЬ', 0: 'ЖДАТЬ' };

// Резервный анализатор: новости (50%) + динамика цены актива (25%) + DXY и Brent с учётом корреляции (25%)
function rulesSignal(id, qs, items) {
  const b = BETA[id] || {}, raw = {}, rows = [];
  items.forEach((n, i) => {
    const f = factors(n.title), w = Math.pow(.9, i);       // свежие заголовки весят больше
    let c = 0;
    for (const k in f) { raw[k] = (raw[k] || 0) + f[k] * w; c += (b[k] || 0) * f[k] * w; }
    if (c) rows.push({ title: n.title, c });
  });
  let N = 0;
  for (const k in b) N += b[k] * Math.tanh((raw[k] || 0) / 1.5);
  N = clamp(N, -1, 1);
  const pct = i => qs[i] && isFinite(qs[i].pct) ? qs[i].pct : null;
  const P = pct(id) == null ? 0 : clamp(pct(id) / (VOL[id] || 1), -1, 1);
  const mb = MB[id] || [0, 0], dx = pct('dxy'), br = pct('brent');
  const M = clamp(mb[0] * (dx == null ? 0 : clamp(dx / VOL.dxy, -1, 1)) + mb[1] * (br == null ? 0 : clamp(br / VOL.brent, -1, 1)), -1, 1);
  const tot = .5 * N + .25 * P + .25 * M, side = tot >= .2 ? 1 : tot <= -.2 ? -1 : 0;
  const confidence = !items.length && pct(id) == null ? 30
    : side ? Math.round(Math.min(92, 40 + Math.abs(tot) * 110)) : Math.round(45 + (.2 - Math.abs(tot)) / .2 * 25);

  const top = rows.sort((a, b) => Math.abs(b.c) - Math.abs(a.c))[0], nm = NAME[id], parts = [];
  parts.push(top && Math.abs(N) > .1
    ? `Новости ${N > 0 ? 'работают на рост' : 'давят на'} ${nm}: «${short(top.title)}».`
    : `Свежие новости не дают явного перевеса для ${nm}.`);
  const pr = [id, 'dxy', 'brent'].filter((v, i, a) => a.indexOf(v) === i && pct(v) != null).map(v => NAME[v] + ' ' + f2(pct(v)));
  if (pr.length) parts.push('Динамика за день: ' + pr.join(', ') + '.');
  if (Math.abs(M) > .1) parts.push(`Связь с DXY и Brent ${M > 0 ? 'поддерживает' : 'давит на'} актив.`);
  parts.push(side > 0 ? 'Перевес факторов в сторону покупки.' : side < 0 ? 'Перевес факторов в сторону продажи.' : 'Факторы слабые или разнонаправленные — лучше подождать.');
  return { status: STATUS[side], confidence, reason: parts.join(' ') };
}

// ИИ-анализ через Groq
const norm = s => {
  s = String(s || '').toUpperCase();
  return /ПОКУП|BUY|LONG/.test(s) ? 'ПОКУПАТЬ' : /ПРОДА|SELL|SHORT/.test(s) ? 'ПРОДАВАТЬ' : /ЖДА|HOLD|WAIT|NEUTRAL/.test(s) ? 'ЖДАТЬ' : null;
};
async function groqSignal(id, qs, items) {
  const quotes = {};
  Object.keys(qs).forEach(i => { quotes[NAME[i]] = { price: +qs[i].price.toFixed(4), change_pct_day: +qs[i].pct.toFixed(3) }; });
  const now = Date.now() / 1000;
  const body = {
    model: 'llama-3.3-70b-versatile', temperature: .2, max_tokens: 400, response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Ты опытный макроаналитик. По свежим новостным заголовкам и текущей динамике цен определи краткосрочный сигнал по указанному активу. ' +
          'Учитывай связи: рост DXY обычно давит на EUR/USD, золото и BTC; рост Brent поддерживает нефтяные активы и инфляционные ожидания; эскалация конфликтов поддерживает золото и нефть. ' +
          'Свежие заголовки важнее старых. Если фон противоречивый или слабый — ЖДАТЬ. ' +
          'Ответь ТОЛЬКО JSON без пояснений вокруг: {"status":"ПОКУПАТЬ"|"ПРОДАВАТЬ"|"ЖДАТЬ","confidence":число от 0 до 100,"explanation":"2–3 предложения на русском языке с обоснованием"}.'
      },
      {
        role: 'user',
        content: JSON.stringify({
          asset: NAME[id], quotes,
          headlines: items.map(n => ({ minutes_ago: Math.max(0, Math.round((now - n.t) / 60)), text: n.title }))
        })
      }
    ]
  };
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error('groq ' + r.status);
  const o = JSON.parse((await r.json()).choices[0].message.content), status = norm(o.status);
  if (!status || !o.explanation) throw new Error('bad groq answer');
  return { status, confidence: clamp(Math.round(Number(o.confidence)) || 50, 0, 100), reason: String(o.explanation).trim().slice(0, 600) };
}

const SIDE = { 'ПОКУПАТЬ': 1, 'ПРОДАВАТЬ': -1, 'ЖДАТЬ': 0 };
const TTL_S = 60000, sigCache = new Map(), inflight = new Map();

async function signal(id) {
  const hit = sigCache.get(id), now = Date.now();
  if (hit && now - hit.t < TTL_S && hit.n === news.t) return hit.v;
  if (inflight.has(id)) return inflight.get(id);
  const p = (async () => {
    const qs = {};
    await Promise.all(KEY.concat(id).filter((v, i, a) => a.indexOf(v) === i).map(async i => { try { qs[i] = await quote(i); } catch (e) { /* пропускаем актив */ } }));
    if (!qs[id]) throw new Error('no quote');
    const items = news.items;
    let res, source = 'rules';
    if (process.env.GROQ_API_KEY) {
      try { res = await groqSignal(id, qs, items); source = 'groq'; }
      catch (e) { console.warn('Groq недоступен, работает встроенный анализатор:', e.message); }
    }
    if (!res) res = rulesSignal(id, qs, items);
    const v = {
      id, status: res.status, side: SIDE[res.status], confidence: res.confidence, reason: res.reason,
      source, model: source == 'groq' ? 'llama-3.3-70b-versatile' : null,
      t: Math.floor(Date.now() / 1000), news_t: Math.floor(news.t / 1000)
    };
    sigCache.set(id, { t: Date.now(), n: news.t, v });
    return v;
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

refreshNews();
setInterval(refreshNews, NEWS_EVERY);

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
    if (u.pathname === '/api/news') {
      return send(200, { t: Math.floor(news.t / 1000), source: news.source, items: news.items });
    }
    if (u.pathname === '/api/signal') {
      const id = u.searchParams.get('id');
      if (!SYM[id] || id === 'usdrub') return send(400, { error: 'unknown id' });
      return send(200, await signal(id));
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end();
  } catch (e) { send(502, { error: String(e.message) }); }
}).listen(process.env.PORT || 3000, () => console.log('Открой http://localhost:' + (process.env.PORT || 3000) + (process.env.GROQ_API_KEY ? '  (сигналы: Groq)' : '  (сигналы: встроенный анализатор)')));
