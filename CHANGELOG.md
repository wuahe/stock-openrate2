# 更新說明

## 2026-05-27

聚焦在「今日列穩定性」與「Yahoo Finance 切換為盤中主源」兩條主線,以及一輪 review findings 收尾。

### 今日列穩定性(主軸)

- **表格補上「今天」這列**:盤中或當日歷史尚未發佈時,用 intraday 合成今日列接到最前面。
- **`quoteDate` 欄位**:後端標記報價屬於哪一天,只在「報價日期 = 台北今天」才補今日列,避免上游延遲快照被誤標。
- **條件改成「有開盤+昨收+今日標記」**:不再卡 `hasQuote`,mis.twse `z` 短暫為 null 時今日列也照樣顯示。
- **大方塊與表格列同步**:`render` 內大方塊條件改成跟 `withTodayRow` 一致,UI 不再忽大忽小。
- **漲跌%與收盤兜底一致**:close 用 high 兜底時,changePct 也用同一個 close 重算,避免「收盤有值、漲跌%『—』」的視覺矛盾。
- **`INTRADAY_CACHE` 5 分鐘 stale-while-error**:兩個上游都短暫失敗時沿用最近一次成功資料,標 `stale: true`。

### 資料源切換

- **盤中即時主源改 Yahoo Finance** (`query1.finance.yahoo.com/v7/finance/chart/{code}.TW(.TWO)`),比 mis.twse 穩定。
- **mis.twse 退為備援**:Yahoo 不完整或當日 bar 未滾出時才用。
- **漲跌停價本地計算**:Yahoo 不給 limit prices,改按 `prev × 10% + tick rounding` 算。

### 興櫃容錯強化

- **重試 + jitter**:`httpJson` retry delay 加 0.5x–1.5x 隨機抖動;`fetchYahooDaily` retries 2 → 4,撐過 Yahoo 短期 burst limit。
- **Stale-while-error**:Yahoo 連續 5 次失敗時退回 24 小時內舊快取,回 `dailyStale` / `dailyStaleAgeMs` 給前端顯示「⚠ 歷史日線為 N 小時前快取」。
- **日期改用台北時區**:`emerging/data.js` 改用 `twDateFromMs()`,避免 Zeabur 容器 TZ 偏移造成日期錯位。

### UI 一致性

- **LINE / AI 複製補今日列**:盤中區塊條件與畫面同步,z 為空時複製出去也帶今日資訊。
- **興櫃天數切換 bug**:輸入框清空時 fallback 用 `lastData.stock.code`(與主頁邏輯一致)。
- **興櫃 loading spinner**:複用主頁 `.spin` 動畫。
- **HTML `Cache-Control: no-store`**:部署後立即生效,不用強制重整。

### 路由與安全

- **移除 `Access-Control-Allow-Origin: *`**:兩個 API 都同源使用,沒理由開放跨域。
- **刪 emerging/router.js 重複的 static mount**:`express.static("public")` 已涵蓋。
- **興櫃 SPA fallback**:`/emerging/xyz` 不存在子路徑停在興櫃頁,不被主站 `*` 拉回上市櫃首頁。
- **`fetchDaily` 加 15 秒整體 deadline**:最壞情況原本 5 個月份 × 10s = 50s,改成超過預算就 break,handler 不再卡死。

### 文件

- CLAUDE.md 加入 Yahoo 反限流(短 UA)、浮點雜訊、偶爾缺天、漲跌停本地計算等陷阱。
