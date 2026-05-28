// 興櫃子模組 — Express 路由
// 掛載方式:在 server.js 用 app.use(require("./emerging/router"))
// 提供:
//   GET  /api/emerging?q=<代號或名稱>&days=<1-240>
//   GET  /emerging/*  SPA fallback(不存在的子路徑停在興櫃頁,不被導回主頁)

const express = require("express");
const path = require("path");
const { resolveEmerging, fetchYahooDaily, compute } = require("./data");

const router = express.Router();

// 興櫃 API(同源使用,不開放跨域)。
// /emerging/* 靜態檔由 server.js 的 express.static('public') 涵蓋,這裡不重覆掛。
router.get("/api/emerging", async (req, res) => {
  try {
    const q = (req.query.q || "").toString();
    let days = parseInt((req.query.days || "30").toString(), 10);
    if (!Number.isFinite(days) || days < 1) days = 30;
    if (days > 240) days = 240; // Yahoo range=1y 約 243 個交易日

    const info = await resolveEmerging(q);
    let yahoo;
    let dailyError = "";
    try {
      yahoo = await fetchYahooDaily(info.code);
    } catch (e) {
      yahoo = { rows: [], stale: false, staleAgeMs: 0 };
      dailyError = e.message || String(e);
    }
    const daily = compute(yahoo.rows, days);

    res.json({
      stock: { code: info.code, name: info.name, market: "興櫃" },
      intraday: info.intraday || { hasQuote: false },
      daily,
      // 歷史資料來源延遲(Yahoo 連續失敗時用昨日快取);前端可據此顯示提示
      dailyStale: yahoo.stale || false,
      dailyStaleAgeMs: yahoo.staleAgeMs || 0,
      dailyUnavailable: !!dailyError,
      dailyError,
      fetchedAt: new Date().toISOString(),
      source: "即時:mis.tpex (真即時)｜歷史:Yahoo Finance",
    });
  } catch (e) {
    // 與主站相同契約:錯誤也回 200,body 含 error
    res.json({ error: e.message || String(e) });
  }
});

// SPA fallback:/emerging/xyz 等不存在子路徑停在興櫃頁(不被主站 * 兜底拉回上市櫃首頁)
// 注意:必須掛在 server.js 的 app.get("*") 之前才會被命中(目前已是)
router.get("/emerging/*", (req, res) => {
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.sendFile(path.join(__dirname, "..", "public", "emerging", "index.html"));
});

module.exports = router;
