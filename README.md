# 台股開盤溢價追蹤 — Zeabur 版

查詢台股(上市/上櫃)個股近 N 日的開盤溢價%、漲跌%、收盤與成交量,
附盤中即時報價,輸出 LINE 友善版面。零 AI、零金鑰。

**興櫃股**另立子頁(`/emerging`):因議價市場無開盤集合競價,改追**收盤漲跌%** 與
**量比**(當日張數 ÷ 近 20 日均量),用真即時 mis.tpex 取代延遲快照,
歷史日線取 Yahoo Finance(最長 ~243 個交易日)。

資料來源:TWSE / TPEX 官方公開端點 + Yahoo Finance(僅興櫃歷史)。

## 路由

| 路徑 | 用途 |
|---|---|
| `/` | 上市櫃個股開盤溢價追蹤 |
| `/emerging` | 興櫃個股拉抬 / 量比偵測 |
| `/api/stock?q=&days=` | 上市櫃 JSON API |
| `/api/emerging?q=&days=` | 興櫃 JSON API(`days` 上限 240) |
| `/healthz` | 健康檢查 |

## 專案結構

```
twstock-zeabur/
├── server.js              Express 伺服器(掛載靜態 + /api/stock + 興櫃 router)
├── twstock-core.js        上市/上櫃資料層(TWSE / TPEX 官方端點)
├── package.json           只依賴 express
├── emerging/              興櫃子模組(完全自包含)
│   ├── data.js            mis.tpex 即時 + openapi 清單 + Yahoo 歷史
│   └── router.js          /api/emerging + /emerging/* 靜態
└── public/
    ├── index.html         上市櫃前端
    └── emerging/
        └── index.html     興櫃前端
```

刪掉興櫃功能很乾淨:刪 `emerging/`、`public/emerging/`、`server.js` 內 `emergingRouter`
引用兩行、`public/index.html` 的導覽連結即可。

## 本機執行

```bash
npm install
npm start
# 開 http://localhost:8080
```

## 推上 GitHub(樞紐步驟)

GitHub repo 是中樞:Claude Code、Zeabur、你的 Mac 都連到它。

```bash
cd twstock-zeabur
git init
git add .
git commit -m "init: 台股開盤溢價追蹤 Zeabur 版"
# 在 GitHub 開一個新的空 repo,取得網址後:
git remote add origin https://github.com/<你的帳號>/<repo名>.git
git branch -M main
git push -u origin main
```

## 連 Claude Code(App 左上的 Code 分頁)

App → Code 分頁 → 連結上面這個 GitHub repo。
之後就能在 Code 分頁裡請 Claude Code 修改此專案,改完自動 commit / push。

## 部署到 Zeabur

1. 登入 https://zeabur.com
2. New Project → Deploy from GitHub → 選同一個 repo
3. Zeabur 偵測到 package.json,自動以 `npm start` 啟動
4. 在 Networking 設定產生網域,即得公開網址

之後每次 push 到 GitHub,Zeabur 會自動重新部署。

## iPhone 主畫面

Safari 開 Zeabur 網址 → 分享 → 加入主畫面,即可像 App 一樣使用。

## 兩顆按鈕

- 「複製 LINE 版面」:一鍵複製卡片文字,貼到 LINE / FB / IG
- 「打包給 AI 點評」:複製整理好的資料 + 提問句,貼到 Claude / Gemini App
  取得走勢點評(用 App 內 AI,不另外花 token)

## 可靠性與安全性

- 前端所有把後端字串塞 `innerHTML` 的位置都先過 `esc()`,錯誤訊息直接走 `textContent`,
  避免使用者輸入(代號/名稱)的反射型 XSS。
- 後端對 TWSE / TPEX / Yahoo / mis.tpex 的 fetch 都包 `AbortController`,
  上游懸住時 8–10 秒 timeout,避免 Express handler 卡死整個服務。
- `server.js` 監聽 `error` 事件,`EADDRINUSE` 時印友善訊息並 exit,而非 stack trace。
- 錯誤回應**故意**以 HTTP 200 + `body.error` 回傳(前後端契約),不要改成 4xx。

## 維護筆記

### 上市/上櫃(`twstock-core.js`)

- 個股清單:openapi.twse.com.tw、tpex.org.tw/openapi
- 盤中即時:mis.twse.com.tw
- 歷史日線:twse.com.tw STOCK_DAY、tpex.org.tw 的 tradingStock
- 成交量單位:TWSE 給「股數」需 ÷1000;TPEX 給「張數」直接用
  (見 parseDailyRow 函式)

### 興櫃(`emerging/data.js`)

- 真即時:`mis.tpex.org.tw/Quote.asmx/GETQ20`(POST form-encoded,回 XML,含完整自營商五檔)
- 名稱查詢:`tpex.org.tw/openapi/v1/tpex_esb_latest_statistics`(只用來代號↔名稱)
- 歷史日線:Yahoo Finance `query1.finance.yahoo.com/v7/finance/chart/{code}.TWO?range=1y`
- **Yahoo 反限流陷阱**:必須用最短 UA `Mozilla/5.0`,完整 Chrome UA 會被限流
- **0 → null 處理**:mis.tpex 對「今日尚未成交」欄位回 0,前端會誤判為跌停,
  `parseRealtimeXml` 的 `z2n` helper 統一轉 null
- 為何不用 TPEX 興櫃歷史端點:它完全忽略 date 參數,任何月份都回最近 ~15 天

詳見 `CLAUDE.md` 的「興櫃子模組」段。

本工具僅作資料整理與呈現,不構成投資建議。
