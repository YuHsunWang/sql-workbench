import { DatabaseSync } from 'node:sqlite';
import { loadApp, graphFromSQL } from '../loader.mjs';

let seed = 0x5eed1234;
function random(max) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }
const pick = xs => xs[random(xs.length)];
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE customers (id INTEGER PRIMARY KEY, city TEXT, tier TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER, qty INTEGER, status TEXT, note TEXT);
CREATE TABLE date_sales (id INTEGER PRIMARY KEY, sale_date TEXT, cutoff_date TEXT);
CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER, paid INTEGER);
INSERT INTO date_sales VALUES (1,'2025-12-31','2026-01-01'),(2,'2026-01-01','2026-01-01'),(3,'2026-01-15','2026-02-01'),(4,'2026-02-01','2026-01-01'),(5,NULL,'2026-01-01'),(6,'2026-01-01',NULL),(7,NULL,NULL),(8,'2024-02-29','2026-01-01');
INSERT INTO customers VALUES (1,'Taipei','gold'),(2,'Taichung','silver'),(3,'Taipei',NULL),(4,NULL,'gold'),(5,'Tainan','silver');
INSERT INTO orders VALUES (1,1,10,1,'new',NULL),(2,1,20,2,'paid','rush'),(3,2,20,3,'paid',NULL),(4,3,40,1,'new','gift'),(5,4,NULL,2,'void',NULL),(6,9,60,4,'paid','rush'),(7,2,10,3,'new','gift'),(8,NULL,30,1,NULL,NULL);
INSERT INTO orders VALUES (9,3,NULL,NULL,'new',NULL),(10,3,20,0,'paid',NULL),(11,4,10,-1,'void',NULL);
INSERT INTO payments VALUES (1,1,10),(2,2,20),(3,3,5),(4,3,15),(5,7,NULL),(6,2,20);
`);
const api = loadApp();
api.state.dialect = 'postgres';
api.state.schema = Object.fromEntries(Object.entries({customers:['id','city','tier'],orders:['id','customer_id','amount','qty','status','note'],payments:['id','order_id','paid'],date_sales:['id','sale_date','cutoff_date']}).map(([name, cols]) => [name,{cols:cols.map(name=>({name})),rows:[]}]));

// Sixteen fixed-seed variants per family; the shortest failing one is reported.
const families = {
// Date families use real ISO dates and NULLs; CAST and ANSI literals must retain their type.
filter_date: i => `SELECT id FROM date_sales WHERE sale_date ${pick(['=','<>','>','>=','<','<='])} ${i%2 ? "DATE '2026-01-01'" : "CAST('2026-01-01' AS DATE)"}`,
filter_date_between: i => `SELECT id FROM date_sales WHERE sale_date ${i%2?'NOT ':''}BETWEEN DATE '${pick(['2025-12-31','2026-01-01'])}' AND CAST('2026-02-01' AS DATE)`,
filter_date_or: i => `SELECT id FROM date_sales WHERE sale_date < DATE '2026-01-01' OR (sale_date >= CAST('2026-02-01' AS DATE) AND id > ${i%4})`,
filter_date_in: i => `SELECT id FROM date_sales WHERE sale_date ${i%2?'NOT ':''}IN (DATE '2026-01-01', CAST('${pick(['2025-12-31','2026-02-01'])}' AS DATE))`,
// Per-row operands include NULL on either side, equality, inequality and grouped predicates.
filter_column: i => `SELECT id FROM orders WHERE amount ${pick(['=','<>','>','>=','<','<='])} qty${i%2?' OR qty > id':''}`,
filter_date_column: i => `SELECT id FROM date_sales WHERE sale_date ${pick(['=','<>','>','>=','<','<='])} cutoff_date${i%2?' AND id > 1':''}`,
projection: i => `SELECT ${pick(['id','amount','qty'])} FROM orders${i%3?' WHERE id > '+pick([0,2,5]):''}`,
alias: i => `SELECT ${pick(['amount','qty','status'])} AS ${pick(['v','value'])} FROM orders${i%2?' WHERE id < 5':''}`,
arithmetic: i => `SELECT amount ${pick(['+','-','*'])} ${pick([1,2,3])} AS v FROM orders${i%2?' WHERE id < 5':''}`,
function: i => `SELECT COALESCE(amount, ${pick([0,1,99])}) AS v FROM orders${i%2?' WHERE id < 5':''}`,
where_and_or: i => `SELECT id FROM orders WHERE amount >= ${pick([10,20,30])} ${i%2?'AND':'OR'} qty <= ${pick([1,2,3])}`,
where_nested: i => `SELECT id FROM orders WHERE (amount >= ${pick([10,20,30])} OR qty = ${pick([1,2])}) AND status IS NOT NULL`,
where_not: i => `SELECT id FROM orders WHERE NOT (amount >= ${pick([10,20,30])})`,
where_not_in: i => `SELECT id FROM orders WHERE status ${i%2?'NOT ':''}IN ('new','paid')`,
where_between: i => `SELECT id FROM orders WHERE amount ${i%2?'NOT ':''}BETWEEN ${pick([10,20])} AND ${pick([30,40])}`,
where_like: i => `SELECT id FROM orders WHERE status ${i%2?'NOT ':''}LIKE '${pick(['n%','p%','%d'])}'`,
where_null: i => `SELECT id FROM orders WHERE ${pick(['amount','note','status'])} IS ${i%2?'NOT ':''}NULL`,
inner_join: i => `SELECT o.id, c.city FROM orders AS o INNER JOIN customers AS c ON o.customer_id = c.id${i%2?' WHERE o.amount >= 20':''}`,
left_join: i => `SELECT o.id, c.city FROM orders AS o LEFT JOIN customers AS c ON o.customer_id = c.id${i%2?' WHERE c.city IS NULL':''}`,
multi_join: i => `SELECT o.id, c.city, p.paid FROM orders AS o ${i%2?'LEFT':'INNER'} JOIN customers AS c ON o.customer_id = c.id LEFT JOIN payments AS p ON o.id = p.order_id`,
group: () => `SELECT customer_id, ${pick(['COUNT(*) AS n','SUM(amount) AS n','AVG(amount) AS n'])} FROM orders GROUP BY customer_id`,
having: () => `SELECT customer_id, COUNT(*) AS n FROM orders GROUP BY customer_id HAVING COUNT(*) ${pick(['>','>='])} ${pick([1,2,3])}`,
order_limit: i => `SELECT id, amount FROM orders ORDER BY amount ${i%2?'DESC':'ASC'}, id ASC LIMIT ${pick([2,3,5])}${i%3?' OFFSET 1':''}`,
distinct: i => `SELECT DISTINCT ${pick(['status','customer_id','qty'])} FROM orders${i%2?' WHERE id > 2':''}`,
case: i => `SELECT CASE WHEN amount >= ${pick([10,20,30])} THEN 'high' ELSE 'low' END AS bucket FROM orders${i%2?' WHERE id < 5':''}`,
cte: i => `WITH x AS (SELECT id, amount FROM orders WHERE amount >= ${pick([10,20,30])}) SELECT id FROM x${i%2?' ORDER BY id':''}`,
union: i => `SELECT id FROM orders WHERE amount < ${pick([20,30])} UNION ${i%2?'ALL ':''}SELECT id FROM orders WHERE qty > ${pick([1,2])}`,
subquery: i => `SELECT id FROM (SELECT id, amount FROM orders WHERE amount >= ${pick([10,20])}) AS x${i%2?' WHERE amount < 40':''}`,
// NULL as a literal turned into the text 'null' twice (PR #4 WHERE, af7a840 CASE); every place it can sit is covered here.
null_compare: i => `SELECT id FROM orders WHERE ${pick(['note','status','amount'])} ${i%2?'=':'<>'} NULL`,
null_in: i => `SELECT id FROM orders WHERE status ${i%2?'NOT ':''}IN ('new', NULL)`,
null_case: i => `SELECT id, CASE WHEN amount >= ${pick([10,20,30])} THEN ${i%2?"'high' ELSE NULL":"NULL ELSE 'low'"} END AS bucket FROM orders`,
null_case_no_else: () => `SELECT id, CASE WHEN amount >= ${pick([10,20,30])} THEN 'high' END AS bucket FROM orders`,
null_literal: i => `SELECT id, NULL AS ${pick(['x','missing'])} FROM orders${i%2?' WHERE id < 5':''}`,
// Nullable outer/lookup values and duplicate paid values distinguish semi-joins from joins.
semi_in: i => `SELECT o.id FROM orders o WHERE o.amount IN (SELECT p.paid FROM payments p${i%2?' WHERE p.paid >= '+pick([0,10,20]):''})${i%3?' AND o.id > 1':''}`,
semi_not_in: i => `SELECT o.id FROM orders o WHERE o.amount NOT IN (SELECT p.paid FROM payments p${i%2?' WHERE p.paid IS NOT NULL':''})`,
semi_exists: i => `SELECT o.id FROM orders o WHERE EXISTS (SELECT 1 FROM payments p WHERE p.paid=o.amount${i%2?' AND p.order_id=o.id':''} AND p.id > ${i%4})`,
semi_not_exists: i => `SELECT o.id FROM orders o WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.paid=o.amount${i%2?' AND p.order_id=o.id':''} AND p.id > ${i%4})`,
// These must execute, not become parse_unsupported: NULLs and duplicates distinguish COUNT from COUNT(DISTINCT).
count_distinct: i => `SELECT ${i%2?'customer_id, ':''}COUNT(DISTINCT ${pick(['status','qty','amount'])}) AS n FROM orders${i%2?' GROUP BY customer_id':''}`,
case_column: i => `SELECT id, CASE WHEN qty > ${pick([0,1,2])} THEN amount${i%2?' ELSE qty':''} END AS v FROM orders`,
// Every operator covers column/literal THEN, absent/explicit ELSE, and NULL input values.
...Object.fromEntries(['SUM','COUNT','AVG','MIN','MAX'].map(fn=>['agg_case_'+fn.toLowerCase(), i =>
  `SELECT customer_id, ${fn}(CASE WHEN qty > ${pick([0,1,2])} THEN ${i%4<2?'amount':pick([0,1,7])}${i%2?' ELSE '+(i%3?'0':'qty'):''} END) AS n FROM orders GROUP BY customer_id`])),
agg_case_multiple: i => `SELECT customer_id, SUM(CASE WHEN qty > ${i%3} THEN amount END) AS total, COUNT(CASE WHEN qty > 0 THEN ${i%2?'amount':'1'} ELSE NULL END) AS n FROM orders GROUP BY customer_id`,
agg_case_collision: i => `SELECT SUM(CASE WHEN qty > ${i%3} THEN case_value${i%2?' ELSE 0':''} END) AS total FROM (SELECT qty, amount AS case_value FROM orders) AS x`,
// Aggregate expressions must resolve to selected aliases in every ORDER BY key.
count_distinct_order: i => `SELECT customer_id, COUNT(DISTINCT amount) AS n FROM orders GROUP BY customer_id ORDER BY ${i%2?'customer_id ASC, ':''}COUNT(DISTINCT amount) ${i%3?'DESC':'ASC'}${i%2?'':', customer_id ASC'}`,
aggregate_order: i => `SELECT customer_id, ${pick(['SUM(amount)','COUNT(*)','AVG(qty)'])} AS n FROM orders GROUP BY customer_id ORDER BY n ${i%2?'DESC':'ASC'}, customer_id ASC`,
aggregate_order_expression: i => { const expr=pick(['SUM(amount)','COUNT(*)','AVG(qty)']); return `SELECT customer_id, ${expr} AS n FROM orders GROUP BY customer_id ORDER BY ${expr} ${i%2?'DESC':'ASC'}, customer_id ASC`; },
agg_case_order: i => { const expr=`SUM(CASE WHEN qty > ${i%3} THEN amount ELSE 0 END)`; return `SELECT customer_id, ${expr} AS n FROM orders GROUP BY customer_id ORDER BY ${i%2?'customer_id ASC, ':''}${expr} DESC${i%2?'':', customer_id ASC'}`; },
// Grouping by the CASE must reference its own existing helper, including the second helper.
agg_case_group_expression: i => { const expr=`CASE WHEN qty > ${i%3} THEN amount ELSE 0 END`; return `SELECT SUM(${expr}) AS n FROM orders GROUP BY ${expr}`; },
agg_case_group_second: i => { const expr=`CASE WHEN qty = ${i%3} THEN amount END`; return `SELECT SUM(CASE WHEN qty > 0 THEN amount END) AS a, SUM(${expr}) AS b FROM orders GROUP BY ${expr}`; },
// Default names for unaliased aggregates are generated identifiers; position and arity must survive.
count_distinct_unaliased: i => `SELECT COUNT(DISTINCT amount), COUNT(DISTINCT ${i%2?'qty':'status'}) FROM orders ORDER BY COUNT(DISTINCT amount)`,
// Unsupported expressions and colliding outputs must fail explicitly, never emit broken SQL or lose a column.
unsupported_aggregate_order: i => `SELECT customer_id FROM orders GROUP BY customer_id ORDER BY ${i%2?'customer_id, ':''}${pick(['COUNT(DISTINCT amount)','SUM(amount)','SUM(CASE WHEN qty > 0 THEN amount END)'])}`,
unsupported_case_group: i => `SELECT SUM(CASE WHEN qty > ${i%3} THEN amount ELSE 0 END) AS n FROM orders GROUP BY CASE WHEN qty = 0 THEN amount ELSE 0 END`,
unsupported_aggregate_collision: i => `SELECT SUM(CASE WHEN qty > ${i%3} THEN amount END)${i%2?' AS n':''}, SUM(CASE WHEN qty = 0 THEN amount END)${i%2?' AS n':''} FROM orders`,
};
const stable = JSON.stringify;
function query(sql, ordered, unnamed = false) {
  // SQLite has no ANSI DATE literal, and CAST(... AS DATE) yields a year number.
  // Adapt only fixed ISO literals on both sides of the round trip to SQLite date().
  const sqliteSQL = sql.replace(/DATE\s*'(\d{4}-\d{2}-\d{2})'/gi, "date('$1')")
    .replace(/CAST\('(\d{4}-\d{2}-\d{2})' AS DATE\)/gi, "date('$1')");
  const stmt = db.prepare(sqliteSQL), columns = stmt.columns().map(c=>c.name);
  const rows = stmt.all().map(row=>columns.map(c=>row[c]));
  if (!ordered) rows.sort((a,b)=>stable(a).localeCompare(stable(b)));
  return {columns:unnamed ? columns.map((_,i)=>`output_${i}`) : columns,rows};
}
function diff(a,b) {
  const ix = a.rows.findIndex((row,i)=>stable(row)!==stable(b.rows[i]));
  return `columns ${stable(a.columns)} vs ${stable(b.columns)}; row counts ${a.rows.length} vs ${b.rows.length}; first row ${stable(a.rows[ix<0?0:ix]??null)} vs ${stable(b.rows[ix<0?0:ix]??null)}`;
}
const norm = sql => sql.replace(/\s+/g,' ').trim().replace(/;$/,'');
const counts = {total:0,identical_result:0,different_result:0,regenerated_sql_fails:0,parse_unsupported:0,textual_identical:0};
const unsupported = {}, classes = new Map(), inputs = new Set();
const mustExecute = new Set(Object.keys(families).filter(k=>k.startsWith('semi_') || k.startsWith('filter_') || k.startsWith('count_distinct') || k.startsWith('aggregate_order') || k === 'case_column' || k.startsWith('agg_case_')));
const mustRefuse = {
  unsupported_aggregate_order:/ORDER BY.*SELECT/,
  unsupported_case_group:/GROUP BY.*CASE/,
  unsupported_aggregate_collision:/彙總.*同名/,
};
for (const [category, make] of Object.entries(families)) for (let i=0;i<16;i++) {
  const base=make(i);
  const sql=category==='order_limit' ? base.replace(/LIMIT \d+/,`LIMIT ${i+1}`) : `${base} LIMIT ${i+1}`;
  const ordered=/\bORDER\s+BY\b/i.test(sql);
  inputs.add(sql);
  counts.total++;
  const unnamed=category==='count_distinct_unaliased';
  const original=query(sql,ordered,unnamed); // Invalid generated input is a harness bug.
  let regenerated;
  try { graphFromSQL(api,sql); regenerated=api.buildSQL(); }
  catch (error) {
    if (!error?.sqlErr) throw error;
    if (mustRefuse[category] && (!mustRefuse[category].test(error.msg) || !Number.isInteger(error.pos) || error.pos<0 || error.pos>sql.length))
      throw new Error(`unclear refusal for ${category}: ${JSON.stringify(error)}`);
    counts.parse_unsupported++; unsupported[category]=(unsupported[category]||0)+1; continue;
  }
  if (mustRefuse[category]) throw new Error(`unsafe shape was not refused: ${sql}`);
  if (norm(sql)===norm(regenerated)) counts.textual_identical++;
  let actual, failure;
  try { actual=query(regenerated,ordered,unnamed); }
  catch (error) { failure=error.message; counts.regenerated_sql_fails++; }
  if (!failure && stable(original)===stable(actual)) { counts.identical_result++; continue; }
  if (!failure) counts.different_result++;
  const kind=failure?'execution':stable(original.columns)!==stable(actual.columns)?'columns':'rows';
  const key=`${category}/${kind}`;
  const item={sql,regenerated,diff:failure?`original rows ${stable(original.rows.slice(0,4))}; regenerated: ${failure}`:diff(original,actual)};
  if (!classes.has(key)||sql.length<classes.get(key).sql.length) classes.set(key,item);
}
// Recheck simpler candidate inputs instead of merely calling the shortest random case minimal.
const reduced = {
  'alias/execution': {sql:'SELECT id x FROM orders', location:'sql-blocks.html:4222'},
  'having/execution': {sql:'SELECT COUNT(*) n FROM orders HAVING COUNT(*)>1', location:'sql-blocks.html:3997'},
};
for (const [key,{sql,location}] of Object.entries(reduced)) {
  if (!classes.has(key)) continue;
  const original=query(sql,false);
  graphFromSQL(api,sql);
  const regenerated=api.buildSQL();
  let failure;
  try { query(regenerated,false); } catch(error) { failure=error.message; }
  if (!failure) throw new Error(`reducer no longer reproduces ${key}`);
  classes.set(key,{sql,regenerated,diff:`original rows ${stable(original.rows.slice(0,4))}; regenerated: ${failure}`,location});
}
console.log('COUNTS '+stable(counts));
console.log('UNIQUE_INPUTS '+inputs.size);
console.log('UNSUPPORTED '+stable(unsupported));
console.log('NEW_FAMILIES '+[...mustExecute].join(', '));
if ([...mustExecute].some(k=>unsupported[k])) throw new Error('required families must execute in SQLite');
for (const [key,x] of classes) console.log(`CLASS ${key}\n  minimal: ${x.sql}\n  original: ${x.sql}\n  regenerated: ${x.regenerated.replace(/\s+/g,' ').trim()}\n  diff: ${x.diff}\n  suspected: ${x.location||'unclassified'}`);
if (counts.total!==Object.keys(families).length*16 || inputs.size<300 ||
    counts.total!==counts.identical_result+counts.different_result+counts.regenerated_sql_fails+counts.parse_unsupported)
  throw new Error('case count or uniqueness invariant failed');
// A round trip that changes the result or writes SQL that will not run is the defect this suite exists to catch.
if (counts.different_result || counts.regenerated_sql_fails)
  throw new Error(`round trip broke: ${counts.different_result} different, ${counts.regenerated_sql_fails} failing (see CLASS lines)`);
