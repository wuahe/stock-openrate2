// 台股開盤溢價追蹤 — Zeabur Node 伺服器
// 同時提供:靜態網頁(public/)與 /api/stock 查詢端點。
// 抓取邏輯沿用 twstock-core.js(與 Netlify 版同一份核心)。
// 零 AI、零金鑰;資料來源為 TWSE / TPEX 官方公開端點。

const express = require("express");
const path = require("path");
const { resolveStock, fetchDaily, compute } = require("./twstock-core");
const emergingRouter = require("./emerging/router");

const app = express();
const PORT = process.env.PORT || 8080;

// 靜態網頁
app.use(express.static(path.join(__dirname, "public")));

// 興櫃子模組(靜態 /emerging/* 與 /api/emerging)
app.use(emergingRouter);

// 健康檢查(Zeabur 會用得到)
app.get("/healthz", (req, res) => res.json({ ok: true }));

// 個股查詢 API
app.get("/api/stock", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  try {
    const q = (req.query.q || "").toString();
    let days = parseInt((req.query.days || "10").toString(), 10);
    if (!Number.isFinite(days) || days < 1) days = 10;
    if (days > 60) days = 60;

    const info = await resolveStock(q);
    const daily = compute(await fetchDaily(info.code, info.marketKey, days));

    res.json({
      stock: {
        code: info.code,
        name: info.name,
        fullName: info.fullName || "",
        market: info.market,
      },
      intraday: info.intraday || { hasQuote: false },
      daily,
      fetchedAt: new Date().toISOString(),
      source: "TWSE / TPEX 官方端點",
    });
  } catch (e) {
    // 與前端約定:錯誤也以 200 回傳,body 帶 error 欄位
    res.json({ error: e.message || String(e) });
  }
});

// 其餘路徑一律回首頁(單頁應用)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`台股溢價追蹤伺服器已啟動,port ${PORT}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`✗ port ${PORT} 已被占用。先關掉占用程序,或用 PORT=8090 npm start 改埠。`);
  } else {
    console.error("✗ server 啟動失敗:", err.message);
  }
  process.exit(1);
});
