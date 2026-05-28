# 台股開盤溢價追蹤

一個免金鑰、可自行部署的台股資料整理小工具。輸入股票名稱或代號後,可以查詢
上市/上櫃個股近 N 日的開盤溢價%、漲跌%、收盤價、成交量,並附上盤中即時行情與
Yahoo 股價連結,方便快速複製到 LINE 或交給 AI App 做後續整理。

> 本工具僅作公開資料整理與呈現,不構成投資建議。

## 功能特色

- **上市/上櫃追蹤**:開盤溢價%、收盤漲跌%、收盤價、成交量與盤中即時行情。
- **興櫃追蹤**:因興櫃為議價市場,不計開盤溢價,改追收盤漲跌%、量比與買賣價差。
- **快速分享**:一鍵複製 LINE 版面,或打包成適合貼到 Claude / Gemini App 的文字。
- **零後端金鑰**:資料取自公開端點,不需要申請 API key。
- **可自行部署**:Node.js + Express,適合部署到 Zeabur、Render、Fly.io 或自己的主機。
- **GitHub 開源友善**:結構簡單、依賴少,方便 fork、修改與部署。

## Demo 與截圖

若你已部署到 Zeabur 或其他平台,可在本段補上公開網址。建議也可以加上一張首頁截圖,
讓訪客一眼看懂畫面與用途。

## 資料來源

| 用途 | 來源 |
|---|---|
| 上市個股清單 | TWSE 官方公開端點 |
| 上櫃個股清單 | TPEX 官方公開端點 |
| 上市/上櫃歷史日線 | TWSE / TPEX 官方公開端點 |
| 上市/上櫃盤中行情 | Yahoo Finance,必要時 fallback 到 TWSE mis |
| 興櫃即時行情 | TPEX mis.tpex GETQ20 |
| 興櫃歷史日線 | Yahoo Finance |

外部公開端點可能因限流、維護、欄位調整而暫時失效。本專案已加入 timeout、快取與部分
fallback,但不保證資料即時性或完整性。

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

## 快速開始

```bash
git clone https://github.com/wuahe/stock-openrate2.git
cd stock-openrate2
npm install
npm start
# 開 http://localhost:8080
```

需求:

- Node.js 18 或更新版本
- npm

## API 範例

上市/上櫃:

```bash
curl "http://localhost:8080/api/stock?q=2330&days=10"
curl "http://localhost:8080/api/stock?q=健亞&days=20"
```

興櫃:

```bash
curl "http://localhost:8080/api/emerging?q=7832&days=30"
```

錯誤回應仍使用 HTTP 200,並在 JSON body 放入 `error` 欄位。這是前後端既有契約。

## 部署到 Zeabur

1. Fork 或 clone 本專案到自己的 GitHub 帳號。
2. 登入 https://zeabur.com
3. New Project → Deploy from GitHub → 選擇這個 repo
4. Zeabur 偵測到 `package.json`,自動以 `npm start` 啟動
5. 在 Networking 設定產生網域,即得公開網址

之後每次 push 到 GitHub,Zeabur 會自動重新部署。

## 開源使用

歡迎 fork 後依自己的需求調整,例如:

- 更換快捷股票清單
- 調整追蹤天數
- 改成自己的部署平台
- 增加更多資料欄位或視覺化圖表
- 改寫成其他前端框架版本

若要正式作為開源專案發布,建議在 repo 內新增 `LICENSE` 檔案。常見選擇是 MIT License,
方便他人使用、修改與再散布；若你希望限制商業使用,則應改選其他授權。

## 貢獻方式

歡迎開 issue 或 pull request。送 PR 前建議先確認:

- 不要加入任何私人金鑰、cookie 或個人帳號資料。
- 外部資料源欄位若有變動,請在 PR 說明中附上來源與測試方式。
- 修改資料計算邏輯時,請同步更新 README 或 `CLAUDE.md` 的維護筆記。
- 保留「不構成投資建議」的免責說明。

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
- 歷史日線以「月份」為快取單位保留 10 分鐘,重複查同一檔股票會少打官方端點
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
