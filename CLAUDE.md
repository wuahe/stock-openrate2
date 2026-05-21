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

- **`twstock-core.js`** — 純資料層,匯出 `resolveStock` / `fetchDaily` / `compute` 三個無狀態函式(SECURITY_CACHE 除外)。與任何 web 框架解耦(檔頭註解仍寫「Netlify Function」,因為此核心是從 Netlify 版沿用而來)。
- **`server.js`** — Express 薄層,提供靜態網頁與 `/api/stock` 端點,直接串接 core 的三個函式。末端 `app.get("*")` 把其餘路徑一律回 `index.html`(單頁應用 fallback),新增 API 路由須掛在這條之前。
- **`public/index.html`** — 單頁前端(HTML/CSS/JS 全部內嵌,無框架、無 build)。

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
