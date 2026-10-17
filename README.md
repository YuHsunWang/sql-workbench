# SQL 工作台

貼上 AI 寫的 SQL，將查詢看成可編輯的步驟，搭配範例列預覽；修改步驟後，再產生 SQL。支援 MySQL、PostgreSQL、SQL Server 與 Oracle 四種方言。

直接用瀏覽器開啟 `sql-blocks.html`，不需安裝。內建學生、老師、課程與成績資料表；所有範例列都是編造的示意資料，並非資料庫的實際查詢結果。

使用支援 `node:sqlite` 的 Node.js 執行測試：

```sh
node tests/run.mjs
node tests/roundtrip-fuzz/run.mjs
```

授權：MIT，Copyright (c) 2026 YuHsunWang。詳見 [LICENSE](LICENSE)。
