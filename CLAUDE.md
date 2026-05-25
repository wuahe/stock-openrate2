# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 專案概述

台股開盤溢價追蹤工具。查詢上市/上櫃個股近 N 日的開盤溢價%、漲跌%、收盤與成交量,附盤中即時報價,輸出 LINE 友善版面。零 AI、零金鑰,資料全部來自 TWSE / TPEX 官方公開端點。部署於 Zeabur。

## 常用指令

```bash
npm install        # 安裝相依套件(僅 express)
npm start          # 啟動伺服器,預設 http://localhost:8080
```

沒有測試、沒有 lint、沒有 build step。`PORT` 環境變數可覆寫埠號(Zeabur 會自動注入)。

**需 Node 18+**:`twstock-core.js` 的 `httpJson` 直接用全域 `fetch`,沒有 polyfill。`package.json` 的 `engines.node` 已宣告 `>=18`,在更舊的 Node 上會整批查詢失敗。

驗證改動最快的方式:`npm start` 後對 `/api/stock` 打查詢,例如
`curl 'http://localhost:8080/api/stock?q=2330&days=10'`。

## 架構

三個檔案,職責清楚分層:

- **`twstock-core.js`** — 純資料層,匯出 `resolveStock` / `fetchDaily` / `compute` 三個無狀態函式(SECURITY_CACHE 除外)。**只負責上市/上櫃**,興櫃在獨立子模組。
- **`server.js`** — Express 薄層,提供靜態網頁與 `/api/stock` 端點。在靜態頁與 `*` fallback 之間 `app.use(emergingRouter)` 掛載興櫃子模組。新增 API 路由須掛在 `app.get("*")` 之前。
- **`public/index.html`** — 上市櫃單頁前端(HTML/CSS/JS 全部內嵌,無框架、無 build)。
- **`emerging/`** + **`public/emerging/`** — 興櫃子模組,完全自包含,見下節。

### 興櫃子模組

獨立子目錄,刪 `emerging/` + server.js 兩行引用即可整個移除:
- `emerging/data.js` — 興櫃資料層,`resolveEmerging` / `fetchYahooDaily` / `compute`。
- `emerging/router.js` — Router 掛 `/api/emerging` 與靜態 `/emerging/*`。
- `public/emerging/index.html` — 興櫃前端頁。

**混合資料源**(改 data.js 前必讀):
- **真即時報價 / 五檔 / 今日均價 / 昨均**: `mis.tpex.org.tw/Quote.asmx/GETQ20`(POST form-encoded `SymbolID=XXXX`,回 XML)。分鐘級即時,有完整自營商買賣盤。`fetchRealtime()`,無快取(都已即時了,前端要新就再打)。
- **清單(代號↔名稱)**: TPEX `openapi/v1/tpex_esb_latest_statistics`。**只用於名稱搜尋**,因為 GETQ20 要精確代號。`SNAPSHOT_CACHE` 60 秒 TTL。涵蓋全部 347 檔興櫃(含定價交易)。
- **歷史日線(OHLCV)**: **Yahoo Finance** chart API `query1.finance.yahoo.com/v7/finance/chart/{code}.TWO?range=1y&interval=1d`。`YAHOO_CACHE` 1 小時 TTL。最長 ~243 個交易日。
- **降級**: 若 mis.tpex 故障,`resolveEmerging` 自動退回 openapi 延遲快照,並設 `intraday.stale = true` 讓前端顯示「⚠ 延遲快照」。

**為何不直接用 TPEX openapi 當即時?** 該端點是**前一交易日盤後快照**,週一查到的可能還是上週五 16:30 資料,時間戳會嚴重誤導使用者。mis.tpex GETQ20 才是真即時(每分鐘更新)。

**為何不用 TPEX 的歷史端點?** TPEX `www/zh-tw/emerging/historical` 完全**忽略 date 參數**,任何月份查詢都回最近 ~15 天的同一份資料。試過 2024/05、2025/05、2025/12 全部回 5/4~5/22 — 無法做長期趨勢與量比基準。Yahoo 是唯一能拿長歷史的免費來源。

**mis.tpex 陷阱**: 對「今日尚未成交」的個股,XML 欄位 `TradePrice`/`TradeStatisticAverage` 回 `0` 而非空字串。`parseRealtimeXml` 的 `z2n` helper 把 0 轉 null,避免前端顯示「0.00」誤導為跌停。但 `PreAverage`/`TradeStatisticTtlVol` 不做 z2n(它們的 0 本身就是有意義的資料)。

**Yahoo 反限流陷阱**(重要):
- Yahoo 對「完整 Chrome User-Agent」字串會 HTTP 429(視為機器人)。
- **必須用最短 UA `Mozilla/5.0`** 才能成功;`httpJson(url, { ua: "Mozilla/5.0" })` 已在 `fetchYahooDaily` 內處理。
- 不要把 `data.js` 頂部的 `UA` 改短,那個是給 TPEX 用的;TPEX 反而需要完整 UA。

興櫃 vs 上市櫃指標差異:
- 議價市場無集合競價,**沒有開盤溢價**。核心指標:**收盤漲跌%**(close-to-close,與主頁邏輯一致)、量比(當日張數 ÷ 近 20 日均量)、買賣價差%。
- 「日成交均價」只在「即時報價」區塊出現(來自 TPEX),歷史日線表格全部用 Yahoo close。混用會混淆使用者,維持這個分工。
- 成交量單位:TPEX 是「股」、Yahoo `volume` 也是「股」,兩邊都 ÷1000 換張。與主頁的 TWSE/TPEX 不同(TPEX `tradingStock` 是「張」)。
- 流動性陷阱:興櫃常見 0 成交、價差 >5%,前端跳警示;`compute` 對 `volumeRatio` 取「i+1 起的 20 筆」當基準,不把當日算入。

### 查詢資料流

`/api/stock` → `resolveStock(q)` → `fetchDaily(code, marketKey, days)` → `compute(rows)` → JSON。

1. **`resolveStock`** 把中文名稱或 4 位代號解析成個股資訊,並抓盤中即時報價。名稱對多檔時會丟錯並列出候選代號。
2. **`fetchDaily`** 抓歷史日線:往回最多 5 個月、依日期去重,取 `days + 1` 筆(多抓 1 筆當最舊一天的昨收)。
3. **`compute`** 逐日算溢價%與漲跌%,並**捨棄最舊那筆**(它只當 prevClose 用)。

### 三個官方資料來源(各有脾氣)

| 用途 | 端點 | 備註 |
|------|------|------|
| 個股清單(名稱↔代號) | `openapi.twse.com.tw` STOCK_DAY_ALL(上市)+ `tpex.org.tw/openapi`(上櫃) | 模組層 `SECURITY_CACHE` 快取 12 小時 |
| 盤中即時報價 | `mis.twse.com.tw` getStockInfo.jsp | 含一次重試吸收偶發限流 |
| 歷史日線 | `twse.com.tw` STOCK_DAY(上市)/ `tpex.org.tw` tradingStock(上櫃) | 回應結構不同,見下 |

### 關鍵陷阱(改抓取邏輯前必讀)

- **成交量單位不一致**:TWSE 日線第 2 欄是「成交股數」(股),需 ÷1000 換成張;TPEX 是「成交張數」(張)直接用。處理全在 `parseDailyRow`,以 `marketKey`(`"tse"` / `"otc"`)分流。
- **日期是民國年**:日線列首欄為 `民國年/月/日`,`parseDailyRow` 用 `+1911` 轉西元。
- **TWSE / TPEX 回應結構不同**:TWSE 資料在 `data.data`,TPEX 可能在 `data.tables[0].data`。
- **錯誤契約**:`/api/stock` 即使出錯也回 **HTTP 200**,錯誤訊息放在 body 的 `error` 欄位。前端靠 `data.error` 判斷。新增錯誤路徑請維持此約定。
- **溢價%定義**:`(今開 − 昨收) / 昨收`;漲跌%為 `(今收 − 昨收) / 昨收`。前後端、LINE 版面都依此定義,改動需同步。

### 前後端契約

`/api/stock?q=<名稱或代號>&days=<1-60>` 回傳 `{ stock, intraday, daily, fetchedAt, source }`,出錯時回 `{ error }`。`days` 在後端夾在 1–60。前端 `buildLine` / `buildAI` 依此結構組 LINE 與 AI 點評文字。

## 部署

push 到 GitHub 後 Zeabur 自動以 `npm start` 重新部署。`/healthz` 供健康檢查。
