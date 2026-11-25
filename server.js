// Запуск: node server.js  (нужен Node 18+, зависимости не нужны)
// Открыть: http://localhost:3000
// Для ИИ-сигналов: OPENROUTER_API_KEY=ваш_ключ node server.js  (или GROQ_API_KEY; без ключа работает встроенный анализатор)
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

/* ===================== Сигналы: новости + цены ===================== */
const CORE = ['dxy', 'eurusd', 'xau', 'brent', 'btc'];
const CORE_IDX = { dxy: 0, eurusd: 1, xau: 2, brent: 3, btc: 4 };
const TN = { dxy: 'DXY', eurusd: 'EUR/USD', gbpusd: 'GBP/USD', usdjpy: 'USD/JPY', usdchf: 'USD/CHF', audusd: 'AUD/USD', xau: 'XAU/USD', xag: 'XAG/USD', brent: 'BRENT', wti: 'WTI', ng: 'NG', spx: 'S&P 500', ndx: 'NASDAQ 100', dax: 'DAX', btc: 'BTC/USD', eth: 'ETH/USD' };
const PROXY = { gbpusd: 'eurusd', audusd: 'eurusd', usdjpy: 'dxy', usdchf: 'dxy', wti: 'brent', xag: 'xau', eth: 'btc', spx: 'btc', ndx: 'btc', dax: 'btc', ng: 'brent' };
const SCALE = { dxy: .4, eurusd: .4, gbpusd: .4, usdjpy: .5, usdchf: .4, audusd: .5, xau: 1, xag: 1.8, brent: 1.5, wti: 1.5, ng: 3, spx: .8, ndx: 1, dax: .8, btc: 2.5, eth: 3 };
// Темы новостей и их эффект на [DXY, EUR/USD, XAU, BRENT, BTC], от −1 до +1
const THEMES = [
  [/\b(hike|hawkish|higher for longer|hot (cpi|inflation)|strong (jobs|payrolls|nfp)|yields? (rise|jump|surge)|inflation (rises?|accelerat))/i, 'ястребиная политика или сильная макростатистика США', [1, -1, -1, -.2, -.7]],
  [/\b(rate cuts?|dovish|cuts? rates?|weak (jobs|payrolls|nfp)|inflation (cools?|eases?|slows?|falls?)|yields? (fall|drop|slump)|unemployment (rises?|jumps?))/i, 'смягчение политики или слабая макростатистика США', [-1, 1, 1, .2, .7]],
  [/\b(war|attack|strike[sd]?|missile|escalat|tensions?|sanctions?|geopolitic|conflict|invasion|terror)/i, 'рост геополитической напряжённости', [.5, -.4, 1, .7, -.5]],
  [/\b(ceasefire|peace|de-?escalat|truce|stimulus|risk[- ]on|rally|record high)/i, 'снижение напряжённости, аппетит к риску', [-.3, .2, -.3, -.2, .6]],
  [/\b(opec\+? (cut|cuts|curb)|output cuts?|supply (cut|disruption|outage)|inventor(y|ies) (draw|fell|drop)|crude draw|pipeline (outage|attack))/i, 'сокращение предложения нефти', [0, 0, 0, 1, 0]],
  [/\b(opec\+? (hike|raise|boost|increase)|oversupply|inventor(y|ies) (build|rose|rise)|crude build|demand (weak|fears|slump)|output (rise|increase))/i, 'избыток предложения или слабый спрос на нефть', [0, 0, 0, -1, 0]],
  [/\b(ecb (hike|hawkish)|lagarde (hawkish|hike)|eurozone (inflation (rises|jumps)|growth (beats|accelerat)))/i, 'ястребиная позиция ЕЦБ', [-.5, 1, -.1, 0, 0]],
  [/\b(ecb (cut|dovish)|lagarde (dovish|cut)|eurozone (recession|contraction|slump)|german (recession|contraction))/i, 'мягкая позиция ЕЦБ или слабая экономика еврозоны', [.5, -1, .1, 0, 0]],
  [/\b(etf (inflows?|approval|approved)|bitcoin (surge|rally|record|adoption)|crypto (rally|inflows?)|institutional (buying|adoption))/i, 'позитив для криптовалют', [0, 0, 0, 0, 1]],
  [/\b(hack(ed)?|exploit|crypto ban|lawsuit|etf outflows?|bitcoin (plunge|crash|slump)|crypto (selloff|outflows?|crackdown))/i, 'негатив для криптовалют', [0, 0, 0, 0, -1]],
  [/\b(central banks? (buy|buying|purchas)|gold (record|surge|rally|jump)|safe.haven (demand|buying))/i, 'спрос на золото', [0, 0, 1, 0, 0]],
  [/\b(gold (slump|falls?|drops?|selloff|plunge))/i, 'давление на золото', [0, 0, -1, 0, 0]]
];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
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

// Встроенный анализатор: ключевые слова новостей + динамика цены + корреляция с DXY и Brent
async function localSignal(id, snap) {
  const q = snap[id], mom = clamp(q.pct / (SCALE[id] || 1), -1, 1), ns = newsScore(id);
  let num = 0, den = 0;
  for (const ref of ['dxy', 'brent']) {
    if (ref === id || !snap[ref]) continue;
    const c = await corrOf(id, ref);
    if (c != null) { num += c * clamp(snap[ref].pct / SCALE[ref], -1, 1); den += Math.abs(c); }
  }
  const mac = den > .05 ? clamp(num / den, -1, 1) : 0, hasNews = news.items.length > 0;
  const total = hasNews ? .5 * ns.v + .25 * mom + .25 * mac : .5 * mom + .5 * mac;
  const status = statusOf(total), conf = Math.round(Math.min(95, 35 + Math.abs(total) * 120));
  const nTxt = hasNews ? (ns.drivers.length ? 'Новости: ' + ns.drivers.join('; ') + '.' : 'В свежих новостях нет явных драйверов.') : 'Лента новостей недоступна, анализ только по ценам.';
  const mTxt = (snap.dxy ? 'DXY ' + sg2(snap.dxy.pct) : '') + (snap.brent ? ', Brent ' + sg2(snap.brent.pct) : '');
  const tail = status === 'ЖДАТЬ' ? 'Факторы слабые или противоречат друг другу.' : 'Факторы сходятся в одну сторону.';
  return { status, confidence: conf, reason: `${nTxt} ${TN[id]} ${sg2(q.pct)} за день; ${mTxt}; корреляционный фон ${mac >= 0 ? 'за рост' : 'за падение'} (${mac.toFixed(2).replace('.', ',')}). ${tail}` };
}

// ===== ИИ-анализ: промпт, разбор ответа, OpenRouter и Groq =====
// openrouter/free сам выбирает свободную рабочую бесплатную модель; остальные: запасные
const MODELS = ['openrouter/free', 'deepseek/deepseek-r1-0528:free', 'qwen/qwen3-32b:free', 'meta-llama/llama-3.2-3b-instruct:free'];

function buildMessages(id, snap) {
  const quotes = {};
  for (const k of Object.keys(snap)) quotes[TN[k]] = { price: snap[k].price, change_day_pct: +snap[k].pct.toFixed(3), open: snap[k].open };
  const headlines = news.items.map(i => ({ title: i.title, minutes_ago: Math.round((Date.now() - i.ts) / 60000), tags: i.tags }));
  return [
    { role: 'system', content: 'Ты аналитик рынков. По заголовкам новостей и котировкам оцени краткосрочное (на несколько часов) направление указанного актива. Опирайся только на переданные данные, ничего не выдумывай. Ответь ТОЛЬКО JSON без пояснений и без markdown: {"status":"ПОКУПАТЬ"|"ПРОДАВАТЬ"|"ЖДАТЬ","confidence":число от 0 до 100,"reason":"1-3 предложения на русском языке"}. Если новости противоречивы или несущественны, ставь ЖДАТЬ.' },
    { role: 'user', content: JSON.stringify({ asset: TN[id], quotes, headlines }) }
  ];
}

// Достаём JSON из текста ответа (модель могла добавить пояснения или ```json)
function extractJson(text) {
  const t = String(text || ''), cands = [], g = t.match(/\{[\s\S]*\}/);
  if (g) cands.push(g[0]);
  (t.match(/\{[^{}]*\}/g) || []).forEach(c => cands.push(c));
  for (const c of cands) { try { const j = JSON.parse(c); if (j && j.status) return j; } catch (e) { /* пробуем следующий */ } }
  throw new Error('JSON не найден в ответе: ' + t.slice(0, 120));
}

function parseSignal(j) {
  const map = { 'ПОКУПАТЬ': 'ПОКУПАТЬ', 'BUY': 'ПОКУПАТЬ', 'ПРОДАВАТЬ': 'ПРОДАВАТЬ', 'SELL': 'ПРОДАВАТЬ', 'ЖДАТЬ': 'ЖДАТЬ', 'WAIT': 'ЖДАТЬ', 'HOLD': 'ЖДАТЬ' };
  const status = map[String(j.status).trim().toUpperCase()], conf = Math.round(Number(j.confidence));
  if (!status || isNaN(conf) || !j.reason) throw new Error('неверный формат ответа');
  return { status, confidence: clamp(conf, 0, 100), reason: String(j.reason).slice(0, 500) };
}

async function askOpenRouter(id, snap) {
  const messages = buildMessages(id, snap), errs = [], t0 = Date.now();
  for (const model of MODELS) {
    if (Date.now() - t0 > 30000) { errs.push('превышено общее время ожидания'); break; }
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3000', 'X-Title': 'Verde' },
        body: JSON.stringify({ model, messages, temperature: .2, max_tokens: 1200 }),   // 1200: thinking-моделям хватает места и на рассуждения, и на готовый JSON; без response_format: часть бесплатных моделей отвечает на него ошибкой 400
        signal: AbortSignal.timeout(15000)
      });
      const raw = await r.text();
      let j = null; try { j = JSON.parse(raw); } catch (e) { /* не JSON */ }
      if (!r.ok || (j && j.error)) throw new Error('HTTP ' + r.status + ' ' + String((j && j.error && (j.error.message || JSON.stringify(j.error))) || raw).slice(0, 300));
      const m = j && j.choices && j.choices[0] && j.choices[0].message;
      // сначала content; если он пуст или без JSON, ищем JSON в reasoning (thinking-модели)
      const texts = [m && m.content, m && m.reasoning, m && m.reasoning_content].map(x => typeof x === 'string' ? x : (x != null ? JSON.stringify(x) : '')).filter(x => x.trim());
      let out = null, lastErr = null;
      for (const t of texts.length ? texts : ['']) { try { out = parseSignal(extractJson(t)); break; } catch (e) { lastErr = e; } }
      if (!out) throw lastErr || new Error('пустой ответ модели');
      out.model = (j && j.model) || model;
      return out;
    } catch (e) { errs.push(model + ': ' + e.message); }
  }
  throw new Error(errs.join(' | ').slice(0, 800));
}

async function groqSignal(id, snap) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: .2, max_tokens: 400, response_format: { type: 'json_object' }, messages: buildMessages(id, snap) }),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = parseSignal(extractJson((await r.json()).choices[0].message.content));
  out.model = 'llama-3.3-70b-versatile';
  return out;
}

async function snapshot(id) {
  const out = {};
  await Promise.all([...new Set([id, ...CORE])].map(async i => { try { out[i] = await quote(i); } catch (e) { /* нет котировки */ } }));
  return out;
}

const sigCache = new Map(), sigJobs = new Map();
async function signal(id) {
  const hit = sigCache.get(id);
  if (hit && Date.now() - hit.t < 60000) return hit.v;
  if (sigJobs.has(id)) return sigJobs.get(id);
  const job = (async () => {
    const snap = await snapshot(id);
    if (!snap[id]) throw new Error('нет котировки ' + id);
    let r = null, source = 'rules';
    const errs = [];
    if (process.env.OPENROUTER_API_KEY) { try { r = await askOpenRouter(id, snap); source = 'openrouter'; } catch (e) { errs.push('OpenRouter: ' + e.message); } }
    if (!r && process.env.GROQ_API_KEY) { try { r = await groqSignal(id, snap); source = 'groq'; } catch (e) { errs.push('Groq: ' + e.message); } }
    if (!process.env.OPENROUTER_API_KEY && !process.env.GROQ_API_KEY) errs.push('ключ ИИ не задан (OPENROUTER_API_KEY)');
    errs.forEach(e => console.warn('ИИ недоступен, работает встроенный анализатор:', e));
    if (!r) r = await localSignal(id, snap);
    const v = { id, status: r.status, side: r.status === 'ПОКУПАТЬ' ? 1 : r.status === 'ПРОДАВАТЬ' ? -1 : 0, confidence: r.confidence, reason: r.reason, source, model: r.model || null, aiError: errs.length ? errs.join(' | ').slice(0, 900) : null,
      news: { src: news.src, updated: news.t, count: news.items.length, error: news.err }, t: Date.now() };
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
