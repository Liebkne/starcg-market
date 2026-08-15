# 星詠魔力市場攤位比價 v3 — 原站即時搜尋版

這一版已完全移除「頁數 / 掃描頁數」概念。

## 搜尋流程

```text
你輸入關鍵字
      ↓
GitHub Pages 前端
      ↓
Cloudflare Worker
      ↓
StarCG 原始 market.php「搜尋名字」
      ↓
原站回傳符合關鍵字的結果
      ↓
Worker 整理攤位資料
      ↓
前端依價格顯示
```

**不是：**

```text
從第 1 頁一路掃到第 116 頁
```

## 顯示內容

- 商品 / 寵物名稱
- S1 / S2 / S3
- 城市 / 地點
- 東 / 南座標
- 攤販名稱
- 攤位到期時間
- 🪙 金幣
- 💎 魔晶
- 總價排序
- 單價排序
- 最低價標示

## GitHub Pages

根目錄的：

- `index.html`
- `style.css`
- `app.js`
- `config.js`

就是 GitHub Pages 網站。

## 必須部署一次 Worker

請看 `worker/README.md`。

部署後，把 Worker 網址填入：

`config.js`

例如：

```js
window.STARCG_API = "https://starcg-market-search.example.workers.dev";
```

然後 GitHub Pages 就能即時搜尋。

## 原站搜尋結果有分頁怎麼辦？

只有在 **StarCG 自己搜尋「壽喜鍋」後，搜尋結果本身仍有下一頁** 時，
Worker 才會繼續抓那個「搜尋結果下一頁」。

這跟掃描整個 116 頁市場不同：
網站只讀 StarCG 已經篩選完成的關鍵字結果。
