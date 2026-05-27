// 台股開盤溢價追蹤 — Netlify Function
// 在伺服器端抓 TWSE / TPEX 官方資料,避開瀏覽器 CORS 限制。
// 不使用任何 AI / 不需要金鑰。資料來源皆為官方公開端點。

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// 個股清單快取(函式實例存活期間有效,降低重複抓取)
let SECURITY_CACHE = null;
let SECURITY_CACHE_TS = 0;
const NAME_TTL = 12 * 60 * 60 * 1000; // 12 小時

// 盤中即時報價快取:吸收 mis.twse 偶發故障(msgArray 空)導致今日列閃爍消失
// key: `${marketKey}_${code}` → { ts, intraday }
const INTRADAY_CACHE = new Map();
const INTRADAY_TTL = 5 * 60 * 1000; // 5 分鐘,避免當日列因上游短暫空值忽隱忽現

async function httpJson(url, opts) {
  // 為外部 API 加上 timeout,避免 TWSE/TPEX 連線懸住時 Express handler 也一直等
  // opts.ua 可改短 UA(Yahoo 對完整 Chrome UA 會 429,要用短 UA)
  const { ua = UA, timeoutMs = 10000 } =
    typeof opts === "number" ? { timeoutMs: opts } : opts || {};
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`上游逾時 ${timeoutMs}ms: ${url.slice(0, 60)}…`);
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

function num(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(String(v).replace(/,/g, "").replace(/\+/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function twDateFromMs(ms) {
  if (!ms) return "";
  const p = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms)).forEach((x) => {
    p[x.type] = x.value;
  });
  return `${p.year}-${p.month}-${p.day}`;
}

function parseTwseDate(v) {
  const s = String(v || "").trim();
  if (!/^\d{8}$/.test(s)) return "";
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function hasIntradayRowData(intraday) {
  return !!(
    intraday &&
    intraday.quoteDate &&
    intraday.open !== null &&
    intraday.open !== undefined &&
    intraday.prevClose !== null &&
    intraday.prevClose !== undefined
  );
}

function isTodayIntraday(intraday) {
  return hasIntradayRowData(intraday) && intraday.quoteDate === twDateFromMs(Date.now());
}

// ---- 個股清單:名稱 <-> 代號 ----
async function loadSecurityTable() {
  if (SECURITY_CACHE && Date.now() - SECURITY_CACHE_TS < NAME_TTL) {
    return SECURITY_CACHE;
  }
  const table = {};
  // 上市
  try {
    const rows = await httpJson(
      "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL"
    );
    for (const r of rows) {
      const code = String(r.Code || "").trim();
      const name = String(r.Name || "").trim();
      if (/^\d{4}$/.test(code) && name) {
        table[code] = { name, marketKey: "tse", market: "上市" };
      }
    }
  } catch (e) {
    /* 容錯:單一來源失敗不影響另一個 */
  }
  // 上櫃
  try {
    const rows = await httpJson(
      "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes"
    );
    for (const r of rows) {
      const code = String(r.SecuritiesCompanyCode || "").trim();
      const name = String(r.CompanyName || "").trim();
      if (/^\d{4}$/.test(code) && name) {
        table[code] = { name, marketKey: "otc", market: "上櫃" };
      }
    }
  } catch (e) {
    /* 容錯 */
  }
  if (Object.keys(table).length) {
    SECURITY_CACHE = table;
    SECURITY_CACHE_TS = Date.now();
  }
  return table;
}

// 中文名稱或代號 -> 個股資訊
async function resolveStock(query) {
  query = String(query || "").trim();
  if (!query) throw new Error("請輸入股票名稱或代號");
  const table = await loadSecurityTable();

  let code = null;
  if (/^\d{4}$/.test(query)) {
    code = query;
  } else {
    const entries = Object.entries(table);
    const exact = entries.filter(([, v]) => v.name === query);
    const prefix = entries.filter(([, v]) => v.name.startsWith(query));
    const contains = entries.filter(([, v]) => v.name.includes(query));
    for (const cand of [exact, prefix, contains]) {
      if (cand.length === 1) {
        code = cand[0][0];
        break;
      }
      if (cand.length > 1) {
        const names = cand
          .slice(0, 8)
          .map(([c, v]) => `${c} ${v.name}`)
          .join("、");
        throw new Error(`「${query}」對應到多檔,請改用代號:${names}`);
      }
    }
  }
  if (!code) throw new Error(`找不到「${query}」,請改用 4 位股票代號查詢`);

  const meta = table[code];
  // 常見路徑:meta 命中,用 Yahoo 抓盤中(比 mis.twse 穩,不會出現 z 短暫為 null)
  if (meta) {
    let intraday;
    try {
      intraday = await fetchYahooTwIntraday(code, meta.marketKey);
    } catch (e) {
      intraday = null;
    }
    // Yahoo 當日 bar 偶爾延遲或欄位不完整,這時改抓 TWSE/TPEX 即時端點補今天那列
    if (!isTodayIntraday(intraday)) {
      const probed = await probeCode(code, meta.marketKey);
      if (probed && isTodayIntraday(probed.intraday)) intraday = probed.intraday;
    }
    // 兩個上游都短暫空值時,沿用最近一次可用的當日資料,並標記為快取
    if (!isTodayIntraday(intraday)) {
      const cached = INTRADAY_CACHE.get(`${meta.marketKey}_${code}`);
      intraday =
        cached && Date.now() - cached.ts < INTRADAY_TTL
          ? { ...cached.intraday, stale: true }
          : intraday || { hasQuote: false };
    }
    if (isTodayIntraday(intraday)) {
      INTRADAY_CACHE.set(`${meta.marketKey}_${code}`, {
        ts: Date.now(),
        intraday: { ...intraday, stale: false },
      });
    }
    return {
      code,
      name: meta.name,
      market: meta.market,
      marketKey: meta.marketKey,
      intraday,
    };
  }
  // 邊緣路徑:meta 沒命中(可能是清單還沒重抓),用 probeCode 嗅探兩個市場
  for (const mkt of ["tse", "otc"]) {
    const info = await probeCode(code, mkt);
    if (info) {
      try {
        const yahoo = await fetchYahooTwIntraday(code, mkt);
        // 只在 Yahoo 是今天資料、或 probeCode 本來就不是今天時才覆寫,
        // 避免 Yahoo 延遲快照蓋掉 mis.twse 的今日資料
        if (yahoo && (isTodayIntraday(yahoo) || !isTodayIntraday(info.intraday))) {
          info.intraday = yahoo;
        }
      } catch (e) {
        /* 用 probeCode 的 intraday 兜底 */
      }
      return info;
    }
  }
  throw new Error(`找不到代號 ${code} 的個股資料`);
}

// 台股 tick size(漲跌停價會被截到合法 tick)
function twTickSize(p) {
  if (p < 10) return 0.01;
  if (p < 50) return 0.05;
  if (p < 100) return 0.1;
  if (p < 500) return 0.5;
  if (p < 1000) return 1;
  return 5;
}

// 漲停價 = floor(prev*1.10 / tick) * tick;跌停價 = ceil(prev*0.9 / tick) * tick
function twLimitPrice(prev, isUpper) {
  if (!prev) return null;
  const raw = prev * (isUpper ? 1.10 : 0.90);
  const tick = twTickSize(raw);
  const v = isUpper ? Math.floor(raw / tick) * tick : Math.ceil(raw / tick) * tick;
  return +v.toFixed(2);
}

// Yahoo Finance chart API — 比 mis.twse 穩定,當日 bar 含 o/h/l/c/v + regularMarketPrice
// 上市用 .TW、上櫃用 .TWO。Yahoo 對完整 Chrome UA 會 429,必須用短 UA。
async function fetchYahooTwIntraday(code, marketKey) {
  const suffix = marketKey === "tse" ? ".TW" : ".TWO";
  const url =
    "https://query1.finance.yahoo.com/v7/finance/chart/" +
    `${code}${suffix}?range=5d&interval=1d`;
  const data = await httpJson(url, { ua: "Mozilla/5.0" });
  const r = data && data.chart && data.chart.result && data.chart.result[0];
  if (!r) return { hasQuote: false };
  const meta = r.meta || {};
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const n = ts.length;
  if (!n) return { hasQuote: false };
  // Yahoo 回傳是 IEEE 754 雜訊(22.149999618530273),要四捨五入到 2 位
  const r2 = (v) => (v === null ? null : +v.toFixed(2));
  const i = n - 1;
  const open = r2(num(q.open && q.open[i]));
  const high = r2(num(q.high && q.high[i]));
  const low = r2(num(q.low && q.low[i]));
  const lastClose = r2(num(q.close && q.close[i]));
  // 盤中即時價優先用 regularMarketPrice,沒有就退回 last bar 的 close
  let price = r2(num(meta.regularMarketPrice));
  if (price === null) price = lastClose;
  // 昨收:從尾巴 i-1 往前找最近一筆非空 close(Yahoo 偶爾會缺某天)
  // 找不到才退回 chartPreviousClose(這個是 range 起點再往前的那一天,可能差很多天)
  let prev = null;
  for (let j = i - 1; j >= 0; j--) {
    const c = num(q.close && q.close[j]);
    if (c !== null) {
      prev = r2(c);
      break;
    }
  }
  if (prev === null) prev = r2(num(meta.chartPreviousClose));
  const vol = num(q.volume && q.volume[i]) || 0;
  // Yahoo 成交量單位是「股」,轉「張」
  const volumeLots = Math.round(vol / 1000);
  // 台北時間 HH:MM:SS
  const tMs = ((meta.regularMarketTime || ts[i]) || 0) * 1000;
  const time = tMs
    ? new Date(tMs).toLocaleTimeString("en-GB", {
        timeZone: "Asia/Taipei",
        hour12: false,
      })
    : "";
  const quoteDate = twDateFromMs((ts[i] || meta.regularMarketTime || 0) * 1000);
  const limitUp = twLimitPrice(prev, true);
  const limitDown = twLimitPrice(prev, false);
  const out = {
    quoteDate,
    time,
    price,
    open,
    high,
    low,
    prevClose: prev,
    volumeLots,
    limitUp,
    limitDown,
    hasQuote: price !== null,
  };
  if (price !== null && prev) {
    out.change = +(price - prev).toFixed(2);
    out.changePct = +(((price - prev) / prev) * 100).toFixed(2);
  }
  if (open !== null && prev) {
    out.premiumPct = +(((open - prev) / prev) * 100).toFixed(2);
  }
  out.limitLocked =
    price !== null &&
    ((limitUp !== null && Math.abs(price - limitUp) < 0.001) ||
      (limitDown !== null && Math.abs(price - limitDown) < 0.001));
  return out;
}

// 盤中即時報價(含一次重試,吸收偶發限流)
async function probeCode(code, mkt) {
  const url =
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp" +
    `?ex_ch=${mkt}_${code}.tw&json=1&delay=0`;
  let data = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await httpJson(url);
      if (data && (data.msgArray || []).length) break;
    } catch (e) {
      /* 重試 */
    }
    data = null;
    await new Promise((r) => setTimeout(r, 350));
  }
  if (!data) return null;
  const arr = data.msgArray || [];
  if (!arr.length) return null;
  const m = arr[0];
  return {
    code,
    name: m.n || "",
    fullName: m.nf || "",
    market: mkt === "tse" ? "上市" : "上櫃",
    marketKey: mkt,
    intraday: parseIntraday(m),
  };
}

function parseIntraday(m) {
  let price = num(m.z);
  const prev = num(m.y);
  const open = num(m.o);
  const high = num(m.h);
  const low = num(m.l);
  const limitUp = num(m.u);
  const limitDown = num(m.w);
  // z 為空只在「漲跌停鎖死」時才補 high/low,否則保留 null,避免拿當日最高誤當現價
  if (price === null) {
    if (high !== null && limitUp !== null && Math.abs(high - limitUp) < 0.01) {
      price = high;
    } else if (low !== null && limitDown !== null && Math.abs(low - limitDown) < 0.01) {
      price = low;
    }
  }
  const r = {
    quoteDate: parseTwseDate(m.d),
    time: m.t || "",
    price,
    open,
    high,
    low,
    prevClose: prev,
    volumeLots: parseInt(num(m.v) || 0, 10),
    limitUp,
    limitDown,
    hasQuote: price !== null,
  };
  if (price !== null && prev) {
    r.change = +(price - prev).toFixed(2);
    r.changePct = +(((price - prev) / prev) * 100).toFixed(2);
  }
  if (open !== null && prev) {
    r.premiumPct = +(((open - prev) / prev) * 100).toFixed(2);
  }
  r.limitLocked =
    price !== null && r.limitUp !== null && Math.abs(price - r.limitUp) < 0.01;
  return r;
}

// 歷史日線
async function fetchDaily(code, marketKey, days) {
  const today = new Date();
  const rows = [];
  const seen = new Set();
  for (let back = 0; back < 5; back++) {
    let y = today.getFullYear();
    let mth = today.getMonth() + 1 - back;
    while (mth <= 0) {
      mth += 12;
      y -= 1;
    }
    const mm = String(mth).padStart(2, "0");
    let url, isTpex;
    if (marketKey === "tse") {
      url =
        "https://www.twse.com.tw/exchangeReport/STOCK_DAY" +
        `?response=json&date=${y}${mm}01&stockNo=${code}`;
      isTpex = false;
    } else {
      url =
        "https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock" +
        `?code=${code}&date=${y}/${mm}/01&id=&response=json`;
      isTpex = true;
    }
    let data;
    try {
      data = await httpJson(url);
    } catch (e) {
      continue;
    }
    let recs = data.data;
    if (!recs && data.tables && data.tables[0]) recs = data.tables[0].data;
    for (const rec of recs || []) {
      const p = parseDailyRow(rec, marketKey);
      if (p && !seen.has(p.date)) {
        seen.add(p.date);
        rows.push(p);
      }
    }
    if (rows.length >= days + 1) break;
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  return rows.slice(0, days + 1);
}

// 日線列: [民國日期, 量, 金額, 開, 高, 低, 收, 漲跌, 筆數]
// TWSE 第2欄為「成交股數」(股) -> /1000 為張;TPEX 為「成交張數」(張) 直接用
function parseDailyRow(rec, marketKey) {
  try {
    const parts = String(rec[0]).trim().split("/");
    if (parts.length !== 3) return null;
    const iso =
      parseInt(parts[0], 10) +
      1911 +
      "-" +
      String(parseInt(parts[1], 10)).padStart(2, "0") +
      "-" +
      String(parseInt(parts[2], 10)).padStart(2, "0");
    const rawVol = num(rec[1]) || 0;
    const volumeLots =
      marketKey === "tse" ? Math.round(rawVol / 1000) : Math.round(rawVol);
    return {
      date: iso,
      open: num(rec[3]),
      high: num(rec[4]),
      low: num(rec[5]),
      close: num(rec[6]),
      volumeLots,
    };
  } catch (e) {
    return null;
  }
}

// 計算每日溢價% 與漲跌%
function compute(rows) {
  const out = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = rows[i];
    const prev = rows[i + 1];
    const rec = { ...cur, prevClose: prev.close };
    if (prev.close) {
      if (cur.open !== null)
        rec.premiumPct = +(((cur.open - prev.close) / prev.close) * 100).toFixed(2);
      if (cur.close !== null)
        rec.changePct = +(((cur.close - prev.close) / prev.close) * 100).toFixed(2);
    }
    out.push(rec);
  }
  return out;
}

module.exports = { resolveStock, fetchDaily, compute };
