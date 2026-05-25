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

async function httpJson(url, timeoutMs = 10000) {
  // 為外部 API 加上 timeout,避免 TWSE/TPEX 連線懸住時 Express handler 也一直等
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
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
  const markets = meta ? [meta.marketKey] : ["tse", "otc"];
  for (const mkt of markets) {
    const info = await probeCode(code, mkt);
    if (info) {
      if (meta) info.market = meta.market;
      if (meta && !info.name) info.name = meta.name;
      return info;
    }
  }
  if (meta) {
    return {
      code,
      name: meta.name,
      market: meta.market,
      marketKey: meta.marketKey,
      intraday: { hasQuote: false },
    };
  }
  throw new Error(`找不到代號 ${code} 的個股資料`);
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
  if (price === null) price = num(m.h) || num(m.l); // 漲跌停鎖死
  const prev = num(m.y);
  const open = num(m.o);
  const r = {
    time: m.t || "",
    price,
    open,
    high: num(m.h),
    low: num(m.l),
    prevClose: prev,
    volumeLots: parseInt(num(m.v) || 0, 10),
    limitUp: num(m.u),
    limitDown: num(m.w),
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
