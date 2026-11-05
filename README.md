# SQL 工作台

貼上 AI 寫的 SQL，將查詢看成可編輯的步驟，搭配範例列預覽；修改步驟後，再產生 SQL。支援 MySQL、PostgreSQL、SQL Server 與 Oracle 四種方言。

直接用瀏覽器開啟 `sql-blocks.html`，不需安裝。內建學生、老師、課程與成績資料表；範例列都是編造的示意資料，並非資料庫的實際查詢結果。

- **看得懂 AI 常寫的 SQL**：多層算式與函式（`price * qty * (1 - d)`、`UPPER(TRIM(x))`、`||`）、條件裡的函式（`YEAR(d) = 2024`、`>= CURRENT_DATE - INTERVAL '30 days'`）、各種 CASE、`ROUND(AVG(x), 2)`、`SUM(CASE …) * 1.0 / COUNT(*)`、`LAG(x) OVER (…)` 同期比較、`ROWS BETWEEN 6 PRECEDING AND CURRENT ROW` 移動平均、`NTILE(4)` 分組、`x > (SELECT AVG(x) FROM t)` 跟整體比、`FULL JOIN`、`ON o.d BETWEEN p.start AND p.end` 這種範圍 JOIN。拆不成步驟的寫法一律拒絕並指出位置，不會偷偷改掉意思。
- **三邊連動**：點畫布上的步驟，逐步檢視跳到那一站、SQL 標出它寫的那一段；滑過 SQL 的一段，畫布亮起對應的步驟。每個步驟標出示意資料進出幾列，一對多的 JOIN 會標紅。
- **三種輸出格式＋差異比對**：「一步一段」每個步驟一段 CTE，方便對照；「精簡」把能合併的步驟摺回同一層 SELECT，貼回專案用（篩選不會跨過 GROUP BY、LIMIT 或視窗函數往前併）；「pipe」是 BigQuery 的 pipe syntax，一步一行。改過步驟之後，「跟原本貼的 SQL 比一比」逐行列出哪裡不一樣、是哪一步改的。
- **AI SQL 健檢**：找出語法正確、跑得動但意思錯的常見寫法——LEFT JOIN 被 WHERE 變成 INNER、一對多 JOIN 後重複加總、LEFT JOIN 後 `COUNT(*)`、`NOT IN` 遇到 NULL、整數相除、沒排序取前 N 筆、`ROW_NUMBER` / `NTILE` / `LAG` / `LEAD` 遇到同分。只檢查這幾種，沒找到不代表查詢正確。
- **你的資料表**：貼 `CREATE TABLE`，欄位說明（MySQL `COMMENT '學生姓名'`、PostgreSQL `COMMENT ON COLUMN`、SQL Server `sp_addextendedproperty`）會顯示在欄名旁邊，產生的 SQL 仍用原本的欄名；也可以在資料庫跑一段「列出所有欄位」的查詢（工具裡有四種方言的版本），把結果整片貼回來一次建好所有表。貼上 CSV 則直接當一張表、用你的資料預覽（最多 200 列，只留在瀏覽器，不上傳）；畫面會標明哪些表是你的資料、哪些是編的。
- **邊界資料**：每張示意資料表多加 NULL 列、對照值重複的列、配不到的列，上面這些問題才會在預覽裡現形。
- **復原／自動保存／分享**：`Ctrl+Z` / `Ctrl+Shift+Z` 復原重做；重新整理畫布還在；「分享連結」把整張畫布壓進網址，不經過任何伺服器。

使用支援 `node:sqlite` 的 Node.js 執行測試：

```sh
node tests/run.mjs
node tests/roundtrip-fuzz/run.mjs
```

授權：MIT，Copyright (c) 2026 YuHsunWang。詳見 [LICENSE](LICENSE)。
