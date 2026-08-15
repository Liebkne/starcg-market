# 即時搜尋 Worker

這個 Worker 的用途只有一個：

1. 使用者在 GitHub Pages 輸入關鍵字。
2. Worker 讀取 StarCG 原始 `market.php`，自動辨識「搜尋名字」欄位的 form 參數。
3. 把使用者關鍵字提交給 StarCG 原始搜尋。
4. 解析「原始搜尋結果」並回傳 JSON 給 GitHub Pages。
5. 如果原站的關鍵字結果本身有下一頁，只追該搜尋結果的下一頁，**不掃描整個市場 100 多頁**。

## 最簡單部署方式

需要一個免費 Cloudflare 帳號。

### 方法 A：Cloudflare 網頁介面

1. Cloudflare → Workers & Pages → Create → Worker。
2. 把 `worker.js` 全部貼進去。
3. Deploy。
4. 取得類似：
   `https://starcg-market-search.xxxxx.workers.dev`
5. 回 GitHub repository 編輯根目錄 `config.js`：
   ```js
   window.STARCG_API = "https://starcg-market-search.xxxxx.workers.dev";
   ```
6. Commit。GitHub Pages 重新部署後即可使用。

### 方法 B：wrangler

```bash
cd worker
npx wrangler login
npx wrangler deploy
```

然後把顯示的 workers.dev 網址填入 `config.js`。

## 為什麼需要 Worker？

GitHub Pages 是純靜態網頁。瀏覽器的同源政策通常不允許 JavaScript 直接讀取另一個網域
`member.starcg.net` 的 HTML。因此需要 Worker 代替瀏覽器發出搜尋請求。

Worker 不保存市場資料，也不定時爬市場。
