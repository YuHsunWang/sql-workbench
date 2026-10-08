import { DatabaseSync } from 'node:sqlite';
import { loadApp, graphFromSQL } from '../loader.mjs';

let seed = 0x5eed1234;
function random(max) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; }
const pick = xs => xs[random(xs.length)];
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE customers (id INTEGER PRIMARY KEY, city TEXT, tier TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount INTEGER, qty INTEGER, status TEXT, note TEXT);
CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER, paid INTEGER);
INSERT INTO customers VALUES (1,'Taipei','gold'),(2,'Taichung','silver'),(3,'Taipei',NULL),(4,NULL,'gold'),(5,'Tainan','silver');
INSERT INTO orders VALUES (1,1,10,1,'new',NULL),(2,1,20,2,'paid','rush'),(3,2,20,3,'paid',NULL),(4,3,40,1,'new','gift'),(5,4,NULL,2,'void',NULL),(6,9,60,4,'paid','rush'),(7,2,10,3,'new','gift'),(8,NULL,30,1,NULL,NULL);
INSERT INTO payments VALUES (1,1,10),(2,2,20),(3,3,5),(4,3,15),(5,7,NULL);
`);
const api = loadApp();
api.state.dialect = 'postgres';
api.state.schema = Object.fromEntries(Object.entries({customers:['id','city','tier'],orders:['id','customer_id','amount','qty','status','note'],payments:['id','order_id','paid']}).map(([name, cols]) => [name,{cols:cols.map(name=>({name})),rows:[]}]));

// Sixteen fixed-seed variants per family; the shortest failing one is reported.
const families = {
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
unsupported_in_subquery: () => `SELECT id FROM orders WHERE id IN (SELECT order_id FROM payments WHERE paid >= ${pick([0,10,20])})`,
unsupported_count_distinct: () => `SELECT COUNT(DISTINCT ${pick(['status','qty'])}) AS n FROM orders`,
};
const stable = JSON.stringify;
function query(sql, ordered) {
  const stmt = db.prepare(sql), columns = stmt.columns().map(c=>c.name);
  const rows = stmt.all().map(row=>columns.map(c=>row[c]));
  if (!ordered) rows.sort((a,b)=>stable(a).localeCompare(stable(b)));
  return {columns,rows};
}
function diff(a,b) {
  const ix = a.rows.findIndex((row,i)=>stable(row)!==stable(b.rows[i]));
  return `columns ${stable(a.columns)} vs ${stable(b.columns)}; row counts ${a.rows.length} vs ${b.rows.length}; first row ${stable(a.rows[ix<0?0:ix]??null)} vs ${stable(b.rows[ix<0?0:ix]??null)}`;
}
const norm = sql => sql.replace(/\s+/g,' ').trim().replace(/;$/,'');
const counts = {total:0,identical_result:0,different_result:0,regenerated_sql_fails:0,parse_unsupported:0,textual_identical:0};
const unsupported = {}, classes = new Map(), inputs = new Set();
for (const [category, make] of Object.entries(families)) for (let i=0;i<16;i++) {
  const base=make(i);
  const sql=category==='order_limit' ? base.replace(/LIMIT \d+/,`LIMIT ${i+1}`) : `${base} LIMIT ${i+1}`;
  const ordered=/\bORDER\s+BY\b/i.test(sql);
  inputs.add(sql);
  counts.total++;
  const original=query(sql,ordered); // Invalid generated input is a harness bug.
  let regenerated;
  try { graphFromSQL(api,sql); regenerated=api.buildSQL(); }
  catch (error) { if (!error?.sqlErr) throw error; counts.parse_unsupported++; unsupported[category]=(unsupported[category]||0)+1; continue; }
  if (norm(sql)===norm(regenerated)) counts.textual_identical++;
  let actual, failure;
  try { actual=query(regenerated,ordered); }
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
for (const [key,x] of classes) console.log(`CLASS ${key}\n  minimal: ${x.sql}\n  original: ${x.sql}\n  regenerated: ${x.regenerated.replace(/\s+/g,' ').trim()}\n  diff: ${x.diff}\n  suspected: ${x.location||'unclassified'}`);
if (counts.total!==Object.keys(families).length*16 || inputs.size<300 ||
    counts.total!==counts.identical_result+counts.different_result+counts.regenerated_sql_fails+counts.parse_unsupported)
  throw new Error('case count or uniqueness invariant failed');
// A round trip that changes the result or writes SQL that will not run is the defect this suite exists to catch.
if (counts.different_result || counts.regenerated_sql_fails)
  throw new Error(`round trip broke: ${counts.different_result} different, ${counts.regenerated_sql_fails} failing (see CLASS lines)`);
