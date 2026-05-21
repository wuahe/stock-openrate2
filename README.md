# 台股開盤溢價追蹤 — Zeabur 版

查詢台股(上市/上櫃)個股近 N 日的開盤溢價%、漲跌%、收盤與成交量,
附盤中即時報價,輸出 LINE 友善版面。零 AI、零金鑰。
資料來源:TWSE / TPEX 官方公開端點。

## 專案結構

```
twstock-zeabur/
├── server.js          Express 伺服器(提供網頁 + /api/stock)
├── twstock-core.js    抓 TWSE/TPEX 資料的核心邏輯
├── package.json       相依套件(express)
├── .gitignore
└── public/
    └── index.html     前端頁面
```

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

## 維護筆記

抓取邏輯全在 `twstock-core.js`。若 TWSE/TPEX 改版:
- 個股清單:openapi.twse.com.tw、tpex.org.tw/openapi
- 盤中即時:mis.twse.com.tw
- 歷史日線:twse.com.tw STOCK_DAY、tpex.org.tw 的 tradingStock
- 成交量單位:TWSE 給「股數」需 ÷1000;TPEX 給「張數」直接用
  (見 parseDailyRow 函式)

本工具僅作資料整理與呈現,不構成投資建議。
