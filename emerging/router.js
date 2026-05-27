// 興櫃子模組 — Express 路由
// 掛載方式:在 server.js 用 app.use(require("./emerging/router"))
// 提供:
//   GET  /api/emerging?q=<代號或名稱>&days=<1-240>
//   靜態 /emerging/*  -> public/emerging/

const express = require("express");
const path = require("path");
const { resolveEmerging, fetchYahooDaily, compute } = require("./data");

const router = express.Router();

router.use(
  "/emerging",
  express.static(path.join(__dirname, "..", "public", "emerging"))
);

router.get("/api/emerging", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const q = (req.query.q || "").toString();
    let days = parseInt((req.query.days || "30").toString(), 10);
    if (!Number.isFinite(days) || days < 1) days = 30;
    if (days > 240) days = 240; // Yahoo range=1y 約 243 個交易日

    const info = await resolveEmerging(q);
    const yahoo = await fetchYahooDaily(info.code);
    const daily = compute(yahoo.rows, days);

    res.json({
      stock: { code: info.code, name: info.name, market: "興櫃" },
      intraday: info.intraday || { hasQuote: false },
      daily,
      // 歷史資料來源延遲(Yahoo 連續失敗時用昨日快取);前端可據此顯示提示
      dailyStale: yahoo.stale || false,
      dailyStaleAgeMs: yahoo.staleAgeMs || 0,
      fetchedAt: new Date().toISOString(),
      source: "即時:mis.tpex (真即時)｜歷史:Yahoo Finance",
    });
  } catch (e) {
    // 與主站相同契約:錯誤也回 200,body 含 error
    res.json({ error: e.message || String(e) });
  }
});

module.exports = router;
