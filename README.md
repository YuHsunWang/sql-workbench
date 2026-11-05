# SQL 工作台

貼上 AI 寫的 SQL，將查詢看成可編輯的步驟，搭配範例列預覽；修改步驟後，再產生 SQL。支援 MySQL、PostgreSQL、SQL Server 與 Oracle 四種方言。

直接用瀏覽器開啟 `sql-blocks.html`，不需安裝。內建學生、老師、課程與成績資料表；所有範例列都是編造的示意資料，並非資料庫的實際查詢結果。

- **三邊連動**：點畫布上的步驟，逐步檢視跳到那一站、SQL 標出它寫的那一段；滑過 SQL 的一段，畫布亮起對應的步驟。每個步驟標出示意資料進出幾列，一對多的 JOIN 會標紅。
- **AI SQL 健檢**：找出語法正確、跑得動但意思錯的常見寫法——LEFT JOIN 被 WHERE 變成 INNER、一對多 JOIN 後重複加總、LEFT JOIN 後 `COUNT(*)`、`NOT IN` 遇到 NULL、整數相除、沒排序取前 N 筆、`ROW_NUMBER` 同分。只檢查這幾種，沒找到不代表查詢正確。
- **邊界資料**：每張表多加 NULL 列、對照值重複的列、配不到的列，上面這些問題才會在預覽裡現形。
- **復原／自動保存／分享**：`Ctrl+Z` / `Ctrl+Shift+Z` 復原重做；重新整理畫布還在；「分享連結」把整張畫布壓進網址，不經過任何伺服器。

使用支援 `node:sqlite` 的 Node.js 執行測試：

```sh
node tests/run.mjs
node tests/roundtrip-fuzz/run.mjs
```

授權：MIT，Copyright (c) 2026 YuHsunWang。詳見 [LICENSE](LICENSE)。
