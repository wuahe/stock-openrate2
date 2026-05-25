// 興櫃資料層 — 混合資料源
// 來源:
//   真即時報價(分鐘級):mis.tpex.org.tw/Quote.asmx/GETQ20 (POST XML)
//   清單(代號↔名稱):  TPEX openapi/v1/tpex_esb_latest_statistics (延遲快照,只用來名稱搜尋)
//   歷史日線 (OHLCV):  Yahoo Finance chart API (query1.finance.yahoo.com)
// 為何不用 TPEX openapi 當即時:該端點是前一交易日盤後快照,時間戳會誤導使用者。
// 為何不用 TPEX 歷史:TPEX 興櫃 historical 端點忽略 date 參數,只回最近 ~15 天。
// 代價:Yahoo 無「日成交均價」欄位,歷史表格改用收盤(close),與主頁上市櫃一致。

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

let SNAPSHOT_CACHE = null;
let SNAPSHOT_CACHE_TS = 0;
const SNAPSHOT_TTL = 60 * 1000; // 即時資料快取 60 秒,避免過度打 API

// Yahoo 歷史日線 cache:每檔股一份,TTL 1 小時
// 興櫃日線盤後才變動,1 小時夠避免重覆抓取同時避開 Yahoo 限流
const YAHOO_CACHE = new Map();
const YAHOO_TTL = 60 * 60 * 1000;

async function httpJson(url, opts) {
  const { retries = 0, retryDelay = 500, ua = UA, timeoutMs = 10000 } = opts || {};
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // 為外部 API 加上 timeout,避免 TPEX/Yahoo 連線懸住時 Express handler 也卡死
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": ua },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        lastErr = new Error("HTTP " + res.status);
        // 429 / 5xx 才重試,4xx 其他直接放棄
        if (res.status !== 429 && res.status < 500) throw lastErr;
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e.name === "AbortError"
        ? new Error(`上游逾時 ${timeoutMs}ms: ${url.slice(0, 60)}…`)
        : e;
    } finally {
      clearTimeout(tid);
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, retryDelay * (attempt + 1)));
    }
  }
  throw lastErr;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

async function loadSnapshot() {
  if (SNAPSHOT_CACHE && Date.now() - SNAPSHOT_CACHE_TS < SNAPSHOT_TTL) {
    return SNAPSHOT_CACHE;
  }
  const rows = await httpJson(
    "https://www.tpex.org.tw/openapi/v1/tpex_esb_latest_statistics"
  );
  const table = {};
  for (const r of rows || []) {
    const code = String(r.SecuritiesCompanyCode || "").trim();
    if (!/^\d{4,6}[A-Z]?$/.test(code)) continue;
    table[code] = r;
  }
  SNAPSHOT_CACHE = table;
  SNAPSHOT_CACHE_TS = Date.now();
  return table;
}

async function resolveEmerging(query) {
  query = String(query || "").trim();
  if (!query) throw new Error("請輸入興櫃股票名稱或代號");
  const snap = await loadSnapshot();

  let code = null;
  if (/^\d{4,6}[A-Z]?$/.test(query)) {
    code = query;
    if (!snap[code]) throw new Error(`找不到興櫃代號 ${code}(可能不在興櫃名單)`);
  } else {
    const entries = Object.entries(snap);
    const exact = entries.filter(([, v]) => (v.CompanyName || "").replace(/[*\s]/g, "") === query);
    const contains = entries.filter(([, v]) => (v.CompanyName || "").includes(query));
    for (const cand of [exact, contains]) {
      if (cand.length === 1) {
        code = cand[0][0];
        break;
      }
      if (cand.length > 1) {
        const names = cand
          .slice(0, 8)
          .map(([c, v]) => `${c} ${v.CompanyName}`)
          .join("、");
        throw new Error(`「${query}」對應到多檔興櫃,請改用代號:${names}`);
      }
    }
  }
  if (!code) throw new Error(`找不到興櫃「${query}」,請用 4 位代號(如 7832)`);

  const r = snap[code];
  const name = (r.CompanyName || "").trim();

  // 先試真即時,失敗時退回 openapi 延遲快照
  let intraday;
  try {
    intraday = await fetchRealtime(code);
  } catch (e) {
    intraday = parseIntradayFromSnapshot(r);
    intraday.stale = true;
    intraday.staleReason = "mis.tpex 即時來源失敗,退回 openapi 延遲快照";
  }
  return { code, name, intraday };
}

// 真即時 — mis.tpex GETQ20 (POST,回 XML)
async function fetchRealtime(code) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch("https://mis.tpex.org.tw/Quote.asmx/GETQ20", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "Referer": "https://mis.tpex.org.tw/IB120STK.aspx",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: "SymbolID=" + encodeURIComponent(code),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("mis.tpex HTTP " + res.status);
    const xml = await res.text();
    if (!xml.includes("<SymbolID>")) throw new Error("mis.tpex 回應為空");
    return parseRealtimeXml(xml);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("mis.tpex 逾時 8000ms");
    throw e;
  } finally {
    clearTimeout(tid);
  }
}

function xmlField(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : "";
}

function parseRealtimeXml(xml) {
  // mis.tpex 對「今日尚未成交」的欄位回 0(不是空字串/null),所以 num() 解出 0,
  // 但 0 在價量上下文等同「無資料」,統一轉成 null,前端才會顯示「—」而不是「0.00」
  const z2n = (v) => (v === 0 ? null : v);
  const tradeDay = xmlField(xml, "TradeDay"); // "2026/05/25"
  const tradeTime = xmlField(xml, "TradeStatisticTime"); // "13:10"
  const avg = z2n(num(xmlField(xml, "TradeStatisticAverage")));
  const prevAvg = num(xmlField(xml, "PreAverage"));
  const high = z2n(num(xmlField(xml, "TradeStatisticHigh")));
  const low = z2n(num(xmlField(xml, "TradeStatisticLow")));
  const latest = z2n(num(xmlField(xml, "TradePrice")));
  const volShares = num(xmlField(xml, "TradeStatisticTtlVol")) || 0;
  const trades = num(xmlField(xml, "TradeStatisticTtlTranscation")) || 0;

  // 聚合所有 Q20List 算最佳買賣 (max bid / min ask)
  let bestBid = 0, bestBidQty = 0, bestAsk = 0, bestAskQty = 0;
  const listRe = /<Q20List>([\s\S]*?)<\/Q20List>/g;
  let m;
  while ((m = listRe.exec(xml)) !== null) {
    const inner = m[1];
    const bp = num(xmlField(inner, "BuyPrice")) || 0;
    const bv = num(xmlField(inner, "BuyVol")) || 0;
    const sp = num(xmlField(inner, "SellPrice")) || 0;
    const sv = num(xmlField(inner, "SellVol")) || 0;
    if (bp > 0 && (bp > bestBid || bp === bestBid)) {
      if (bp > bestBid) { bestBid = bp; bestBidQty = 0; }
      bestBidQty += bv;
    }
    if (sp > 0 && (bestAsk === 0 || sp < bestAsk || sp === bestAsk)) {
      if (sp !== bestAsk) { bestAsk = sp; bestAskQty = 0; }
      bestAskQty += sv;
    }
  }

  const out = {
    snapshotAt: tradeDay && tradeTime ? `${tradeDay} ${tradeTime}` : "",
    tradeDay,                        // "2026/05/25" — 前端比對是否為今日
    time: tradeTime,                 // "13:10" — 短格式,前端可直接顯示
    latestPrice: latest,
    buyPrice: bestBid || null,
    buyQty: bestBidQty || null,
    sellPrice: bestAsk || null,
    sellQty: bestAskQty || null,
    high,
    low,
    average: avg,
    prevAverage: prevAvg,
    volumeLots: Math.round(volShares / 1000),
    trades,
    hasQuote: latest !== null || avg !== null,
    stale: false,
  };
  if (bestBid > 0 && bestAsk > 0) {
    const mid = (bestBid + bestAsk) / 2;
    out.spreadPct = mid > 0 ? +(((bestAsk - bestBid) / mid) * 100).toFixed(2) : null;
  }
  if (avg !== null && prevAvg) {
    out.dailyChangePct = +(((avg - prevAvg) / prevAvg) * 100).toFixed(2);
  }
  return out;
}

function parseIntradayFromSnapshot(r) {
  const buy = num(r.BuyingPrice);
  const sell = num(r.SellingPrice);
  const avg = num(r.Average);
  const prevAvg = num(r.PreviousAveragePrice);
  const latest = num(r.LatestPrice);
  const high = num(r.Highest);
  const low = num(r.Lowest);
  const volShares = num(r.TransactionVolume) || 0; // 興櫃單位為「股」
  const volumeLots = Math.round(volShares / 1000);

  const out = {
    time: formatTime(r.Time),
    latestPrice: latest,
    buyPrice: buy,
    buyQty: num(r.BuyingQuantity),
    sellPrice: sell,
    sellQty: num(r.SellingQuantity),
    high,
    low,
    average: avg,
    prevAverage: prevAvg,
    volumeLots,
    hasQuote: latest !== null || avg !== null,
  };

  if (buy !== null && sell !== null && sell > 0) {
    const mid = (buy + sell) / 2;
    out.spreadPct = mid > 0 ? +(((sell - buy) / mid) * 100).toFixed(2) : null;
  }
  if (avg !== null && prevAvg) {
    out.dailyChangePct = +(((avg - prevAvg) / prevAvg) * 100).toFixed(2);
  }
  return out;
}

function formatTime(t) {
  // "163004" -> "16:30:04"
  const s = String(t || "").padStart(6, "0");
  if (!/^\d{6}$/.test(s)) return "";
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

async function fetchYahooDaily(code) {
  // 先查 cache:命中就直接回,Yahoo 完全不打
  const cached = YAHOO_CACHE.get(code);
  if (cached && Date.now() - cached.ts < YAHOO_TTL) {
    return cached.rows;
  }
  // Yahoo Finance chart API。range=1y 給 ~243 個交易日,興櫃股 .TWO 後綴可用。
  // 若新掛牌股不足一年,Yahoo 會自動截到 IPO 日。
  const url =
    "https://query1.finance.yahoo.com/v7/finance/chart/" +
    `${code}.TWO?range=1y&interval=1d`;
  // Yahoo 對「完整 Chrome UA」會限流(視為機器人),改用最短 UA 反而 OK。
  const data = await httpJson(url, {
    ua: "Mozilla/5.0",
    retries: 2,
    retryDelay: 1000,
  });
  const result = (data.chart && data.chart.result && data.chart.result[0]) || null;
  if (!result) return [];
  const ts = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const opens = quote.open || [];
  const highs = quote.high || [];
  const lows = quote.low || [];
  const closes = quote.close || [];
  const vols = quote.volume || [];
  const rows = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    // Yahoo 對未來日 / 停牌日會放 null,直接過濾
    if (c === null || c === undefined) continue;
    const d = new Date(ts[i] * 1000);
    const iso =
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0");
    const volShares = vols[i] || 0;
    rows.push({
      date: iso,
      open: opens[i] !== null ? round2(opens[i]) : null,
      high: highs[i] !== null ? round2(highs[i]) : null,
      low: lows[i] !== null ? round2(lows[i]) : null,
      close: round2(c),
      volumeLots: Math.round(volShares / 1000),
    });
  }
  // Yahoo 給的是舊→新,我們要新→舊(與既有 compute 與前端表格一致)
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  YAHOO_CACHE.set(code, { ts: Date.now(), rows });
  return rows;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 計算每日收盤漲跌% 與 量比(當日張數 / 過去 20 日均量)
function compute(rows, days) {
  const VOL_WINDOW = 20;
  const out = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const cur = rows[i];
    const prev = rows[i + 1];
    const rec = { ...cur, prevClose: prev.close };
    if (prev.close && cur.close !== null) {
      rec.changePct = +(((cur.close - prev.close) / prev.close) * 100).toFixed(2);
    }
    // 用 i 之後的 20 筆(較舊)算量比基準,避免把當日本身算進去
    const window = rows.slice(i + 1, i + 1 + VOL_WINDOW).map((x) => x.volumeLots || 0);
    if (window.length >= 5) {
      const avgVol = window.reduce((a, b) => a + b, 0) / window.length;
      if (avgVol > 0) {
        rec.volumeRatio = +(cur.volumeLots / avgVol).toFixed(2);
      }
    }
    out.push(rec);
  }
  return out.slice(0, days);
}

module.exports = { resolveEmerging, fetchYahooDaily, compute };
