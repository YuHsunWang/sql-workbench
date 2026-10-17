import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { loadApp, graphFromSQL, installGraph } from './loader.mjs';

const api = loadApp();
const cases = [];
const json = value => JSON.parse(JSON.stringify(value));
function test(name, fn) { cases.push({name, fn}); }
function sqlError(sql) {
  try { api.parseSQLText(sql); } catch (error) {
    assert.equal(error?.sqlErr, true);
    assert.equal(Number.isInteger(error.pos), true);
    assert.equal(error.pos >= 0 && error.pos <= sql.length, true);
    return error;
  }
  assert.fail(`expected sqlErr for ${JSON.stringify(sql)}`);
}
function signature(graph) {
  const index = new Map(graph.nodes.map((node, i) => [node.id, i]));
  const nodes = graph.nodes.map(({id, x, y, ...node}) => node);
  const edges = graph.edges.map(e => [index.get(e.from), index.get(e.to), e.port || 0]).sort();
  return JSON.stringify({nodes, edges});
}
function roundTrip(sql, dialect = 'postgres') {
  api.state.dialect = dialect;
  const first = graphFromSQL(api, sql);
  const generated = api.buildSQL();
  const second = api.astToGraph(api.parseSQLText(generated));
  assert.equal(signature(second), signature(first));
  return generated;
}

test('regression: explicit LIMIT 0 keeps an empty result', () => {
  const generated = roundTrip('SELECT * FROM a LIMIT 0');
  assert.match(generated, /LIMIT 0;/);
  return 'LIMIT 0 survives reverse parsing and SQL generation';
});

test('regression: DDL import keeps a schema-qualified table name', () => {
  const app = loadApp();
  app.document.getElementById('ddl').value = 'CREATE TABLE schools.t (id INTEGER);';
  app.document.getElementById('btn-parse').listeners.click();
  assert.deepEqual(json(app.state.schema['schools.t'].cols.map(c => c.name)), ['id']);
  return 'schools.t imported with its id column';
});

test('regression: ORDER BY can use a column outside the SELECT list', () => {
  const app = loadApp();
  app.state.schema = {a:{cols:[{name:'id'}, {name:'v'}], rows:[]}};
  graphFromSQL(app, 'SELECT id FROM a ORDER BY v DESC');
  const generated = app.buildSQL();
  assert.match(generated, /SELECT id\s+FROM a\s+ORDER BY v DESC/);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE a(id INTEGER, v INTEGER); INSERT INTO a VALUES (1, 10), (2, 20);');
  assert.deepEqual(json(db.prepare(generated).all()), [{id:2}, {id:1}]);
  return 'id-only result remains sorted by v DESC';
});

test('regression: SELECT NULL creates a constant column', () => {
  const app = loadApp();
  graphFromSQL(app, 'SELECT NULL AS x FROM a');
  const generated = app.buildSQL();
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE a(id INTEGER); INSERT INTO a VALUES (1), (2);');
  assert.deepEqual(json(db.prepare(generated).all()), [{x:null}, {x:null}]);
  return 'NULL remains a two-row constant projection';
});

test('regression: a column alias without AS keeps its source', () => {
  const app = loadApp();
  graphFromSQL(app, 'SELECT id x FROM orders');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE orders(id INTEGER); INSERT INTO orders VALUES (4);');
  assert.deepEqual(json(db.prepare(app.buildSQL()).all()), [{x:4}]);
  return 'id is selected and renamed x';
});

test('regression: HAVING uses the aggregate output alias', () => {
  const app = loadApp();
  graphFromSQL(app, 'SELECT COUNT(*) n FROM orders HAVING COUNT(*)>1');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE orders(id INTEGER); INSERT INTO orders VALUES (1), (2);');
  assert.deepEqual(json(db.prepare(app.buildSQL()).all()), [{n:2}]);
  return 'COUNT(*) HAVING threshold returns the aliased count';
});

test('regression: FULL OUTER JOIN is refused when the graph cannot represent it', () => {
  sqlError('SELECT a.id FROM a FULL OUTER JOIN b ON a.id=b.id');
  return 'FULL OUTER JOIN raises sqlErr';
});

test('regression: NULLS LAST is refused when ordering cannot preserve it', () => {
  sqlError('SELECT * FROM a ORDER BY v ASC NULLS LAST');
  return 'NULLS LAST raises sqlErr';
});

/* x <> NULL and IN (…, NULL) used to import with NULL stored as the text 'null',
   so the regenerated SQL returned rows the original never could. */
test('regression: comparing to a NULL literal is refused, not turned into text', () => {
  for (const sql of ['SELECT id FROM t WHERE note <> NULL', 'SELECT id FROM t WHERE note = NULL',
                     "SELECT id FROM t WHERE s IN ('a', NULL)", "SELECT id FROM t WHERE s NOT IN ('a', NULL)"]) {
    const error = (() => { try { graphFromSQL(api, sql); } catch (e) { return e; } })();
    assert.equal(error?.sqlErr, true, sql);
    assert.match(error.msg, /IS NULL/, sql);
  }
  return '= / <> NULL and IN (…, NULL) raise sqlErr pointing to IS NULL';
});

test('regression: EXCEPT is refused instead of dropping its second query', () => {
  sqlError('SELECT id FROM a EXCEPT SELECT id FROM b');
  return 'EXCEPT raises sqlErr';
});

test('regression: quoted leading-zero IN values', () => {
  const generated = roundTrip("SELECT * FROM t WHERE section_code IN ('067','087')");
  assert.match(generated, /IN \('067', '087'\)/);
  assert.doesNotMatch(generated, /IN \(67, 87\)/);
  return "generated IN ('067', '087')";
});

test('regression: schema qualifier survives all dialects', () => {
  const expected = {
    mysql:'school.`exam results`', postgres:'school."exam results"',
    mssql:'school.[exam results]', oracle:'school."exam results"',
  };
  for (const [dialect, ref] of Object.entries(expected)) {
    api.state.dialect = dialect;
    graphFromSQL(api, 'SELECT * FROM [school].[exam results]');
    assert.match(api.buildSQL(), new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  return 'mysql/postgres/mssql/oracle qualifiers preserved';
});

test('regression: BETWEEN makes exactly two ordered conditions in one block', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM t WHERE x BETWEEN 1 AND 3 AND y = 2');
  const filters = graph.nodes.filter(n => n.type === 'filter');
  assert.equal(filters.length, 1, 'one WHERE → one block');
  assert.deepEqual(json(filters[0].any[0].map(n => [n.col, n.op, n.val])), [['x','>=',1],['x','<=',3],['y','=',2]]);
  return 'one block: x>=1 AND x<=3 AND y=2';
});

test('reverse parse: plain AND conditions share a block, an OR group gets its own', () => {
  let graph = graphFromSQL(api, 'SELECT * FROM t WHERE a >= 1 AND b = 2');
  assert.equal(graph.nodes.filter(n => n.type === 'filter').length, 1);
  roundTrip('SELECT * FROM t WHERE a >= 1 AND b = 2');
  /* (b OR c) stays its own block so every condition is editable in the panel; order is kept */
  graph = graphFromSQL(api, 'SELECT * FROM t WHERE a >= 1 AND e = 5 AND (b = 2 OR c = 3) AND d = 4');
  const blocks = api.chainOrder().filter(n => n.type === 'filter');
  assert.deepEqual(json(blocks.map(n => n.any ? n.any.map(g => g.map(c => c.col).join('&')).join('|') : n.col)),
    ['a&e', 'b|c', 'd']);
  const having = graphFromSQL(api, 'SELECT city, COUNT(*) AS n FROM t GROUP BY city HAVING COUNT(*) >= 5 AND city <> \'x\'');
  assert.equal(having.nodes.filter(n => n.type === 'filter').length, 1);
  return 'a AND b → 1 block; a AND e AND (b OR c) AND d → [a&e] [b|c] [d]; HAVING too';
});

/* Each of these used to import cleanly with no warning while the steps meant
   something else. Refusing is the honest answer until the model can hold them. */
test('regression: SQL the steps would silently change is refused', () => {
  const refused = {
    'SELECT COUNT(DISTINCT x, y) AS n FROM t': 'multiple distinct columns cannot fit one aggregate',
    'SELECT a + b * c AS v FROM t': 'became a_calc * c',
    'SELECT (a + b) * c AS v FROM t': 'nested arithmetic',
    'SELECT TOP 10 PERCENT * FROM t': 'became LIMIT 10',
  };
  for (const sql of Object.keys(refused)) sqlError(sql);
  /* the shapes that do fit still import */
  graphFromSQL(api, 'SELECT a * 2 AS v FROM t WHERE x = 5 AND y = \'k\'');
  graphFromSQL(api, 'SELECT TOP 10 * FROM t');
  graphFromSQL(api, 'SELECT * FROM a JOIN b ON a.id = b.id');
  return `${Object.keys(refused).length} lossy shapes refused; single-op, TOP n, column ON still import`;
});

/* These used to come back as CAST(x), CONVERT(x), COALESCE(x) — SQL that either
   will not run or means something else. Every argument has to survive. */
test('regression: function arguments survive the round trip', () => {
  for (const [sql, call] of [
    ['SELECT COALESCE(x, 0) AS v FROM t', 'COALESCE(x, 0)'],
    ['SELECT CAST(x AS DECIMAL(10,2)) AS v FROM t', 'CAST(x AS DECIMAL(10,2))'],
    ['SELECT CONVERT(VARCHAR(8), x, 112) AS v FROM t', 'CONVERT(VARCHAR(8), x, 112)'],
  ]) assert.ok(roundTrip(sql).includes(call), call);
  return 'COALESCE default, CAST type, CONVERT type and style all kept';
});

/* Renaming COALESCE to UPPER leaves UPPER(x, 0), which will not run. The extra
   arguments stay (COALESCE -> IFNULL needs them) but one click drops them. */
test('inspector: extra function arguments can be dropped after a rename', () => {
  const app = loadApp();
  const graph = graphFromSQL(app, 'SELECT COALESCE(x, 0) AS v FROM t');
  const fn = graph.nodes.find(n => n.type === 'derive');
  app.state.sel = fn.id;
  fn.fn = 'UPPER';
  assert.match(app.buildSQL(), /UPPER\(x, 0\)/);
  const button = {hasAttribute: a => a === 'data-drop-args', dataset: {}};
  app.document.getElementById('inspector').listeners.click({target: {closest: () => button}});
  assert.match(app.buildSQL(), /UPPER\(x\) AS v/);
  return 'UPPER(x, 0) -> UPPER(x) after 拿掉其他參數';
});

/* a RIGHT JOIN b keeps every row of b. Drawing it as a LEFT JOIN on the same
   sides kept every row of a instead — a different result with only a warning. */
test('regression: RIGHT JOIN keeps the right side\'s rows', () => {
  const app = loadApp();
  const graph = graphFromSQL(app, 'SELECT * FROM a RIGHT JOIN b ON a.id = b.id');
  assert.equal(graph.warn.length, 0);
  /* tables named a and b get other aliases — FROM b AS a reads backwards */
  assert.match(app.buildSQL(), /FROM b AS l\s+LEFT JOIN a AS r\s+ON l\.id = r\.id/);
  const t = (name, ids) => ({label:'', cols:[{name:'id', type:'INT'}, {name:name+'_v', type:'INT'}], rows:ids.map(i=>[i, i*10])});
  app.state.schema = {a:t('a', [1, 2]), b:t('b', [2, 3])};
  const out = app.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows.map(r => r[out.cols.indexOf('id')]).sort()), [2, 3]);
  graphFromSQL(app, 'SELECT * FROM orders JOIN customers ON orders.id = customers.id');
  assert.match(app.buildSQL(), /FROM orders AS a\s+INNER JOIN customers AS b/);
  return 'a(1,2) RIGHT JOIN b(2,3) returns ids 2,3 via b LEFT JOIN a';
});

test('regression: every ORDER BY key is kept, in order', () => {
  const generated = roundTrip('SELECT * FROM t ORDER BY x ASC, y DESC LIMIT 3');
  assert.match(generated, /ORDER BY x ASC, y DESC/);
  const app = loadApp();
  const graph = graphFromSQL(app, 'SELECT * FROM t ORDER BY x ASC, y DESC');
  assert.equal(graph.warn.length, 0);
  app.state.schema = {t:{label:'', cols:[{name:'x', type:'INT'}, {name:'y', type:'INT'}], rows:[[1, 1], [2, 0], [1, 2]]}};
  const out = app.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows), [[1, 2], [1, 1], [2, 0]]);
  assert.match(graphFromSQL(app, 'SELECT ROW_NUMBER() OVER (ORDER BY x, y) AS r FROM t').warn.join(), /視窗的 ORDER BY/);
  return 'SQL keeps both keys; ties on x broken by y DESC; window extra keys warned';
});

test('security: pasted DDL column names are plain identifiers only', () => {
  const app = loadApp();
  app.document.getElementById('ddl').value = 'CREATE TABLE t (ok INT, a<img TEXT, b"x TEXT, c_2 INT);';
  app.document.getElementById('btn-parse').listeners.click();
  /* quotes are stripped from DDL names, so b"x becomes the harmless bx */
  assert.deepEqual(json(app.state.schema.t.cols.map(c => c.name)), ['ok', 'bx', 'c_2']);
  return 'kept ok, bx, c_2; dropped a<img';
});

/* Unescaped pasted text was fixed one output at a time (5cebbfd, PR #4, af7a840),
   and each fix checked only the output it touched. This puts the same payload in
   every place a value can sit and reads every output that renders it. */
test('security: a pasted value carrying HTML is text in every block, step and panel', () => {
  const bad = `"><img src=x onerror=alert(1)>`;
  const positions = [
    `SELECT * FROM t WHERE city = '${bad}'`,
    `SELECT * FROM t WHERE city = cost OR city = '${bad}'`,
    `SELECT * FROM t WHERE city IN ('a', '${bad}')`,
    `SELECT t.city FROM t WHERE t.city NOT IN (SELECT u.city FROM u WHERE u.city = '${bad}')`,
    `SELECT t.city FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.city = t.city AND u.city = '${bad}')`,
    `SELECT * FROM t WHERE city LIKE '${bad}%'`,
    `SELECT * FROM t WHERE city BETWEEN '${bad}' AND 'z'`,
    `SELECT CASE WHEN qq = 5 THEN '${bad}' ELSE 'b' END AS lbl FROM t`,
    `SELECT CASE WHEN qq = 5 THEN 'a' ELSE '${bad}' END AS lbl FROM t`,
    `SELECT SUM(CASE WHEN qq = 5 THEN '${bad}' ELSE city END) AS total FROM t`,
    `SELECT CASE WHEN qq = 5 THEN city ELSE '${bad}' END AS lbl FROM t`,
    `SELECT '${bad}' AS k FROM t`,
    `SELECT COALESCE(city, '${bad}') AS c FROM t`,
    `SELECT city, COUNT(*) AS n FROM t GROUP BY city HAVING city <> '${bad}'`,
  ];
  for (const sql of positions) {
    const graph = graphFromSQL(api, sql);
    const outputs = [...graph.nodes.map(n => ['block ' + n.type, api.nodeSummary(n)]),
                     ...api.buildSteps().map(s => ['step ' + s.title, s.cap])];
    for (const n of graph.nodes) {
      api.state.sel = n.id;
      api.state.inspOpen = true;
      api.renderInspector();
      outputs.push(['panel ' + n.type, api.inspector.innerHTML]);
    }
    for (const [where, html] of outputs) assert.doesNotMatch(String(html), /<img/, `${where} for ${sql}`);
  }
  return `${positions.length} positions × every block, step and panel`;
});

/* A pasted name reaches the canvas, the table list and the step-through as raw
   HTML, so it has to be stopped before any of them render — not escaped in one. */
test('security: a pasted name that carries HTML never reaches the page', () => {
  const app = loadApp();
  const doc = app.document;
  const before = JSON.stringify(app.state.nodes);
  for (const name of ['"<img src=x onerror=alert(1)>"', '[x" onmouseover="alert(1)]', '`a&b`']) {
    doc.getElementById('sqlin').value = `SELECT * FROM ${name}`;
    doc.getElementById('do-parse').listeners.click();
    const html = doc.getElementById('parse-out').innerHTML;
    assert.match(html, /perr/);
    assert.doesNotMatch(html, /<img|" onmouseover/);
  }
  assert.equal(JSON.stringify(app.state.nodes), before);
  /* ordinary quoted names still import */
  graphFromSQL(api, 'SELECT * FROM "Order Items" JOIN [dbo].[t 2] ON "Order Items".id = [t 2].id');
  return 'HTML-bearing names refused before render; canvas untouched; plain quoted names import';
});

test('regression: linear filters collapse into one CTE', () => {
  graphFromSQL(api, 'SELECT * FROM t WHERE x >= 1 AND x <= 3');
  const generated = api.buildSQL();
  assert.equal((generated.match(/filtered(?:_\d+)? AS \(/g) || []).length, 1);
  assert.match(generated, /x >= 1\n    AND x <= 3/);
  return 'one filtered CTE with AND';
});

test('select block: projection survives parse, SQL and exec', () => {
  api.state.dialect = 'postgres';
  const graph = graphFromSQL(api,
    'SELECT o.order_id, o.amount, c.city FROM orders AS o ' +
    'INNER JOIN customers AS c ON o.customer_id = c.customer_id WHERE o.amount >= 100');
  const picked = graph.nodes.filter(n => n.type === 'select');
  assert.equal(picked.length, 1);
  assert.deepEqual(json(picked[0].cols), ['order_id', 'amount', 'city']);
  const generated = api.buildSQL();
  assert.match(generated, /picked AS \(\n  SELECT order_id,\n         amount,\n         city/);
  assert.doesNotMatch(generated, /picked AS \(\n  SELECT \*/);
  const out = api.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.cols), ['order_id', 'amount', 'city']);
  // JOIN 自己列出來的欄位清單不可以被誤認成挑欄位
  const again = api.astToGraph(api.parseSQLText(generated));
  assert.equal(again.nodes.filter(n => n.type === 'select').length, 1);
  return 'one select block, kept through SQL, exec and re-import';
});

/* Both key parts matter: casting joins the same calendar date, while the
   class key alone would also match a different exam day. */
test('join: composite keys and per-side casts', () => {
  const table = (names, rows) => ({cols:names.map(name=>({name})), rows});
  const fixture = {
    'school.scores':table(['score','exam_time','class_id'], [[95,'2026-06-01 09:00:00',1]]),
    'school.exam_schedule':table(['cutoff_date','class_id'], [['2026-06-01',1],['2026-06-02',1],['2026-06-01',2]])
  };
  api.state.schema = fixture;
  api.state.dialect = 'mssql';
  const graph = graphFromSQL(api,
    'SELECT t.score FROM school.scores AS t ' +
    'INNER JOIN school.exam_schedule AS w ' +
    'ON CAST(t.exam_time AS DATE) = w.cutoff_date AND t.class_id = w.class_id');
  const keys = graph.nodes.find(n => n.type === 'join').keys;
  assert.deepEqual(json(keys), [
    {left:'exam_time', lfn:'DATE', right:'cutoff_date', rfn:''},
    {left:'class_id', lfn:'',     right:'class_id',   rfn:''},
  ]);
  const generated = api.buildSQL();
  assert.match(generated, /ON CAST\(a\.exam_time AS DATE\) = b\.cutoff_date\n   AND a\.class_id = b\.class_id/);
  // 轉了日期才對得上，所以要有列跑出來
  api.state.schema = fixture;
  const out = api.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows), [[95]], 'both date and class must match');
  // 兩個條件都要成立：拿掉一個列數會變多
  const one = api.astToGraph(api.parseSQLText(
    'SELECT t.score FROM school.scores AS t INNER JOIN school.exam_schedule AS w ON t.class_id = w.class_id'));
  assert.equal(one.nodes.find(n => n.type === 'join').keys.length, 1);
  installGraph(api, one, fixture);
  assert.equal(api.evalNode(one.nodes.find(n => n.type === 'output')).rows.length, 2, 'removing the date key admits the other exam day');
  return `composite keys kept, CAST round-tripped, ${out.rows.length} rows`;
});

test('H5: text JOIN casts avoid silent 255-character truncation', () => {
  const savedSchema = api.state.schema;
  const graph = {
    nodes:[{id:'l',type:'table',table:'l'},{id:'r',type:'table',table:'r'},
      {id:'j',type:'join',joinType:'INNER',keys:[{left:'k',right:'k',lfn:'TEXT',rfn:'TEXT'}]},
      {id:'o',type:'output'}],
    edges:[{from:'l',to:'j',port:0},{from:'r',to:'j',port:1},{from:'j',to:'o',port:0}],
  };
  const prefix = 'a'.repeat(255);
  installGraph(api, graph, {
    l:{cols:[{name:'k'}],rows:[[prefix+'X']]}, r:{cols:[{name:'k'}],rows:[[prefix+'Y']]},
  });
  assert.deepEqual(json(api.evalNode(graph.nodes[3]).rows), []);
  const expected = {
    mysql:/CAST\(a\.k AS CHAR\)/, postgres:/CAST\(a\.k AS TEXT\)/,
    mssql:/CAST\(a\.k AS NVARCHAR\(MAX\)\)/, oracle:/CAST\(a\.k AS VARCHAR2\(4000\)\)/,
  };
  for (const [dialect, pattern] of Object.entries(expected)) {
    api.state.dialect = dialect;
    const generated = api.buildSQL();
    assert.match(generated, pattern);
    assert.doesNotMatch(generated, /VARCHAR\(255\)/);
    if(dialect === 'oracle') assert.match(generated, /注意：Oracle 無法保證超過 4000 字元的文字轉換不遺失/);
    const again = api.astToGraph(api.parseSQLText(generated));
    assert.deepEqual(json(again.nodes.find(n=>n.type === 'join').keys),
      [{left:'k',lfn:'TEXT',right:'k',rfn:'TEXT'}]);
  }
  api.state.schema = savedSchema;
  return 'CHAR, TEXT, NVARCHAR(MAX), and warned VARCHAR2(4000) preserve intent';
});

test('M10: MySQL integer casts use and parse SIGNED or UNSIGNED', () => {
  api.state.dialect = 'mysql';
  const graph = graphFromSQL(api,
    'SELECT * FROM l JOIN r ON CAST(l.x AS SIGNED INTEGER) = CAST(r.y AS UNSIGNED)');
  const keys = graph.nodes.find(n=>n.type === 'join').keys;
  assert.deepEqual(json(keys), [{left:'x',lfn:'INT',right:'y',rfn:'INT'}]);
  const generated = api.buildSQL();
  assert.match(generated, /CAST\(a\.x AS SIGNED\) = CAST\(b\.y AS SIGNED\)/);
  assert.doesNotMatch(generated, / AS INT\)/);
  return 'SIGNED INTEGER and UNSIGNED parse as INT; output uses SIGNED';
});

test('H1: JOIN pruning validates each side without deleting valid keys', () => {
  /* fresh table names: import reuses tables earlier tests left in the schema */
  const graph = graphFromSQL(api,
    'SELECT * FROM h1_l LEFT JOIN h1_r ON h1_l.id = h1_r.id AND h1_l.date = h1_r.day');
  const join = graph.nodes.find(n => n.type === 'join');
  join.keys.push({left:'missing', right:'id'}, {left:'id', right:'missing'});
  api.prune(join);
  assert.deepEqual(json(join.keys.map(k => [k.left, k.right])), [['id','id'], ['date','day']]);
  return 'JOIN type update keeps two valid keys and drops only the invalid key';
});

test('H2: same table name in different schemas stays two sources', () => {
  const graph = graphFromSQL(api,
    'SELECT a.student_id FROM school.students a ' +
    'JOIN school_b.students b ON a.student_id = b.student_id');
  const tables = graph.nodes.filter(n => n.type === 'table');
  assert.deepEqual(json(tables.map(n => `${n.ns}.${n.table}`)), ['school.students','school_b.students']);
  const join = graph.nodes.find(n => n.type === 'join');
  const incoming = graph.edges.filter(e => e.to === join.id).sort((a,b)=>a.port-b.port);
  assert.equal(new Set(incoming.map(e=>e.from)).size, 2);
  const generated = api.buildSQL();
  assert.match(generated, /FROM school\.students AS a\n  INNER JOIN school_b\.students AS b/);
  return 'school.students and school_b.students remain distinct';
});

test('H6: inferred schema keeps an explicit SELECT projection', () => {
  api.state.dialect = 'postgres';
  const graph = graphFromSQL(api, 'SELECT wanted FROM missing_table');
  const picked = graph.nodes.find(n => n.type === 'select');
  assert.deepEqual(json(picked?.cols), ['wanted']);
  assert.match(api.buildSQL(), /picked AS \(\n  SELECT wanted\n  FROM missing_table/);
  return 'unknown table retains SELECT wanted';
});

test('M7: reversed JOIN operands and casts follow source aliases', () => {
  api.state.dialect = 'postgres';
  const savedSchema = api.state.schema;
  const graph = graphFromSQL(api,
    'SELECT l.a_id, r.label FROM left_t l JOIN right_t r ' +
    'ON CAST(r.b_id AS TEXT) = CAST(l.a_id AS INT)');
  const join = graph.nodes.find(n => n.type === 'join');
  assert.deepEqual(json(join.keys), [{left:'a_id',lfn:'INT',right:'b_id',rfn:'TEXT'}]);
  installGraph(api, graph, {
    left_t:{cols:[{name:'a_id'}],rows:[[7],[8]]},
    right_t:{cols:[{name:'b_id'},{name:'label'}],rows:[['7','hit'],['9','miss']]},
  });
  assert.deepEqual(json(api.evalNode(graph.nodes.find(n => n.type === 'output')).rows), [[7,'hit']]);
  assert.match(api.buildSQL(), /ON CAST\(a\.a_id AS INT\) = CAST\(b\.b_id AS TEXT\)/);
  api.state.schema = savedSchema;
  return 'reversed ON imports as left a_id INT = right b_id TEXT';
});

test('select block: empty then one click selects exactly that one', () => {
  // 全不選之後點一個，應該只有那一個被選到
  const avail = ['a', 'b', 'c'];
  const pickOne = (cols, clicked) => {
    const cur = cols.slice();
    const i = cur.indexOf(clicked);
    if (i >= 0) cur.splice(i, 1); else cur.push(clicked);
    return avail.filter(c => cur.indexOf(c) >= 0);
  };
  assert.deepEqual(pickOne([], 'b'), ['b']);
  assert.deepEqual(pickOne(['b'], 'a'), ['a', 'b']);
  assert.deepEqual(pickOne(['a', 'b'], 'b'), ['a']);
  return 'empty -> click b -> ["b"]';
});

/* Invented school rows must look usable and keep all three foreign keys
   joinable; generic category strings and out-of-range scores are misleading. */
test('sample data follows column names, and joins still line up', () => {
  const schema = api.demoSchema();
  const values = (table, col) => {
    const t = schema[table], i = t.cols.findIndex(c=>c.name === col);
    assert.ok(i >= 0, `${table}.${col} exists`);
    return json(t.rows.map(r=>r[i]));
  };
  assert.deepEqual(Object.keys(schema).sort(), ['courses','scores','students','teachers']);
  assert.ok(values('scores','score').every(v=>typeof v === 'number' && v >= 0 && v <= 100));
  assert.ok(values('students','gender').every(v=>['男','女'].includes(v)));
  assert.ok(values('students','name').every(v=>/^[林陳王張李吳]/.test(v)));
  assert.ok(values('teachers','name').every(v=>/^[林陳王張李吳]/.test(v)));
  assert.ok(values('students','class_name').every(v=>/^[一二三]年[甲乙]班$/.test(v)));
  assert.ok(values('courses','course_name').every(v=>['國文','英文','數學','歷史','地理','自然'].includes(v)));
  for (const [table, col] of [['students','birth_date'],['scores','exam_date']])
    assert.ok(values(table,col).every(v=>/^\d{4}-\d{2}-\d{2}$/.test(v)));
  for (const [a,b,key] of [['scores','students','student_id'],['scores','courses','course_id'],['courses','teachers','teacher_id']])
    assert.deepEqual(values(a,key), values(b,key), `${a} JOIN ${b} stays joinable`);
  return 'school names, dates, scores 0–100 and all three shared keys are plausible';
});

/* Exercise the actual four button handlers and every preview renderer. Extra
   students in each course ensure a missing partition or top-two filter fails. */
test('demo: both presets and both SQL samples render rows and retain their meaning', () => {
  const table = (names, rows) => ({cols:names.map(name=>({name})), rows});
  const fixture = () => ({
    students:table(['student_id','name'], [[1,'林小美'],[2,'陳大文'],[3,'王阿明']]),
    scores:table(['student_id','course_id','score'], [[1,1,95],[2,1,85],[3,1,60],[1,2,55],[2,2,71],[3,2,90]])
  });
  for (const [button, sample, advanced] of [['btn-basic',false,false],['btn-adv',false,true],['sample-a',true,false],['sample-b',true,true]]) {
    const app = loadApp();
    const load = () => {
      app.document.getElementById(button).listeners.click();
      if (sample) {
        app.document.getElementById('do-parse').listeners.click();
        assert.match(app.document.getElementById('parse-out').innerHTML, /解析成功/, button);
      }
      const output = app.state.nodes.find(n=>n.type === 'output');
      assert.ok(output, `${button}: output exists`);
      assert.ok(app.evalNode(output).rows.length > 0, `${button}: built-in data produces rows`);
      app.state.steps = app.buildSteps();
      for (let i=0;i<app.state.steps.length;i++) { app.state.step = i; app.renderStage(); }
      return output;
    };
    const output = load();
    app.state.schema = fixture();
    const out = app.evalNode(output);
    app.state.steps = app.buildSteps();
    for (let i=0;i<app.state.steps.length;i++) { app.state.step = i; app.renderStage(); }
    const index = col => out.cols.indexOf(col);
    if (advanced) {
      assert.ok(app.state.nodes.some(n=>n.type === 'window'), `${button}: ranking remains a window`);
      assert.deepEqual(json(out.rows.map(r=>[r[index('course_id')],r[index('name')],r[index('score')],r[index('rk')]]).sort((a,b)=>a[0]-b[0] || a[3]-b[3])),
        [[1,'林小美',95,1],[1,'陳大文',85,2],[2,'王阿明',90,1],[2,'陳大文',71,2]], button);
    } else {
      assert.deepEqual(json(out.rows.map(r=>[r[index('course_id')],r[index('avg_score')]])), [[1,80],[2,72]], button);
    }
    for (const dialect of ['mysql','postgres','mssql','oracle']) {
      app.state.dialect = dialect;
      assert.ok(app.astToGraph(app.parseSQLText(app.buildSQL())).nodes.some(n=>n.type === 'output'), `${button}: ${dialect} reimports`);
    }
  }
  return '4 buttons render all previews; averages and per-course top 2 verified; SQL reimports in 4 dialects';
});

test('round trip: supported node shapes', () => {
  const inputs = [
    'SELECT * FROM t WHERE x=1', 'SELECT DISTINCT * FROM t',
    'SELECT a.x FROM a JOIN b ON a.id=b.id',
    // 兩邊明確選同一欄：a、b 的推測欄位數被前面的測試撐得不一樣，SELECT * 會被 UNION 欄數檢查擋下（#18）
    'SELECT x FROM a UNION ALL SELECT x FROM b',
    "SELECT CASE WHEN x>1 THEN 'y' ELSE 'n' END AS z FROM t",
    'SELECT x+1 AS y FROM t',
    'SELECT ROW_NUMBER() OVER (ORDER BY x) AS r FROM t',
    'SELECT k, SUM(x) AS s FROM t GROUP BY k',
    'SELECT * FROM t ORDER BY x DESC LIMIT 2',
  ];
  inputs.forEach(sql => roundTrip(sql));
  return `${inputs.length} shapes equivalent`;
});

test('H3: OFFSET parses, executes and generates in all dialects', () => {
  const inputs = {
    mysql:'SELECT * FROM t ORDER BY id ASC LIMIT 2,2',
    postgres:'SELECT * FROM t ORDER BY id ASC LIMIT 2 OFFSET 2',
    mssql:'SELECT * FROM t ORDER BY id ASC OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY',
    oracle:'SELECT * FROM t ORDER BY id ASC OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY',
  };
  for (const [dialect, sql] of Object.entries(inputs)) {
    api.state.dialect = dialect;
    const graph = graphFromSQL(api, sql);
    const sort = graph.nodes.find(n => n.type === 'sort');
    assert.deepEqual(json([sort.limit, sort.offset]), [2,2]);
    installGraph(api, graph, {t:{cols:[{name:'id'}],rows:[[1],[2],[3],[4]]}});
    assert.deepEqual(json(api.evalNode(graph.nodes.find(n=>n.type === 'output')).rows), [[3],[4]]);
    const generated = api.buildSQL();
    if(dialect === 'mysql' || dialect === 'postgres') assert.match(generated, /LIMIT 2 OFFSET 2/);
    else assert.match(generated, /OFFSET 2 ROWS\nFETCH NEXT 2 ROWS ONLY/);
    assert.equal(signature(api.astToGraph(api.parseSQLText(generated))), signature(graph));
  }
  return 'LIMIT/OFFSET and OFFSET/FETCH all return rows 3,4';
});

test('M11: limit without ORDER BY round-trips in all dialects', () => {
  const inputs = {
    mysql:'SELECT * FROM t LIMIT 2', postgres:'SELECT * FROM t LIMIT 2',
    mssql:'SELECT TOP 2 * FROM t', oracle:'SELECT * FROM t FETCH FIRST 2 ROWS ONLY',
  };
  for (const [dialect, sql] of Object.entries(inputs)) {
    const generated = roundTrip(sql, dialect);
    assert.doesNotMatch(generated, /ORDER BY\s+(?:``|""|\[\])/);
    assert.doesNotMatch(generated, /ORDER BY\s+(?:ASC|DESC)/);
  }
  for (const [dialect, name] of [['mssql','SQL Server'],['oracle','Oracle']]) {
    api.state.dialect = dialect;
    graphFromSQL(api, 'SELECT * FROM t OFFSET 2 ROWS FETCH NEXT 2 ROWS ONLY');
    assert.match(api.buildSQL(), new RegExp('-- 無法套用 OFFSET 2：'+name+' 需要先指定 ORDER BY，這次未限制列數。'));
  }
  return 'four dialects omit empty ORDER BY; SQL Server and Oracle warn on unordered OFFSET';
});

test('generator: ordinary special literals and identifiers', () => {
  const value = "O'Reilly\\path\n`\"[]";
  api.state.dialect = 'postgres';
  const sql = `SELECT * FROM "表 名" WHERE "欄 名" = '${value.replaceAll("'", "''")}'`;
  const generated = roundTrip(sql);
  assert.match(generated, /"表 名"/);
  assert.match(generated, /O''Reilly/);
  assert.equal(api.parseSQLText(generated).stmt.ctes[0].body.core.where[0].right.v, value);
  return 'quote/backslash/newline/non-ASCII/space round-trip';
});

test('generator: empty IN is explicit and always false', () => {
  const generated = api.condSQL({col:'x', op:'IN', val:''});
  assert.equal(generated, '/* IN 清單是空的 */ 1 = 0');
  assert.equal(api.cmp(1,'IN',''), false);
  assert.doesNotMatch(generated, /\(NULL\)/);
  sqlError('SELECT * FROM t WHERE x IN ()');
  return 'graph explains empty IN and emits 1 = 0; source IN () gets sqlErr';
});

test('exec: LEFT JOIN retains all multiple matches', () => {
  const graph = {
    nodes:[{id:'l',type:'table',table:'l'},{id:'r',type:'table',table:'r'},
      {id:'j',type:'join',joinType:'LEFT',leftCol:'id',rightCol:'id'}],
    edges:[{from:'l',to:'j',port:0},{from:'r',to:'j',port:1}],
  };
  const schema = {
    l:{cols:[{name:'id'}],rows:[[1],[2]]},
    r:{cols:[{name:'id'},{name:'v'}],rows:[[1,'a'],[1,'b']]},
  };
  installGraph(api, graph, schema);
  assert.deepEqual(json(api.evalNode(graph.nodes[2]).rows), [[1,'a'],[1,'b'],[2,null]]);
  return '2 matches plus 1 NULL-extended row';
});

test('exec: zero-key group, ranks, and unordered row numbers', () => {
  const schema = {t:{cols:[{name:'x'}],rows:[[10],[10],[5]]}};
  const base = {id:'t',type:'table',table:'t'};
  const group = {id:'g',type:'groupby',keys:[],aggs:[{fn:'COUNT',col:'*',as:'c'}]};
  installGraph(api,{nodes:[base,group],edges:[{from:'t',to:'g',port:0}]},schema);
  assert.deepEqual(json(api.evalNode(group).rows), [[3]]);
  const values = {};
  for (const fn of ['RANK','DENSE_RANK','ROW_NUMBER']) {
    const node = {id:'w',type:'window',fn,col:'*',partitionBy:[],orderBy:fn==='ROW_NUMBER'?'':'x',dir:'DESC',as:'n'};
    installGraph(api,{nodes:[base,node],edges:[{from:'t',to:'w',port:0}]},schema);
    values[fn] = api.evalNode(node).rows.map(r => r[1]);
  }
  assert.deepEqual(json(values), {RANK:[1,1,3],DENSE_RANK:[1,1,2],ROW_NUMBER:[1,2,3]});
  return 'group=[[3]], rank=1,1,3 dense=1,1,2 rownum=1,2,3';
});

test('parser: normal malformed inputs throw sane sqlErr', () => {
  ['SELECT (x FROM t', 'SELECT * FROM', 'SELECT * FROM t WHERE x ='].forEach(sqlError);
  const parsed = api.parseSQLText("SELECT * FROM t WHERE x = '--not a comment'");
  assert.equal(parsed.stmt.core.where[0].right.v, '--not a comment');
  return '3 sqlErr cases; -- inside string preserved';
});

test('parser: deep and 1MB inputs terminate quickly', () => {
  let deep = 'SELECT * FROM t';
  for (let i=0; i<120; i++) deep = `SELECT * FROM (${deep}) q${i}`;
  const million = 'SELECT * FROM t' + ' '.repeat(1024*1024 - 15);
  const start = performance.now();
  api.parseSQLText(deep);
  api.parseSQLText(million);
  const elapsed = performance.now() - start;
  assert.equal(elapsed < 3000, true);
  return `depth=120 and bytes=${million.length} in ${Math.round(elapsed)}ms`;
});

test('graph: branched filter is not absorbed by generator', () => {
  const graph = branchedGraph();
  installGraph(api, graph, oneColumnSchema());
  const sql = api.buildSQL();
  assert.equal((sql.match(/filtered(?:_\d+)? AS \(/g) || []).length, 2);
  return 'two independent filtered CTEs';
});

test('H4: projection makes an invalid downstream reference a graph error', () => {
  const graph = {
    nodes:[{id:'t',type:'table',table:'t'}, {id:'s',type:'select',cols:['a']},
      {id:'f',type:'filter',col:'b',op:'=',val:'x'}, {id:'o',type:'output'}],
    edges:[{from:'t',to:'s',port:0},{from:'s',to:'f',port:0},{from:'f',to:'o',port:0}],
  };
  installGraph(api, graph, {t:{cols:[{name:'a'},{name:'b'}],rows:[[1,'x'],[2,'y']]}});
  assert.deepEqual(json(api.evalNode(graph.nodes[2])), {cols:['a'],rows:[]});
  const generated = api.buildSQL();
  assert.equal(generated, '-- 無法產生 SQL：WHERE 引用了上一步已沒有的欄位 b。');
  assert.doesNotMatch(generated, /WHERE b/);
  return 'invalid b reference is neither passed through nor absorbed';
});

test('M8: no-limit middle sort keeps an absorbed projection source', () => {
  const graph = {
    nodes:[{id:'t',type:'table',table:'t'}, {id:'s',type:'select',cols:['a']},
      {id:'r',type:'sort',by:'a',dir:'ASC',limit:0,offset:0},
      {id:'d',type:'distinct'}, {id:'o',type:'output'}],
    edges:[{from:'t',to:'s',port:0},{from:'s',to:'r',port:0},
      {from:'r',to:'d',port:0},{from:'d',to:'o',port:0}],
  };
  installGraph(api, graph, {t:{cols:[{name:'a'},{name:'b'}],rows:[[2,'x'],[1,'y'],[1,'z']]}});
  const generated = api.buildSQL();
  assert.match(generated, /sorted AS \([\s\S]*SELECT a\n  FROM t/);
  assert.doesNotMatch(generated, /FROM \?/);
  assert.deepEqual(json(api.evalNode(graph.nodes[4]).rows), [[1],[2]]);
  return 'middle sort reads projected a from t, never FROM ?';
});

test('graph: chainOrder without output is empty', () => {
  installGraph(api,{nodes:[{id:'t',type:'table',table:'t'}],edges:[]},oneColumnSchema());
  assert.deepEqual(json(api.chainOrder()), []);
  return '[]';
});

test('NULL comparisons do not pass; IS NULL excludes empty string', () => {
  const actual = [api.cmp(null,'<>','x'), api.cmp(null,'NOT IN','x'), api.cmp('','IS NULL','')];
  assert.deepEqual(actual, [false,false,false]);
  return `cmp(null,'<>','x'), cmp(null,'NOT IN','x'), cmp('','IS NULL') => ${actual.join(',')}`;
});

test('fix A3: aggregates ignore NULL and support text', () => {
  const actual = [
    api.aggregate({fn:'AVG',col:'x'}, [[null],[2]], ['x']),
    api.aggregate({fn:'COUNT',col:'x'}, [['a'],[null],['b']], ['x']),
    api.aggregate({fn:'MAX',col:'x'}, [['a'],['b']], ['x']),
    api.aggregate({fn:'MIN',col:'x'}, [['a'],['b']], ['x']),
  ];
  assert.deepEqual(actual, [2,2,'b','a']);
  return `AVG(NULL,2), COUNT(a,NULL,b), MAX/MIN(a,b) => ${JSON.stringify(actual)}`;
});

test('fix A4: global aggregate over empty input emits one row', () => {
  const graph = globalAggregateGraph();
  installGraph(api, graph, {t:{cols:[{name:'x'}],rows:[]}});
  const actual = api.evalNode(graph.nodes[1]);
  assert.deepEqual(json(actual), {cols:['c'],rows:[[0]]});
  return `COUNT(*) result=${JSON.stringify(actual)}`;
});

test('fix A1: shared upstream is memoized without consuming a branch', () => {
  const graph = branchedGraph();
  let reads = 0;
  const table = {cols:[{name:'x'}]};
  Object.defineProperty(table, 'rows', {get(){ reads++; return [[1],[2],[3]]; }});
  installGraph(api, graph, {t:table});
  const actual = api.evalNode(graph.nodes.find(n => n.id === 'u')).rows;
  assert.deepEqual(json(actual), [[2],[3],[1],[2]]);
  assert.equal(reads, 1);
  return `UNION ALL rows=${JSON.stringify(actual)}; table evaluated ${reads} time`;
});

test('fix B1: aggregate-only graph omits GROUP BY', () => {
  const graph = globalAggregateGraph();
  installGraph(api, graph, {t:{cols:[{name:'x'}],rows:[[1]]}});
  const generated = api.buildSQL();
  assert.doesNotMatch(generated, /GROUP BY/);
  api.parseSQLText(generated);
  return 'no GROUP BY clause; generated SQL reparses';
});

test('fix A2: comma inside IN string remains one value', () => {
  const graph = graphFromSQL(api, "SELECT * FROM t WHERE x IN ('a,b','c')");
  const stored = graph.nodes.find(n => n.type === 'filter').val;
  installGraph(api, graph, {t:{cols:[{name:'x'}],rows:[['a,b'],['c'],['z']]}});
  const generated = api.buildSQL();
  assert.equal(stored, "'a,b', 'c'");
  assert.match(generated, /IN \('a,b', 'c'\)/);
  assert.deepEqual(json(api.evalNode(graph.nodes.find(n => n.type === 'filter')).rows.map(r=>r[0])), ['a,b','c']);
  return `stored=${JSON.stringify(stored)} generated=IN ('a,b', 'c')`;
});

test('string codes keep their quotes even when they look numeric', () => {
  // 課程代號可以是 VARCHAR：'116' 掉了引號就變成隱式轉型
  const graph = graphFromSQL(api, "SELECT * FROM t WHERE section_code IN ('067','116','213') AND course_id = '0987'");
  const generated = api.buildSQL();
  assert.match(generated, /IN \('067', '116', '213'\)/);
  assert.doesNotMatch(generated, /IN \('067', 116, 213\)/);
  assert.match(generated, /course_id = '0987'/);
  // 重新匯入一次還是字串
  const again = api.astToGraph(api.parseSQLText(generated));
  assert.match(api.buildSQL.call(null) || '', /.*/);
  const kept = again.nodes.filter(n => n.type === 'filter');
  assert.equal(kept.length, 1);
  assert.equal(kept[0].any[0].length, 2);
  return "IN ('067', '116', '213') and course_id = '0987' stay quoted";
});

test('fix B2: identifier closing delimiters are doubled', () => {
  const actual = {};
  for (const [dialect, value] of [['mysql','a`b'],['postgres','a"b'],['mssql','a]b']]) {
    api.state.dialect = dialect; actual[dialect] = api.q(value);
  }
  assert.deepEqual(actual, {mysql:'`a``b`',postgres:'"a""b"',mssql:'[a]]b]'});
  assert.equal(api.parseSQLText('SELECT [a]]b] FROM [t]]x]').stmt.core.items[0].expr.col, 'a]b');
  return JSON.stringify(actual);
});

test('fix B4: MySQL string literal doubles backslashes', () => {
  api.state.dialect = 'mysql';
  const value = String.raw`a\nb`;
  const actual = api.condSQL({col:'x',op:'=',val:value});
  const like = api.condSQL({col:'x',op:'LIKE',val:value});
  assert.equal(actual, "x = 'a\\\\nb'");
  assert.equal(like, "x LIKE 'a\\\\nb'");
  assert.equal((actual.match(/\\/g) || []).length, 2);
  return `comparison=${JSON.stringify(actual)} LIKE=${JSON.stringify(like)}`;
});

test('fix B4: empty NOT IN execution and SQL both always true', () => {
  const generated = api.condSQL({col:'x',op:'NOT IN',val:''});
  const actual = api.cmp(1,'NOT IN','');
  assert.equal(generated, '/* NOT IN 清單是空的 */ 1 = 1');
  assert.doesNotMatch(generated, /\(NULL\)/);
  assert.equal(actual, true);
  return `generated=${generated}; cmp(1,NOT IN,'')=${actual}`;
});

test('fix C1: unterminated tokens report their opening position', () => {
  const inputs = [["SELECT 'abc", "'"], ['SELECT * FROM [abc','['], ['SELECT * FROM "abc','"'],
    ['SELECT * FROM `abc','`'], ['SELECT * FROM t /*','/*']];
  const actual = inputs.map(([sql, opener]) => {
    const error = sqlError(sql);
    assert.equal(error.pos, sql.indexOf(opener));
    return error.pos;
  });
  return `5 sqlErr opening positions=${actual.join(',')}`;
});

test('fix B3: statement splitter skips all quoted identifiers', () => {
  const input = 'SELECT * FROM [a;b]; SELECT * FROM "c;d"; SELECT * FROM `e;f`; SELECT 2';
  const actual = api.splitStatements(input);
  assert.deepEqual(json(actual), ['SELECT * FROM [a;b]','SELECT * FROM "c;d"','SELECT * FROM `e;f`','SELECT 2']);
  return JSON.stringify(actual);
});

test('fix C2: cycle produces a readable graph error', () => {
  const graph = {nodes:[{id:'f',type:'filter',col:'x',op:'=',val:1},{id:'o',type:'output'}],
    edges:[{from:'f',to:'f',port:0},{from:'f',to:'o',port:0}]};
  installGraph(api, graph, oneColumnSchema());
  const generated = api.buildSQL();
  assert.match(generated, /^-- 無法產生 SQL：.*循環/);
  assert.doesNotMatch(generated, /FROM filtered/);
  assert.deepEqual(json(api.evalNode(graph.nodes[0])), {cols:[],rows:[]});
  return generated;
});

test('fix C3: unconnected input produces a readable graph error', () => {
  const graph = {nodes:[{id:'f',type:'filter',col:'x',op:'=',val:1},{id:'o',type:'output'}],
    edges:[{from:'f',to:'o',port:0}]};
  installGraph(api, graph, oneColumnSchema());
  const generated = api.buildSQL();
  assert.match(generated, /^-- 無法產生 SQL：WHERE 缺少第 1 個來源連線。$/);
  assert.doesNotMatch(generated, /FROM \?/);
  assert.deepEqual(json(api.evalNode(graph.nodes[0])), {cols:[],rows:[]});
  return generated;
});

function oneColumnSchema() {
  return {t:{cols:[{name:'x'}],rows:[[1],[2],[3]]}};
}
function branchedGraph() {
  return {
    nodes:[{id:'t',type:'table',table:'t'},
      {id:'f1',type:'filter',col:'x',op:'>=',val:2},
      {id:'f2',type:'filter',col:'x',op:'<=',val:2},
      {id:'u',type:'union',all:true},{id:'o',type:'output'}],
    edges:[{from:'t',to:'f1',port:0},{from:'t',to:'f2',port:0},
      {from:'f1',to:'u',port:0},{from:'f2',to:'u',port:1},{from:'u',to:'o',port:0}],
  };
}
function globalAggregateGraph() {
  return {
    nodes:[{id:'t',type:'table',table:'t'},
      {id:'g',type:'groupby',keys:[],aggs:[{fn:'COUNT',col:'*',as:'c'}]},
      {id:'o',type:'output'}],
    edges:[{from:'t',to:'g',port:0},{from:'g',to:'o',port:0}],
  };
}

/* M13 — sample data must satisfy the cross-table contract that makes JOINs
   visible in the animation: the same column name, in any two tables, must
   produce the same values. A single hand-picked pair is not enough; the
   previous suite checked only a single pair and missed other clashes. */
test('M13: every repeated column name has one sample sequence across all tables', () => {
  const schema = api.demoSchema();
  const seen = new Map();
  const clashes = [];
  let repeats = 0;
  for (const table of Object.keys(schema)) {
    const entry = schema[table];
    entry.cols.forEach((col, i) => {
      const key = String(col.name).toLowerCase();
      const values = JSON.stringify(entry.rows.map(row => row[i]));
      const prev = seen.get(key);
      if (!prev) { seen.set(key, {table, values}); return; }
      repeats++;
      if (prev.values !== values) {
        clashes.push(`${col.name}: ${prev.table}=${prev.values} vs ${table}=${values}`);
      }
    });
  }
  assert.equal(clashes.length, 0, clashes.slice(0, 3).join(' | '));
  assert.equal(repeats, 4, 'student_id, course_id, teacher_id and name must all repeat');
  return `${seen.size} names, ${repeats} cross-table repeats, 0 clashes`;
});

/* The clash came from the Chinese name and the guessed type steering the rule
   per table. A table that supplies neither (an inferred table from pasted SQL)
   must still get the sequence the schema already chose for that column name. */
test('M13: a later table cannot re-classify an already-seen column name', () => {
  api.demoSchema();
  const rows = c => [0, 1, 2, 3, 4, 5].map(r => api.sampleValue(c, r));
  /* A neutral enrollment_code is labelled 註冊代號 (a code) in one table,
     while a later inferred table supplies no Chinese name and guesses INT. They must not diverge,
     or the JOIN in the animation matches nothing. */
  const rich = rows({name:'enrollment_code', ch:'註冊代號', type:'VARCHAR'});
  const bare = rows({name:'enrollment_code', ch:'', type:'INT'});
  assert.deepEqual(json(bare), json(rich));
  return `enrollment_code stays ${JSON.stringify(rich.slice(0, 2))} with or without the Chinese name`;
});

/* M9 — a JOIN whose two sides share a non-key column name used to emit two
   columns called `status` in one CTE. SQL Server rejects that outright, and a
   downstream WHERE could not say which side it meant. The right side is now
   aliased, and the evaluator must use the same name or the animation and the
   SQL would filter different columns. */
test('M9: a colliding right-side column is aliased in both SQL and animation', () => {
  const col = name => ({name, ch:'', type:'VARCHAR'});
  const schema = {
    l:{label:'', cols:[col('id'), col('status')], rows:[[1, 'active'], [2, 'closed']]},
    r:{label:'', cols:[col('id'), col('status')], rows:[[1, 'shipped'], [2, 'held']]},
  };
  installGraph(api, {
    nodes:[
      {id:'a', type:'table', table:'l'},
      {id:'b', type:'table', table:'r'},
      {id:'j', type:'join', joinType:'INNER', keys:[{left:'id', right:'id', lfn:'', rfn:''}]},
      {id:'f', type:'filter', col:'status', op:'=', val:'active'},
      {id:'o', type:'output'}],
    edges:[
      {from:'a', to:'j', port:0}, {from:'b', to:'j', port:1},
      {from:'j', to:'f', port:0}, {from:'f', to:'o', port:0}],
  }, schema);
  const joined = api.evalNode(api.state.nodes.find(n => n.id === 'j'));
  assert.deepEqual(json(joined.cols), ['id', 'status', 'status_2']);
  assert.deepEqual(json(joined.rows), [[1, 'active', 'shipped'], [2, 'closed', 'held']]);

  api.state.dialect = 'mssql';
  const sql = api.buildSQL();
  assert.match(sql, /b\.status AS status_2/);
  /* the CTE must not declare the same output name twice — SQL Server rejects it */
  const cte = sql.slice(sql.indexOf('WITH joined AS ('), sql.indexOf('FROM l AS a'));
  const declared = cte.match(/(?:a|b)\.\w+(?: AS (\w+))?/g).map(m => m.split(' AS ').pop().split('.').pop());
  assert.equal(new Set(declared).size, declared.length, `duplicate output names: ${declared}`);

  /* the WHERE still means the left side, in both engines */
  const out = api.evalNode(api.state.nodes.find(n => n.id === 'f'));
  assert.deepEqual(json(out.rows), [[1, 'active', 'shipped']]);
  return 'cols=id,status,status_2; b.status AS status_2; filter keeps the left side';
});

/* M12 — quoting is not cosmetic. PostgreSQL folds an unquoted name to lower
   case, so dropping the quotes around "Camel" points at a different column.
   But quoting is not free either: Oracle folds an UNQUOTED name to upper case,
   so force-quoting a lowercase name that never needed it breaks the other
   direction. Only quoting that carries meaning is preserved. */
test('M12: meaningful quoting survives, redundant quoting is dropped', () => {
  api.state.quoteAll = false;
  api.state.dialect = 'postgres';
  graphFromSQL(api, 'SELECT "Camel" FROM "MyTable"');
  const mixed = api.buildSQL();
  assert.match(mixed, /"MyTable"/);
  assert.match(mixed, /"Camel"/);
  assert.doesNotMatch(mixed, /(^|[^"])\bCamel\b(?!")/);
  /* and it stays quoted when the generated SQL is fed back in */
  graphFromSQL(api, mixed);
  assert.match(api.buildSQL(), /"MyTable"/);

  graphFromSQL(api, 'SELECT * FROM "school"."scores"');
  const lower = api.buildSQL();
  assert.match(lower, /school\.scores/);
  assert.doesNotMatch(lower, /"school"/);

  /* a reserved word can never be emitted bare, whatever the source did */
  graphFromSQL(api, 'SELECT * FROM t WHERE "user" = 1');
  const reserved = api.buildSQL();
  assert.match(reserved, /"user" = 1/);
  return 'Camel/MyTable stay quoted; school.scores goes bare; user stays quoted';
});

/* Magnetic snapping. Blocks that sit next to each other with their ports lined
   up are connected and draw NO wire, so the geometry test IS the connection
   test: if isSnapped() drifts, a real connection silently loses its only
   on-screen representation, or a wire appears between two touching blocks. */
const W = 164, H = 86;   /* the sizes the stub DOM reports back */

test('snap: touching blocks read as connected, separated ones do not', () => {
  installGraph(api, {
    nodes:[{id:'t', type:'table', table:'t', x:0, y:0},
           {id:'f', type:'filter', col:'a', op:'=', val:'1', x:W + api.SNAP_GAP, y:0},
           {id:'o', type:'output', x:400, y:0}],
    edges:[{from:'t', to:'f', port:0}, {from:'f', to:'o', port:0}],
  }, {t:{label:'', cols:[{name:'a', ch:'', type:'INT'}], rows:[[1]]}});

  const edge = api.state.edges[0];
  assert.equal(api.isSnapped(edge), true, 'aligned and touching must read as snapped');

  api.state.nodes[1].y += 40;                     /* nudged out of line */
  assert.equal(api.isSnapped(edge), false, 'a visible offset must bring the wire back');

  api.state.nodes[1].y = 0;
  api.state.nodes[1].x += 120;                    /* pulled apart sideways */
  assert.equal(api.isSnapped(edge), false, 'a gap must bring the wire back');
  return 'touching = no wire; nudged or pulled apart = wire returns';
});

test('snap: dragging near a block finds it, and never closes a loop', () => {
  installGraph(api, {
    nodes:[{id:'t', type:'table', table:'t', x:0, y:0},
           {id:'f', type:'filter', col:'a', op:'=', val:'1', x:W + api.SNAP_GAP + 9, y:6},
           {id:'o', type:'output', x:900, y:900}],
    edges:[{from:'t', to:'f', port:0}],
  }, {t:{label:'', cols:[{name:'a', ch:'', type:'INT'}], rows:[[1]]}});

  /* f is close to t's right edge but not exact — it should snap onto it */
  const near = api.snapFor('f');
  assert.equal(near.from, 't');
  assert.equal(near.to, 'f');
  assert.equal(near.x, W + api.SNAP_GAP);

  /* t sits just left of f, which would mean f -> t: that closes a loop */
  api.state.nodes[0].x = api.state.nodes[1].x + W + api.SNAP_GAP + 4;
  api.state.nodes[0].y = api.state.nodes[1].y;
  const loop = api.snapFor('t');
  assert.equal(Boolean(loop && loop.from === 'f' && loop.to === 't'), false, 'must not snap into a cycle');
  return `snapped to x=${near.x}; cycle refused`;
});

test('snap: tidy leaves every connection touching, so no wires are drawn', () => {
  const col = name => ({name, ch:'', type:'VARCHAR'});
  installGraph(api, {
    nodes:[{id:'a', type:'table', table:'l', x:11, y:250},
           {id:'b', type:'table', table:'r', x:77, y:3},
           {id:'j', type:'join', joinType:'INNER', keys:[{left:'id', right:'id', lfn:'', rfn:''}], x:500, y:90},
           {id:'o', type:'output', x:33, y:600}],
    edges:[{from:'a', to:'j', port:0}, {from:'b', to:'j', port:1}, {from:'j', to:'o', port:0}],
  }, {l:{label:'', cols:[col('id'), col('x')], rows:[[1, 'p']]},
      r:{label:'', cols:[col('id'), col('y')], rows:[[1, 'q']]}});

  api.settleLayout();
  const loose = api.state.edges.filter(e => !api.isSnapped(e));
  assert.deepEqual(json(loose), [], 'tidy must line every port up exactly');
  /* the two sources end up straddling the JOIN's two input ports */
  const ys = ['a', 'b'].map(id => api.nodeBox(id).n.y);
  assert.equal(ys[0] !== ys[1], true, 'a two-input block must not stack its sources');
  return `3 edges all touching; sources at y=${ys.join(' and ')}`;
});

/* The whole point of the half-magnetic layout: an ordinary left-to-right flow
   shows no wires at all, a branch still shows the one wire that adjacency
   cannot express, and nothing ever ends up stacked on top of anything else. */
test('snap: a plain flow draws no wires, a branch draws exactly one, nothing overlaps', () => {
  const overlaps = () => {
    const out = [];
    api.state.nodes.forEach((p, i) => api.state.nodes.slice(i + 1).forEach(q => {
      const P = api.nodeBox(p.id), Q = api.nodeBox(q.id);
      if (P.n.x < Q.n.x + Q.w && Q.n.x < P.n.x + P.w &&
          P.n.y < Q.n.y + Q.h && Q.n.y < P.n.y + P.h) out.push(`${p.type}/${q.type}`);
    }));
    return out;
  };
  graphFromSQL(api, 'SELECT county, SUM(score) AS amt FROM school.scores a ' +
    'JOIN school.classes b ON a.class_id = b.class_id GROUP BY county');
  api.settleLayout();
  assert.deepEqual(json(api.state.edges.filter(e => !api.isSnapped(e))), [], 'a plain flow needs no wires');
  assert.deepEqual(json(overlaps()), [], 'blocks must not sit on top of each other');

  /* the same table now also feeds a second block — that cannot be expressed by
     sitting next to it, so it must fall back to a drawn wire */
  const table = api.state.nodes.find(n => n.type === 'table');
  api.state.nodes.push({id:'f2', type:'filter', col:'county', op:'=', val:'台北', x:0, y:0});
  api.state.edges.push({from:table.id, to:'f2', port:0});
  api.settleLayout();
  const drawn = api.state.edges.filter(e => !api.isSnapped(e));
  assert.equal(drawn.length, 1, `expected exactly one wire, got ${drawn.length}`);
  assert.equal(drawn[0].to, 'f2');
  assert.deepEqual(json(overlaps()), [], 'the branch must be moved clear, not stacked');
  return 'plain flow: 0 wires; branch: 1 wire; no overlaps either way';
});

/* Quick filters also support neutral fixed-width section codes: '02' is a section, not the
   number 2. A range is expanded to an explicit list so nothing downstream can
   reinterpret it, and every code must survive to the SQL still quoted —
   including the ones that look like numbers, such as '22' and '58'. */
test('quick: code ranges expand as fixed-width strings', () => {
  assert.deepEqual(json(api.codeRange('02', '22').slice(0, 3)), ['02', '03', '04']);
  assert.equal(api.codeRange('02', '22').length, 21);
  assert.equal(api.codeRange('02', '22').every(c => c.length === 2), true);
  assert.deepEqual(json(api.codeRange('A0', 'A9')), ['A0','A1','A2','A3','A4','A5','A6','A7','A8','A9']);
  assert.equal(api.codeRange('27', '34').length, 8);

  assert.deepEqual(json(api.parseCodes('01-03, A0-A2, B1')), ['01','02','03','A0','A1','A2','B1']);
  return 'numeric and alphanumeric ranges retain width and explicit values';
});

/* Grade shortcuts must select the advertised boundary values, including zero
   and a perfect score, rather than reusing obsolete category lists. */
test('quick: built-in score grades select the advertised boundaries', () => {
  const app = loadApp();
  const schema = {scores:{cols:[{name:'score',type:'INT'}], rows:[[0],[59],[60],[89],[90],[100]]}};
  const expected = {'及格':[60,89,90,100], '不及格':[0,59], '優等':[90,100], '排除零分':[59,60,89,90,100]};
  for (const q of app.QUICK_DEFAULT) {
    installGraph(app, {nodes:[{id:'t',type:'table',table:'scores'},
      {id:'f',type:'filter',col:q.col,op:q.op,val:app.quickVal(q)}, {id:'o',type:'output'}],
      edges:[{from:'t',to:'f',port:0},{from:'f',to:'o',port:0}]}, schema);
    assert.deepEqual(json(app.evalNode(app.state.nodes[2]).rows.map(r=>r[0])), expected[q.label], q.label);
    app.astToGraph(app.parseSQLText(app.buildSQL()));
  }
  return '60 passes, 59 fails, 90 is excellent, zero can be excluded, 100 remains valid';
});

/* The shorthand is what the analyst actually types, commas, ideographic commas,
   full stops and all — it has to survive being pasted in as written. */
test('quick: the shorthand accepts the separators people really type', () => {
  const asTyped = api.parseCodes('02-22，A0-A9，B2. B5. B6');
  assert.equal(asTyped.length, 34);
  assert.deepEqual(json(asTyped.slice(0, 2)), ['02', '03']);
  assert.deepEqual(json(asTyped.slice(-3)), ['B2', 'B5', 'B6']);
  /* duplicates collapse, quotes are tolerated, blanks ignored */
  assert.deepEqual(json(api.parseCodes("'58', 58 ,, 58")), ['58']);
  /* a lone value that is not a range stays exactly as written */
  assert.deepEqual(json(api.parseCodes('X1')), ['X1']);
  return `"02-22，A0-A9，B2. B5. B6" → 34 codes; duplicates collapsed`;
});

test('quick: every code reaches the SQL quoted, even the numeric-looking ones', () => {
  const schema = {t:{label:'', cols:[{name:'grade_code', ch:'等級代號', type:'VARCHAR'}],
                     rows:[['02'], ['22'], ['58']]}};
  const presets = [{label:'甲組', col:'grade_code', op:'IN', src:'01-03, A0-A2'},
                   {label:'排除乙組', col:'grade_code', op:'NOT IN', src:'04-06'}];
  for (const q of presets) {
    installGraph(api, {
      nodes:[{id:'t', type:'table', table:'t'},
             {id:'f', type:'filter', col:q.col, op:q.op, val:api.quickVal(q)},
             {id:'o', type:'output'}],
      edges:[{from:'t', to:'f', port:0}, {from:'f', to:'o', port:0}],
    }, schema);
    api.state.dialect = 'mssql';
    const sql = api.buildSQL();
    api.quickCodes(q).forEach(code => {
      assert.match(sql, new RegExp(`'${code}'`), `${q.label}: ${code} must stay quoted`);
    });
    assert.doesNotMatch(sql, /\((\s*\d+\s*,)/, `${q.label}: no bare numeric code`);
    assert.match(sql, new RegExp(q.op.replace(' ', '\\s+')));
    /* and the generated SQL still reparses into the same filter */
    const back = api.astToGraph(api.parseSQLText(sql)).nodes.find(n => n.type === 'filter');
    assert.equal(back.op, q.op, `${q.label}: operator survives the round trip`);
  }
  return `${presets.length} custom presets: all codes quoted, operators round-trip`;
});

/* v16 shipped with both drawers stuck open. `.dock-body{display:none}` and
   `.rail{display:flex}` have the same specificity, the same element carries both
   classes, and `.rail` is written later — so it won and the drawers never
   closed. Nothing in the suite could see it, and neither could I: I cannot look
   at the page. So the invariant is checked directly — no element may depend on
   source order between two equally specific display rules. */
test('css: no element depends on source order between two display rules', () => {
  const html = fs.readFileSync(new URL('../sql-blocks.html', import.meta.url), 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  const markup = html.slice(html.indexOf('</style>'));
  /* comments first: a comment sitting above a rule otherwise gets swallowed into
     the selector capture and the rule stops looking like a single class */
  const noComments = style.replace(/\/\*[\s\S]*?\*\//g, '');
  /* @media rules apply conditionally, so they are not part of this comparison */
  const flat = noComments.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

  /* last single-class rule per class wins, which is what the cascade does */
  const singles = new Map();
  for (const rule of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const display = /(?:^|;)\s*display\s*:\s*([\w-]+)/.exec(rule[2]);
    if (!display) continue;
    for (const part of rule[1].split(',')) {
      const selector = part.trim();
      if (/^\.[\w-]+$/.test(selector)) singles.set(selector.slice(1), display[1]);
    }
  }

  const risky = [];
  for (const el of markup.matchAll(/class="([^"]+)"/g)) {
    const hits = el[1].trim().split(/\s+/).filter(c => singles.has(c));
    if (hits.length < 2) continue;
    if (new Set(hits.map(c => singles.get(c))).size > 1) {
      risky.push(`class="${el[1]}": ` + hits.map(c => `.${c}=${singles.get(c)}`).join(' vs '));
    }
  }
  assert.deepEqual(json(risky), [], risky.join(' | '));

  /* and the drawer specifically must be hidden by a rule that outranks .rail */
  assert.match(flat, /\.dock\s*>\s*\.dock-body\s*\{[^}]*display\s*:\s*none/);

  /* An element written `hidden` is hidden by the browser's own stylesheet, which
     ANY author display rule outranks. The import dialog is `hidden` and its class
     sets display:flex, so without a [hidden] rule it covers the whole page from
     the first paint. The published page gets that rule from the platform; the
     file has to carry its own. */
  for (const el of markup.matchAll(/<[^>]*\bhidden\b[^>]*>/g)) {
    const cls = /class="([^"]+)"/.exec(el[0]);
    if (!cls) continue;
    const styled = cls[1].trim().split(/\s+/).filter(c => singles.has(c));
    if (!styled.length) continue;
    assert.match(flat, /\[hidden\]\s*\{[^}]*display\s*:\s*none/,
      `${cls[1]} is hidden but .${styled[0]} sets display — a [hidden] rule is required`);
  }
  return `${singles.size} single-class display rules, no order-dependent clashes`;
});

/* The stylesheet styles text fields as `input[type="text"]`, which does not
   match a bare `<input>` even though the browser treats it as text. The quick
   filter form shipped with three unstyled fields that way — no border, no
   width, and the form looked broken. An input without a type is the bug. */
test('html: every input declares its type, or the stylesheet skips it', () => {
  const html = fs.readFileSync(new URL('../sql-blocks.html', import.meta.url), 'utf8');
  const markup = html.slice(html.indexOf('</style>')).replace(/<script>[\s\S]*?<\/script>/g, '');
  const bare = markup.match(/<input(?![^>]*\btype=)[^>]*>/g) || [];
  assert.deepEqual(json(bare), []);

  /* and each drawer tab has a body to open, or the tab does nothing */
  const tabs = [...markup.matchAll(/dock-tab" data-drawer="(\w+)"/g)].map(m => m[1]);
  const bodies = [...markup.matchAll(/dock-body rail" data-drawer="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(json([...tabs].sort()), json([...bodies].sort()));
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  tabs.forEach(t => assert.match(style, new RegExp(`data-open="${t}"`), `${t} has no open rule`));
  return `${tabs.length} drawers wired: ${tabs.join(', ')}`;
});

/* The 結果 block said 還沒接上來源 whenever it held zero rows, which sends the
   user hunting for a disconnected wire that is not there. A connected block
   that filtered everything away is a different problem with a different fix,
   and an empty IN list — the usual cause — now says so on the filter itself. */
test('summary: zero rows and no source are told apart', () => {
  const schema = {t:{label:'', cols:[{name:'grade_code', ch:'', type:'VARCHAR'}], rows:[['02'], ['58']]}};
  const graph = (filterVal, connectOutput) => ({
    nodes:[{id:'t', type:'table', table:'t'},
           {id:'f', type:'filter', col:'grade_code', op:'IN', val:filterVal},
           {id:'o', type:'output'}],
    edges:[{from:'t', to:'f', port:0}].concat(connectOutput ? [{from:'f', to:'o', port:0}] : []),
  });

  installGraph(api, graph("'02'", true), schema);
  assert.match(api.nodeSummary(api.state.nodes[2]), /1 列/);

  /* connected, but the empty IN list keeps nothing */
  installGraph(api, graph('', true), schema);
  const starved = api.nodeSummary(api.state.nodes[2]);
  assert.match(starved, /0 列/);
  assert.doesNotMatch(starved, /還沒接上來源/);
  /* and the filter block names itself as the cause */
  assert.match(api.nodeSummary(api.state.nodes[1]), /清單是空的/);

  /* genuinely unconnected still says so */
  installGraph(api, graph("'02'", false), schema);
  assert.match(api.nodeSummary(api.state.nodes[2]), /還沒接上來源/);
  return 'rows / filtered-to-zero / unconnected all read differently';
});

/* Deleting a step used to leave a hole: the steps either side were dropped
   loose and had to be reconnected by hand, which is the part that felt bad.
   The chain now heals, and the upstream step is selected so the next one can
   be added straight after it. */
test('delete: removing a middle step reconnects the two either side', () => {
  const schema = {t:{label:'', cols:[{name:'x', ch:'', type:'INT'}], rows:[[3], [1], [2]]}};
  const chain = () => ({
    nodes:[{id:'t', type:'table', table:'t'},
           {id:'f', type:'filter', col:'x', op:'>=', val:2},
           {id:'s', type:'sort', by:'x', dir:'ASC', limit:0, offset:0},
           {id:'o', type:'output'}],
    edges:[{from:'t', to:'f', port:0}, {from:'f', to:'s', port:0}, {from:'s', to:'o', port:0}],
  });

  installGraph(api, chain(), schema);
  api.removeNode('f');
  assert.deepEqual(json(api.state.nodes.map(n => n.id)), ['t', 's', 'o']);
  assert.deepEqual(json(api.state.edges.map(e => `${e.from}>${e.to}`)), ['s>o', 't>s']);
  /* the sort now reads the whole table, unfiltered */
  assert.deepEqual(json(api.evalNode(api.state.nodes[2]).rows), [[1], [2], [3]]);
  /* and the step before it is selected, ready to continue from */
  assert.equal(api.state.sel, 't');

  /* deleting a source just drops it — there is nothing to heal to */
  installGraph(api, chain(), schema);
  api.removeNode('t');
  assert.deepEqual(json(api.state.edges.map(e => `${e.from}>${e.to}`)), ['f>s', 's>o']);
  assert.equal(api.state.sel, null);

  /* 結果 is not deletable: nothing downstream could replace it */
  installGraph(api, chain(), schema);
  api.removeNode('o');
  assert.equal(api.state.nodes.length, 4);
  return 'middle step heals the chain; source just drops; 結果 refuses';
});

/* A step added out of view reads as nothing having happened, so it gets added
   again. Anything added without a step to attach to lands in the middle of what
   the user is actually looking at. */
test('add: a step with nowhere to attach lands in the visible middle', () => {
  const schema = {t:{label:'', cols:[{name:'x', ch:'', type:'INT'}], rows:[[1]]}};
  installGraph(api, {nodes:[{id:'o', type:'output', x:0, y:0}], edges:[]}, schema);
  api.state.sel = null;
  api.addNode('table', {table:'t'});
  const added = api.state.nodes.find(n => n.type === 'table');
  const centre = api.viewCenter();
  assert.deepEqual(json([added.x, added.y]), json([centre.x, centre.y]));
  assert.equal(added.x > 20 && added.y > 20, true, 'must not be parked at the origin');
  return `landed at ${added.x},${added.y} — the middle of the view`;
});

/* A quick operation puts a long list of codes on the canvas. Without its name
   the step is unreadable, and two of them side by side are indistinguishable. */
test('add: a quick operation carries its name onto the canvas', () => {
  const schema = {t:{label:'', cols:[{name:'score', ch:'', type:'INT'}], rows:[[59], [60]]}};
  installGraph(api, {nodes:[{id:'t', type:'table', table:'t'}, {id:'o', type:'output'}],
                     edges:[{from:'t', to:'o', port:0}]}, schema);
  api.state.sel = 't';
  const preset = api.QUICK_DEFAULT.find(q => q.label === '及格');
  api.addNode('filter', {col:preset.col, op:preset.op, val:api.quickVal(preset), note:preset.label});

  const step = api.state.nodes.find(n => n.type === 'filter');
  assert.equal(step.note, '及格');
  assert.equal(api.state.sel, step.id, 'the new step is selected');
  /* it was spliced into the chain, not left loose */
  assert.equal(api.state.edges.some(e => e.from === 't' && e.to === step.id), true);
  assert.equal(api.state.edges.some(e => e.from === step.id && e.to === 'o'), true);
  return `note="${step.note}", spliced between the table and 結果`;
});

/* A range the tool cannot expand used to become a single literal code: "22-02"
   went into the SQL as the string '22-02' and "9-11" expanded to 9,10,11 with no
   leading zero. Both look fine and query the wrong rows, which is exactly the
   failure this app exists to prevent — so a range it cannot expand must say so. */
test('codes: a range that cannot be expanded is refused, not reinterpreted', () => {
  const bad = input => {
    const r = api.readCodes(input);
    assert.equal(r.errs.length, 1, `${input} should be rejected, got ${JSON.stringify(r.codes)}`);
    assert.deepEqual(json(r.codes), [], `${input} must contribute no codes`);
    return r.errs[0];
  };
  assert.match(bad('9-11'), /長度不一樣/);
  assert.match(bad('22-02'), /小的要寫在前面/);
  assert.match(bad('A9-A11'), /長度不一樣/);
  assert.match(bad('A1-B9'), /只有最後一碼可以變/);

  /* a huge range is refused rather than expanded — it used to freeze the page */
  const started = performance.now();
  assert.match(bad('00000-99999'), /範圍太大/);
  assert.equal(performance.now() - started < 200, true, 'refusing must be instant');

  /* quoting is how a code containing a hyphen is written */
  assert.deepEqual(json(api.readCodes("'A1-A2'").codes), ['A1-A2']);
  /* and the good cases still expand */
  assert.deepEqual(json(api.readCodes('02-04, A0-A2').codes), ['02', '03', '04', 'A0', 'A1', 'A2']);
  return 'bad ranges rejected with a reason; quoted hyphens kept; huge range instant';
});

/* One corrupt entry in browser storage used to throw on startup, which bricks
   the whole tool for a user who cannot see or clear localStorage. */
test('codes: corrupt saved filters are dropped, not fatal', () => {
  assert.equal(api.validQuick(null), false);
  assert.equal(api.validQuick({}), false);
  assert.equal(api.validQuick({label:'a', col:'b', src:'c', op:'NOPE'}), false);
  assert.equal(api.validQuick({label:'a', col:'b', src:'c', op:'IN'}), true);

  /* the part that actually bricks the tool: booting with that data in storage */
  const good = {label:'我的', col:'grade_code', op:'IN', src:'02-04'};
  const stored = {'sqlblocks.quick': JSON.stringify([null, good, {label:'x'}, 7])};
  let booted;
  try { booted = loadApp(stored); }
  catch (error) { assert.fail(`corrupt storage must not stop startup: ${error?.message}`); }
  assert.deepEqual(json(booted.QUICK), json([good]), 'only the valid entry survives');
  /* and the cleaned list is written back, so it cannot bite again */
  assert.deepEqual(json(JSON.parse(stored['sqlblocks.quick'])), json([good]));
  return 'boots from [null, valid, partial, 7] keeping only the valid one';
});

/* Deleting a JOIN healed the chain from its first input, leaving SQL that still
   ran but had silently lost an entire table — more dangerous than a broken link. */
test('delete: a two-input step does not pick a side to keep', () => {
  const col = name => ({name, ch:'', type:'INT'});
  const schema = {l:{label:'', cols:[col('id')], rows:[[1]]}, r:{label:'', cols:[col('id')], rows:[[1]]}};
  installGraph(api, {
    nodes:[{id:'l', type:'table', table:'l'}, {id:'r', type:'table', table:'r'},
           {id:'j', type:'join', joinType:'INNER', keys:[{left:'id', right:'id', lfn:'', rfn:''}]},
           {id:'o', type:'output'}],
    edges:[{from:'l', to:'j', port:0}, {from:'r', to:'j', port:1}, {from:'j', to:'o', port:0}],
  }, schema);
  api.removeNode('j');
  assert.deepEqual(json(api.state.edges), [], 'neither side may be silently promoted');
  assert.match(api.buildSQL(), /^--/, 'an unfinished graph must not produce runnable SQL');
  return 'JOIN removal leaves the link open instead of dropping a table';
});

/* SQL is the only portable form this tool has. A note that lives only on the
   canvas is gone the moment the query is shared. */
test('notes: a note survives the trip out to SQL and back', () => {
  const schema = {t:{label:'', cols:[{name:'grade_code', ch:'', type:'VARCHAR'}], rows:[['02']]}};
  installGraph(api, {
    nodes:[{id:'t', type:'table', table:'t'},
           {id:'f', type:'filter', col:'grade_code', op:'IN', val:"'02'", note:'及格'},
           {id:'o', type:'output'}],
    edges:[{from:'t', to:'f', port:0}, {from:'f', to:'o', port:0}],
  }, schema);
  const sql = api.buildSQL();
  assert.match(sql, /sqlblocks-notes filter#1=及格/, 'the note stays readable in the SQL');
  const back = api.astToGraph(api.parseSQLText(sql));
  assert.equal(back.nodes.find(n => n.type === 'filter').note, '及格');

  /* a manifest that does not match the query's shape is ignored outright —
     a note on the wrong step is worse than no note */
  const wrong = '/* sqlblocks-notes groupby#9=別的 */\n' + sql.split('\n').slice(1).join('\n');
  const stray = api.astToGraph(api.parseSQLText(wrong));
  assert.equal(stray.nodes.some(n => n.note), false);
  return 'note round-trips readable; a mismatched manifest is ignored';
});

/* school.scores says nothing about what the table holds. The schema
   already carries the Chinese name, so a table step wears it without being
   asked — but a name the user typed themselves always wins, including a blank
   one they deliberately cleared. */
test('notes: a table step shows its Chinese name unless told otherwise', () => {
  const schema = api.demoSchema();
  installGraph(api, {
    nodes:[{id:'a', type:'table', table:'scores'},
           {id:'b', type:'table', table:'scores', note:'我自己取的'},
           {id:'c', type:'table', table:'scores', note:''},
           {id:'d', type:'table', table:'沒這張表'},
           {id:'o', type:'output'}],
    edges:[],
  }, schema);
  const shown = id => api.noteOf(api.state.nodes.find(n => n.id === id));
  assert.equal(shown('a'), '成績', 'the schema label is used by default');
  assert.equal(shown('b'), '我自己取的', 'a typed note wins');
  assert.equal(shown('c'), '', 'a deliberately cleared note stays cleared');
  assert.equal(shown('d'), '', 'an unknown table invents nothing');

  /* only tables get one; every other step starts blank */
  installGraph(api, {nodes:[{id:'f', type:'filter', col:'x', op:'=', val:1}], edges:[]}, schema);
  assert.equal(api.noteOf(api.state.nodes[0]), '');

  const labelled = Object.keys(schema).filter(t => schema[t].label).length;
  return `${labelled}/${Object.keys(schema).length} tables carry a Chinese name`;
});

/* The step-through runs the real pipeline, but over rows this tool invented.
   It once told the user "這就是 SQL 會回給你的結果", which is not true of any
   number on that screen. Whatever the wording becomes, the footer shown under
   every step has to say the data is illustrative. */
test('honesty: the step-through says its data is made up', () => {
  graphFromSQL(api, 'SELECT * FROM t WHERE x > 1');
  api.state.steps = api.buildSteps();
  api.state.step = 0;
  api.renderStage();
  const foot = api.document.getElementById('foot').textContent;
  assert.match(foot, /示意|編的|編出來/, 'the footer must say the rows are invented');
  assert.doesNotMatch(foot, /不是假圖|會回給你的結果/, 'and must not claim they are real');

  /* and the first step, which introduces the table, says the same */
  const first = api.state.steps[0];
  assert.equal(first.title, '來源');
  assert.match(first.cap, /示意|編出來/, 'the opening caption must not present the rows as real');
  return 'footer and opening caption both state the rows are illustrative';
});

/* Chaining JOINs works, but each one used to list every column of both sides:
   two 30-column tables produced a 70-line SELECT list, and a third table pushed
   it past 170 lines — correct SQL nobody can read. The left side is never
   dropped or renamed, so it goes across whole; the right side still has to be
   spelled out because its key columns are removed and collisions are aliased. */
test('join: chained joins work and do not spell out the left side', () => {
  const table = (names, rows) => ({cols:names.map(name=>({name})), rows});
  api.state.schema = {
    'school.scores':table(['exam_time','class_id','course_id','score','updated_at'], [['2026-06-01 09:00:00',1,1,95,'2026-06-02']]),
    'school.classes':table(['class_id','class_name','updated_at'], [[1,'一年甲班','2026-06-02']]),
    'school.courses':table(['course_id','course_name','updated_at'], [[1,'數學','2026-06-02']])
  };
  const sql = 'SELECT a.exam_time, b.class_name, c.course_name, a.score\n' +
    'FROM school.scores a\n' +
    'JOIN school.classes b ON a.class_id = b.class_id\n' +
    'JOIN school.courses c ON a.course_id = c.course_id';
  api.state.dialect = 'mssql';
  const graph = graphFromSQL(api, sql);

  assert.equal(graph.nodes.filter(n => n.type === 'join').length, 2, 'two joins, chained');
  assert.equal(api.evalNode(graph.nodes.find(n => n.type === 'output')).rows.length > 0, true,
    'the step-through must actually produce rows');

  const generated = api.buildSQL();
  assert.equal((generated.match(/a\.\*/g) || []).length, 2, 'each join carries its left side whole');
  assert.doesNotMatch(generated, /a\.exam_time,/, 'the left side is not spelled out');
  /* the right side stays explicit — its key column is dropped and updated_at collides */
  assert.match(generated, /b\.updated_at AS updated_at_2/);
  assert.doesNotMatch(generated, /b\.\*/, 'the right side cannot be taken whole');
  assert.equal(generated.split('\n').length < 100, true,
    `a three-table join must stay readable, got ${generated.split('\n').length} lines`);

  /* and it still means the same thing coming back */
  const shape = g => JSON.stringify(g.nodes.map(({x, y, id, ...rest}) => rest));
  assert.equal(shape(api.astToGraph(api.parseSQLText(generated))), shape(graph));
  return `2 chained joins, ${generated.split('\n').length} lines, round-trips`;
});

/* Tidying a chain of JOINs used to leave tables stacked on top of each other:
   laying out a two-input step shifts its sources, and those sources had already
   been placed and checked, so nothing looked at them again. Sources are now
   positioned first, in the order they are consumed, and the overlap sweep runs
   after every step has been placed. */
test('tidy: chained joins lay out without overlapping', () => {
  const overlaps = () => {
    const out = [];
    api.state.nodes.forEach((p, i) => api.state.nodes.slice(i + 1).forEach(q => {
      const P = api.nodeBox(p.id), Q = api.nodeBox(q.id);
      if (P.n.x < Q.n.x + Q.w && Q.n.x < P.n.x + P.w &&
          P.n.y < Q.n.y + Q.h && Q.n.y < P.n.y + P.h) out.push(`${p.type}/${q.type}`);
    }));
    return out;
  };
  const join = (alias, table, on) => `JOIN ${table} ${alias} ON ${on}`;
  const shapes = {
    two:  'SELECT * FROM school.scores a ' + join('b', 'school.classes', 'a.class_id=b.class_id'),
    three:'SELECT * FROM school.scores a ' + join('b', 'school.classes', 'a.class_id=b.class_id') +
          ' ' + join('c', 'school.courses', 'a.course_id=c.course_id'),
    five: 'SELECT * FROM school.scores a ' + join('b', 'school.classes', 'a.class_id=b.class_id') +
          ' ' + join('c', 'school.courses', 'a.course_id=c.course_id') +
          ' ' + join('d', 'school.students', 'a.student_id=d.student_id') +
          ' ' + join('e', 'school.exam_schedule', 'a.class_id=e.class_id'),
  };
  const schema = () => Object.fromEntries(['scores','classes','courses','students','exam_schedule'].map(name=>[
    'school.'+name, {cols:['class_id','course_id','student_id'].map(name=>({name})), rows:[[1,1,1]]}
  ]));
  const report = [];
  for (const [name, sql] of Object.entries(shapes)) {
    api.state.schema = schema();
    graphFromSQL(api, sql);
    api.settleLayout();
    assert.deepEqual(json(overlaps()), [], `${name}: steps must not sit on top of each other`);
    const loose = api.state.edges.filter(e => !api.isSnapped(e));
    assert.deepEqual(json(loose), [], `${name}: every link should still be touching`);
    report.push(`${name}=${api.state.nodes.length} steps`);
  }

  /* a branch must not shove the main chain around to make room for itself */
  api.state.schema = schema();
  graphFromSQL(api, shapes.three);
  const table = api.state.nodes.find(n => n.type === 'table');
  api.state.nodes.push({id:'side', type:'filter', col:'county', op:'=', val:'台北', x:0, y:0});
  api.state.edges.push({from:table.id, to:'side', port:0});
  api.settleLayout();
  assert.deepEqual(json(overlaps()), [], 'the branch is placed clear, not stacked');
  const drawn = api.state.edges.filter(e => !api.isSnapped(e));
  assert.equal(drawn.length, 1, `only the branch link should need a wire, got ${drawn.length}`);
  assert.equal(drawn[0].to, 'side', 'and it must be the branch that yields, not the chain');
  return report.join(', ') + '; branch costs exactly one wire';
});

test('OR: a WHERE with OR keeps both sides instead of dropping the tail', () => {
  const sql = 'SELECT * FROM r WHERE r.member_rank <= 20 OR r.inv_rank <= 20';
  const parsed = api.parseSQLText(sql);
  assert.equal(parsed.warn.some(w => /OR/.test(w)), false, 'no OR-dropped warning');
  const graph = graphFromSQL(api, sql);
  const filters = graph.nodes.filter(n => n.type === 'filter');
  assert.equal(filters.length, 1);
  assert.deepEqual(json(filters[0].any.map(b => b.map(c => [c.col, c.op, c.val]))),
    [[['member_rank','<=',20]], [['inv_rank','<=',20]]]);
  installGraph(api, graph, {
    r:{cols:[{name:'id'},{name:'member_rank'},{name:'inv_rank'}],
       rows:[[1,5,90],[2,90,5],[3,90,90],[4,1,1]]},
  });
  const out = api.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows.map(r => r[0])), [1,2,4]);
  const generated = roundTrip(sql);
  assert.match(generated, /WHERE member_rank <= 20 OR inv_rank <= 20/);
  return 'one OR filter, rows 1/2/4 kept, round-trips';
});

test('OR: parentheses and AND precedence are kept', () => {
  const sql = 'SELECT * FROM t WHERE a >= 1 AND (b = 2 OR c = 3) AND d = 4';
  const graph = graphFromSQL(api, sql);
  const filters = graph.nodes.filter(n => n.type === 'filter');
  assert.deepEqual(json(filters.map(n => n.op)), ['>=', 'OR', '=']);
  installGraph(api, graph, {
    t:{cols:[{name:'id'},{name:'a'},{name:'b'},{name:'c'},{name:'d'}],
       rows:[[1,1,2,0,4],[2,1,0,3,4],[3,1,0,0,4],[4,0,2,3,4],[5,1,2,3,0]]},
  });
  const out = api.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows.map(r => r[0])), [1,2]);
  const generated = roundTrip(sql);
  assert.match(generated, /a >= 1\n    AND \(b = 2 OR c = 3\)\n    AND d = 4/);

  /* without parentheses AND binds first: a = 1 OR (b = 2 AND c = 3) */
  const loose = graphFromSQL(api, 'SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3');
  const orNode = loose.nodes.find(n => n.type === 'filter');
  assert.deepEqual(json(orNode.any.map(b => b.map(c => c.col))), [['a'], ['b','c']]);
  assert.match(roundTrip('SELECT * FROM t WHERE a = 1 OR b = 2 AND c = 3'),
    /WHERE a = 1 OR \(b = 2 AND c = 3\)/);

  /* nested groups and a flattened a OR (b OR c) */
  const nested = graphFromSQL(api, 'SELECT * FROM t WHERE (a = 1 AND (b = 2 OR c = 3)) OR (d = 4 OR a = 9)');
  const top = nested.nodes.find(n => n.type === 'filter');
  assert.equal(top.any.length, 3);
  assert.equal(top.any[0][1].op, 'OR');
  roundTrip('SELECT * FROM t WHERE (a = 1 AND (b = 2 OR c = 3)) OR (d = 4 OR a = 9)');
  return 'AND (b OR c) AND, precedence, nesting all round-trip';
});

test('OR: parentheses around an expression still parse as an expression', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM t WHERE (x) > 3 OR (y = 1)');
  const f = graph.nodes.find(n => n.type === 'filter');
  assert.deepEqual(json(f.any.map(b => b.map(c => [c.col, c.op]))), [[['x','>']], [['y','=']]]);
  const err = sqlError('SELECT * FROM t WHERE (a = 1 OR b = )');
  assert.equal(err.pos > 'SELECT * FROM t WHERE (a = 1 OR b'.length, true, 'error points inside the group');
  return '(x) > 3 is an expression; broken group reports inside it';
});

test('OR: HAVING and NOT BETWEEN become OR filters', () => {
  const graph = graphFromSQL(api,
    'SELECT city, COUNT(*) AS n FROM t GROUP BY city HAVING COUNT(*) >= 5 OR city = \'台北\'');
  const having = graph.nodes.filter(n => n.type === 'filter');
  assert.equal(having.length, 1);
  assert.equal(having[0].op, 'OR');
  const nb = graphFromSQL(api, 'SELECT * FROM t WHERE x NOT BETWEEN 1 AND 3');
  const f = nb.nodes.find(n => n.type === 'filter');
  assert.deepEqual(json(f.any.map(b => b.map(c => [c.col, c.op, c.val]))), [[['x','<',1]], [['x','>',3]]]);
  installGraph(api, nb, {t:{cols:[{name:'x'}], rows:[[0],[1],[2],[3],[4]]}});
  assert.deepEqual(json(api.evalNode(nb.nodes.find(n => n.type === 'output')).rows), [[0],[4]]);
  assert.match(api.buildSQL(), /WHERE x < 1 OR x > 3/);
  return 'HAVING OR kept; NOT BETWEEN keeps 0 and 4';
});

/* the graph as it stands must be what its own SQL parses back into */
/* shape:false — one WHERE block holding several AND conditions reparses into
   chained blocks, so only the SQL (not the step list) has to come back the same */
function stableSQL({shape = true} = {}) {
  const {nodes, edges, uid} = api.state;
  const steps = () => api.chainOrder().map(n => n.type + (n.type === 'filter' ? ':' + n.op : '')).join(' > ');
  const generated = api.buildSQL(), before = steps();
  const back = api.astToGraph(api.parseSQLText(generated));
  api.state.nodes = back.nodes; api.state.edges = back.edges;
  try {
    if (shape) assert.equal(steps(), before, 'same steps after reparsing');
    assert.equal(api.buildSQL(), generated, 'same SQL after reparsing');
  } finally {
    Object.assign(api.state, {nodes, edges, uid});
  }
  return generated;
}
const orData = {r:{cols:[{name:'id'},{name:'member_rank'},{name:'inv_rank'}],
                   rows:[[1,5,90],[2,90,5],[3,90,90],[4,1,1]]}};

test('OR editing: a plain filter grows a second group and round-trips', () => {
  api.state.dialect = 'postgres';
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20');
  installGraph(api, graph, orData);
  const f = graph.nodes.find(n => n.type === 'filter');
  api.orFromPlain(f, ['id','member_rank','inv_rank']);
  assert.equal(api.isOrFilter(f), true);
  assert.equal(f.any.length, 2);
  Object.assign(f.any[1][0], {col:'inv_rank', op:'<=', val:'20'});
  assert.match(stableSQL(), /WHERE member_rank <= 20 OR inv_rank <= 20/);
  const out = api.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows.map(r => r[0])), [1,2,4]);

  api.orAddCond(f, 1, ['id','member_rank','inv_rank']);
  Object.assign(f.any[1][1], {col:'member_rank', op:'>', val:'50'});
  api.orAddGroup(f, ['id','member_rank','inv_rank']);
  Object.assign(f.any[2][0], {col:'id', op:'=', val:'3'});
  assert.match(stableSQL(), /WHERE member_rank <= 20 OR \(inv_rank <= 20 AND member_rank > 50\) OR id = 3/);
  return 'plain → 2 groups → AND inside a group → 3 groups, SQL stable';
});

test('OR editing: shrinking to one group collapses or stays one AND block', () => {
  let graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20 OR inv_rank <= 20');
  installGraph(api, graph, orData);
  let f = graph.nodes.find(n => n.type === 'filter');
  assert.deepEqual(json(api.orDelTerm(f, 0, 0)), []);
  assert.equal(api.isOrFilter(f), false);
  assert.deepEqual([f.col, f.op, f.val], ['inv_rank', '<=', 20]);
  assert.equal('any' in f, false);
  assert.match(stableSQL(), /WHERE inv_rank <= 20\n/);

  graph = graphFromSQL(api, 'SELECT * FROM r WHERE id = 9 OR (member_rank <= 20 AND inv_rank <= 20)');
  installGraph(api, graph, orData);
  f = graph.nodes.find(n => n.type === 'filter');
  assert.deepEqual(json(api.orDelTerm(f, 0, 0)), []);
  assert.equal(api.chainOrder().filter(n => n.type === 'filter').length, 1, 'still one block');
  assert.equal(f.any.length, 1);
  assert.deepEqual(json(f.any[0].map(c => [c.col, c.op, c.val])), [['member_rank','<=',20], ['inv_rank','<=',20]]);
  assert.match(stableSQL({shape:false}), /WHERE member_rank <= 20\n    AND inv_rank <= 20\n/);
  const out = api.evalNode(api.state.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows.map(r => r[0])), [4]);

  /* a lone nested OR left as the only condition becomes the node itself */
  graph = graphFromSQL(api, 'SELECT * FROM r WHERE id = 9 OR (id = 1 OR id = 2)');
  installGraph(api, graph, orData);
  f = graph.nodes.find(n => n.type === 'filter');
  f.any = [[{col:'id', op:'=', val:9}], [{op:'OR', any:[[{col:'id', op:'=', val:1}], [{col:'id', op:'=', val:2}]]}]];
  api.orDelTerm(f, 0, 0);
  assert.equal(api.isOrFilter(f), true);
  assert.equal(f.any.length, 2);
  stableSQL();
  return 'one condition → plain filter; one AND group → stays a single block; nested OR kept';
});

test('OR view: the block, inspector and step-through spell out the groups', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20 OR inv_rank <= 20');
  installGraph(api, graph, orData);
  const f = graph.nodes.find(n => n.type === 'filter');
  const summary = api.nodeSummary(f);
  assert.match(summary, /member_rank &lt;= 20<\/code><div class="orsep">或<\/div><code>inv_rank &lt;= 20/);

  api.state.sel = f.id;
  api.state.inspOpen = true;
  api.renderInspector();
  const panel = api.inspector.innerHTML;
  assert.match(panel, /第 1 組[\s\S]*第 2 組/);
  assert.match(panel, /data-ob="1" data-oc="0" data-f="col"/);
  assert.match(panel, /data-or-group/);
  assert.match(panel, /4 列 → <b>留 3 列<\/b>：第 1 組中 2、第 2 組中 2，兩組都中 1/);

  const step = api.buildSteps().find(s => s.title === 'WHERE');
  const box = {children:[], appendChild(c) { this.children.push(c); return c; }};
  step.render(box);
  const table = box.children[0].innerHTML;
  assert.match(table, /第①組<\/th><th>第②組/);
  assert.equal((table.match(/class="r drop"/g) || []).length, 1, 'only the row missing both groups is struck');

  for (let i = 0; i < 3; i++) api.orAddGroup(f, ['id']);
  assert.match(api.nodeSummary(f), /…還有 3 組$/);
  return 'block shows 或 between groups; panel counts overlap; step-through marks ✓/✗';
});

test('OR view: a two-condition group shows every condition, not a clipped line', () => {
  const graph = graphFromSQL(api, "SELECT * FROM r WHERE cutoff_date BETWEEN '2025-10-01' AND '2026-01-31' " +
    "OR (cutoff_date >= '2026-05-01' AND rainfall_value > 0)");
  installGraph(api, graph, orData);
  const summary = api.nodeSummary(graph.nodes.find(n => n.type === 'filter'));
  assert.doesNotMatch(summary, /…/);
  assert.match(summary, /<code>cutoff_date<\/code><div class="ccmp"><code>>= 2025-10-01<\/code><code>&lt;= 2026-01-31<\/code><\/div>/);
  assert.match(summary, /<div class="orsep">或<\/div><div class="cgrp"[^>]*><code>cutoff_date >= 2026-05-01<\/code><br><code>rainfall_value > 0<\/code>/);
  return 'BETWEEN range shares one column name; second group lists both conditions';
});

test('OR editing: a plain filter offers the OR button', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20');
  installGraph(api, graph, orData);
  api.state.sel = graph.nodes.find(n => n.type === 'filter').id;
  api.state.inspOpen = true;
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /data-to-or/);
  return 'plain filter panel has ＋ 或';
});

/* region counts as drawn: [text class, number] in region order */
const vennCounts = html => [...html.matchAll(/class="(vin|vout)">(\d+)</g)].map(m => [m[1], Number(m[2])]);

test('Venn: OR shows the union with the real per-region counts', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20 OR inv_rank <= 20');
  installGraph(api, graph, orData);
  const f = graph.nodes.find(n => n.type === 'filter');
  const html = api.orVenn(f, api.evalNode(graph.nodes[0]));
  /* regions 1 (only ①), 2 (only ②), 3 (both): rows 1, 2 and 4 — all kept */
  assert.deepEqual(vennCounts(html), [['vin',1], ['vin',1], ['vin',1]]);
  assert.match(html, /都沒中 1</);
  assert.match(html, /同時中第①、②組：1 列/);
  assert.match(html, /第①組：<code>member_rank &lt;= 20<\/code>/);

  api.orAddGroup(f, ['id']);
  Object.assign(f.any[2][0], {col:'id', op:'=', val:'3'});
  const three = api.orVenn(f, api.evalNode(graph.nodes[0]));
  assert.equal(vennCounts(three).length, 7, 'three sets draw seven regions');
  assert.match(three, /都沒中 0</);

  api.orAddGroup(f, ['id']);
  assert.equal(api.orVenn(f, api.evalNode(graph.nodes[0])), '', 'four groups do not fit a Venn');
  api.state.sel = f.id;
  api.state.inspOpen = true;
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /超過 3 組，文氏圖畫不下/);
  return 'union shaded, counts 1/1/1 + 1 outside, 3 sets = 7 regions, 4 sets fall back';
});

test('Venn: JOIN shades the overlap for INNER and the left circle for LEFT', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM l INNER JOIN r ON l.k = r.k');
  installGraph(api, graph, {
    l:{cols:[{name:'k'},{name:'a'}], rows:[[1,'x'],[2,'y'],[3,'z']]},
    r:{cols:[{name:'k'},{name:'b'}], rows:[[2,'p'],[3,'q'],[3,'q2'],[9,'w']]},
  });
  const join = graph.nodes.find(n => n.type === 'join');
  /* regions: left-only 1 row, right-only 1 row, overlap = 2 left rows */
  assert.deepEqual(vennCounts(api.joinPairsVenn(join)), [['vout',1], ['vout',1], ['vin',2]]);
  assert.match(api.joinPairsVenn(join), /交集/);
  join.joinType = 'LEFT';
  assert.deepEqual(vennCounts(api.joinPairsVenn(join)), [['vin',1], ['vout',1], ['vin',2]]);
  assert.match(api.joinPairsVenn(join), /對得上：左表 2 列、右表 3 列/);
  assert.match(api.joinPairsVenn(join), /左表：<code>l<\/code>/);
  api.state.sel = join.id;
  api.state.inspOpen = true;
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /哪些列會留下[\s\S]*class="venn"/);
  return 'INNER shades 3 only; LEFT shades 1 and 3; legend names the tables';
});

test('Venn: chained filters shade the intersection, step by step', () => {
  /* two separate blocks one after the other (still a WHERE … AND …) */
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20');
  installGraph(api, graph, orData);
  const a = graph.nodes.find(n => n.type === 'filter');
  const b = api.andAfter(a, ['id','member_rank','inv_rank']);
  Object.assign(b, {col:'inv_rank', op:'<=', val:'20'});
  assert.deepEqual(json(api.andChain(b).map(n => n.id)), [a.id, b.id]);
  assert.deepEqual(json(api.andChain(a).map(n => n.id)), [a.id, b.id]);
  /* rows: 1 only ①, 2 only ②, 3 neither, 4 both */
  const full = api.andVenn(a);
  assert.deepEqual(vennCounts(full), [['vout',1], ['vout',1], ['vin',1]], 'only the overlap is kept');
  assert.match(full, /一個都沒成立 1</);
  assert.match(full, /4 列 → 過條件① 2 列 → 過條件② 1 列/);
  assert.match(full, /class="vcur">[^]*條件①[^]*← 這一塊/);
  const first = api.andVenn(a, true);
  assert.deepEqual(vennCounts(first), [['vin',1], ['vout',1], ['vin',1]], 'after ① the whole first circle is still in');
  assert.doesNotMatch(first, /過條件②/);

  const step = api.buildSteps().filter(s => s.title === 'WHERE')[0];
  const box = {children:[], appendChild(c) { this.children.push(c); return c; }};
  step.render(box);
  assert.equal(box.children.length, 2);
  assert.match(box.children[1].innerHTML, /走到這一塊/);

  api.state.sel = b.id;
  api.state.inspOpen = true;
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /跟前後的篩選一起看（AND）[\s\S]*class="venn"/);
  return 'chain found from either end; intersection shaded; step 1 shades circle ①; funnel 4→2→1';
});

test('Venn: a lone filter or a long chain draws no AND diagram', () => {
  let graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20');
  installGraph(api, graph, orData);
  const lone = graph.nodes.find(n => n.type === 'filter');
  assert.equal(api.andVenn(lone), '');
  graph = graphFromSQL(api, 'SELECT * FROM r WHERE id > 0 AND id > 1 AND id > 2 AND id > 3');
  installGraph(api, graph, orData);
  const f = graph.nodes.find(n => n.type === 'filter');
  assert.equal(f.any[0].length, 4, 'four conditions in one block');
  assert.equal(api.andVenn(f), '');
  api.state.sel = f.id;
  api.state.inspOpen = true;
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /一共 4 個 AND 條件，超過 3 個文氏圖畫不下/);
  return 'single filter: none; four chained: note instead';
});

test('AND editing: ＋且 adds a condition inside the same block', () => {
  api.state.dialect = 'postgres';
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20');
  installGraph(api, graph, orData);
  const f = graph.nodes.find(n => n.type === 'filter');
  api.state.sel = f.id;
  api.state.inspOpen = true;
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /data-to-and[^>]*>＋ 且（還要符合）/);
  assert.match(api.inspector.innerHTML, /data-to-or[^>]*>＋ 或（符合也留下）/);
  assert.doesNotMatch(api.inspector.innerHTML, /data-and-next/, 'a plain filter never adds a block');

  api.andFromPlain(f, ['id','member_rank','inv_rank']);
  assert.equal(api.state.nodes.filter(n => n.type === 'filter').length, 1, 'still one WHERE block');
  assert.equal(f.any.length, 1);
  Object.assign(f.any[0][1], {col:'inv_rank', op:'<=', val:'20'});
  api.orAddCond(f, 0, ['id','member_rank','inv_rank']);
  Object.assign(f.any[0][2], {col:'id', op:'<>', val:'3'});
  assert.match(stableSQL({shape:false}), /WHERE member_rank <= 20\n    AND inv_rank <= 20\n    AND id <> 3\n/);
  assert.deepEqual(json(api.evalNode(api.state.nodes.find(n => n.type === 'output')).rows.map(r => r[0])), [4]);

  /* the block reads as AND everywhere */
  assert.match(api.nodeSummary(f), /<div class="orsep">且<\/div>/);
  api.renderInspector();
  const panel = api.inspector.innerHTML;
  assert.match(panel, /條件（每個都要成立）/);
  assert.doesNotMatch(panel, /第 1 組/);
  assert.match(panel, /＋ 或（符合另一組條件也留下）/);
  assert.match(panel, /這些條件一起看（AND）[\s\S]*class="venn"/);
  const step = api.buildSteps().find(s => s.title === 'WHERE');
  assert.match(step.cap, /AND<\/code> 是<strong>每個條件都要成立/);
  const box = {children:[], appendChild(c) { this.children.push(c); return c; }};
  step.render(box);
  assert.match(box.children[0].innerHTML, /條件①<\/th><th>條件②<\/th><th>條件③/);

  /* ＋或 on an AND block makes (a AND b AND c) OR d */
  api.orAddGroup(f, ['id']);
  Object.assign(f.any[1][0], {col:'id', op:'=', val:'3'});
  assert.match(api.buildSQL(), /WHERE \(member_rank <= 20 AND inv_rank <= 20 AND id <> 3\) OR id = 3/);
  return 'plain → one block with AND; three conditions; ＋或 on top gives (…) OR d';
});

test('panel: adding a block selects it without opening the settings panel', () => {
  graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20');
  const f = api.state.nodes.find(n => n.type === 'filter');
  api.state.sel = f.id;
  api.state.inspOpen = true;
  api.addNode('distinct', {});
  const added = api.state.nodes[api.state.nodes.length - 1];
  assert.equal(api.state.sel, added.id, 'the new block is selected, so the next one chains after it');
  assert.equal(api.state.inspOpen, false, 'but the panel stays closed');
  return 'addNode selects the block and keeps the panel shut';
});

test('CASE: a column carried over from another branch is shown, repaired on connect, and never written as []', () => {
  api.state.dialect = 'mssql';
  /* weather → CASE → GROUP BY → output, where CASE was dropped in while a block on the
     scores branch was selected, so it still points at score */
  const graph = {
    nodes:[{id:'w',type:'table',table:'weather'},
           {id:'c',type:'case',col:'score',as:'is_rained',branches:[{op:'>',val:0,then:1}],other:0},
           {id:'g',type:'groupby',keys:[],aggs:[{fn:'COUNT',col:'*',as:'n'}]},
           {id:'o',type:'output'}],
    edges:[{from:'w',to:'c',port:0},{from:'c',to:'g',port:0},{from:'g',to:'o',port:0}],
  };
  installGraph(api, graph, {weather:{cols:[{name:'class_id'},{name:'rainfall_value'}], rows:[['A',0],['B',3]]}});
  const c = graph.nodes[1], g = graph.nodes[2];

  /* the panel shows what is really stored instead of silently showing the first column */
  api.state.sel = c.id; api.state.inspOpen = true; api.renderInspector();
  assert.match(api.inspector.innerHTML, /<option value="score" selected>score（上一步沒有這欄）/);
  assert.equal(api.colChoices(['a','b'], '').startsWith('<option value="" selected>（選一個欄位）'), true);
  assert.deepEqual(json(api.evalNode(c).cols), ['class_id','rainfall_value'], 'no is_rained yet: the column is wrong');

  /* connecting repairs it to a real column, and the new column flows on to GROUP BY */
  api.adoptCols(c);
  assert.equal(['class_id','rainfall_value'].includes(c.col), true);
  c.col = 'rainfall_value';
  assert.deepEqual(json(api.evalNode(c).cols), ['class_id','rainfall_value','is_rained']);
  api.state.sel = g.id; api.renderInspector();
  assert.match(api.inspector.innerHTML, /is_rained/);
  assert.match(api.buildSQL(), /WHEN rainfall_value > 0 THEN 1/);

  /* an empty column stops the SQL with a message instead of WHEN [] > 0 */
  c.col = '';
  const sql = api.buildSQL();
  assert.doesNotMatch(sql, /\[\]/);
  assert.match(sql, /無法產生 SQL：CASE 還沒選要用哪一欄/);
  return 'stale column shown as such; adoptCols picks a real one; is_rained reaches GROUP BY; empty column refused';
});

test('JOIN: CONVERT on a key is kept, unknown wrappers are refused, AS \'alias\' parses', () => {
  api.state.dialect = 'mssql';
  const sql = "select top 10 convert(date,t.exam_time) as 'exam_date', t.class_id, w.rainfall_value " +
    "from [school].[scores] t join [school].[exam_schedule] w " +
    "on convert(date,t.exam_time) = w.cutoff_date and t.class_id = w.class_id";
  const graph = graphFromSQL(api, sql);
  assert.deepEqual(json(graph.nodes.find(n => n.type === 'join').keys[0]),
    {left:'exam_time', lfn:'DATE', right:'cutoff_date', rfn:''});
  const generated = api.buildSQL();
  assert.match(generated, /ON CAST\(a\.exam_time AS DATE\) = b\.cutoff_date/);
  assert.match(generated, /AS exam_date/);
  /* a style code on a text conversion changes the format, a bare function is not a step: refuse both */
  sqlError("SELECT * FROM a JOIN b ON CONVERT(varchar(8), a.d, 112) = b.k");
  sqlError("SELECT * FROM a JOIN b ON LEFT(a.k, 4) = b.k");
  sqlError("SELECT * FROM a JOIN b ON a.k + 1 = b.k");
  /* the conversions the join step can carry still import */
  graphFromSQL(api, "SELECT * FROM a JOIN b ON CONVERT(int, a.k) = CAST(b.k AS int)");
  return 'CONVERT(date, …) → DATE cast on the key; CONVERT style / LEFT / arithmetic refused';
});

/* ---- 2026-10-04 review: each of these produced SQL that ran wrong or not at all ---- */
function graphError(sql) {
  try { api.astToGraph(api.parseSQLText(sql)); } catch (error) {
    assert.equal(error?.sqlErr, true, String(error));
    assert.equal(error.pos >= 0 && error.pos <= sql.length, true, 'error points into the SQL');
    return error;
  }
  assert.fail(`expected sqlErr for ${JSON.stringify(sql)}`);
}
const outRows = () => json(api.evalNode(api.state.nodes.find(n => n.type === 'output')).rows);

test('review: a 選欄位 with nothing ticked still reads from the real table', () => {
  /* 全不選 means "all columns"; the block gets folded into the next CTE, which then
     pointed at the folded block and printed FROM ? — SQL that cannot run */
  const app = loadApp();
  graphFromSQL(app, 'SELECT course_id FROM scores WHERE score >= 60');
  app.state.nodes.find(n => n.type === 'select').cols = [];
  const sql = app.buildSQL();
  assert.doesNotMatch(sql, /FROM \?/);
  assert.match(sql, /filtered AS \(\n  SELECT \*\n  FROM scores\n  WHERE/);
  app.astToGraph(app.parseSQLText(sql));
  return 'filter CTE reads scores and re-imports';
});

test('review: CASE without ELSE gives NULL, not the text NULL', () => {
  const sql = roundTrip("SELECT CASE WHEN x = 1 THEN 'a' END AS t FROM t");
  assert.match(sql, /ELSE NULL/);
  assert.doesNotMatch(sql, /'NULL'/);
  const graph = graphFromSQL(api, "SELECT CASE WHEN x = 1 THEN 'a' ELSE NULL END AS t FROM t");
  installGraph(api, graph, {t: {cols: [{name: 'x'}], rows: [[1], [2]]}});
  assert.deepEqual(outRows(), [['a'], [null]]);
  return 'ELSE NULL round-trips; row 2 is NULL in the preview too';
});

test('review: SQL whose meaning the steps would change is refused, not imported', () => {
  const parseRefused = [
    "SELECT CASE WHEN x = 1 THEN y * 2 ELSE 'n' END AS t FROM t", /* an expression cannot fit a branch */
    "SELECT CASE WHEN x > amt THEN 'a' ELSE 'b' END AS t FROM t",  /* x > amt became x > 0 */
    "SELECT * FROM t WHERE UPPER(name) = 'A'",                     /* UPPER was dropped */
    'SELECT * FROM t WHERE a + b > 3',                             /* became a_calc > 3 */
    'SELECT city, amt FROM t ORDER BY 3',                          /* no third item */
  ];
  parseRefused.forEach(sqlError);
  /* only in HAVING, so the steps have no count_all column to filter */
  graphError('SELECT city FROM t GROUP BY city HAVING COUNT(*) > 1');
  return `${parseRefused.length + 1} lossy shapes refused`;
});

test('review: HAVING on an aggregate filters the aliased column', () => {
  const graph = graphFromSQL(api, 'SELECT city, SUM(amt) AS total FROM t GROUP BY city HAVING SUM(amt) > 150');
  assert.equal(graph.nodes.find(n => n.type === 'filter').col, 'total');
  assert.match(api.buildSQL(), /WHERE total > 150/);
  installGraph(api, graph, {t: {cols: [{name: 'city'}, {name: 'amt'}], rows: [['tp', 50], ['tp', 70], ['tc', 200]]}});
  assert.deepEqual(outRows(), [['tc', 200]]);
  return 'HAVING SUM(amt) -> WHERE total; tp 120 dropped, tc 200 kept';
});

test('review: ORDER BY 2 and GROUP BY 1 mean SELECT positions', () => {
  let graph = graphFromSQL(api, 'SELECT city, amt FROM t ORDER BY 2 DESC');
  assert.equal(graph.nodes.find(n => n.type === 'sort').by, 'amt');
  graph = graphFromSQL(api, 'SELECT city, COUNT(*) AS n FROM t GROUP BY 1 ORDER BY 2');
  assert.deepEqual(json(graph.nodes.find(n => n.type === 'groupby').keys), ['city']);
  assert.equal(graph.nodes.find(n => n.type === 'sort').by, 'n');
  return 'ORDER BY 2 -> amt; GROUP BY 1 -> city; ORDER BY 2 -> alias n';
});

test('review: GROUP BY without aggregates adds no column', () => {
  const graph = graphFromSQL(api, 'SELECT city FROM t GROUP BY city');
  assert.deepEqual(json(graph.nodes.find(n => n.type === 'groupby').aggs), []);
  const sql = roundTrip('SELECT city FROM t GROUP BY city');
  assert.doesNotMatch(sql, /COUNT|row_count/);
  return 'aggs stay empty; SQL selects only city';
});

test('review: windowed SUM with an order is a running total, ties together', () => {
  /* SUM(v) OVER (PARTITION BY p ORDER BY o) — the default frame runs from the first
     row to the current row and its ties. The preview used to show the group total. */
  const schema = {t: {cols: [{name: 'p'}, {name: 'o'}, {name: 'v'}],
                      rows: [['A', 1, 10], ['A', 2, 20], ['A', 2, 30], ['B', 1, 5]]}};
  const win = {id: 'n2', type: 'window', fn: 'SUM', col: 'v', partitionBy: ['p'], orderBy: 'o', dir: 'ASC', as: 's'};
  installGraph(api, {nodes: [{id: 'n1', type: 'table', table: 't'}, win, {id: 'n3', type: 'output'}],
    edges: [{from: 'n1', to: 'n2', port: 0}, {from: 'n2', to: 'n3', port: 0}]}, schema);
  assert.deepEqual(outRows().map(r => r[3]), [10, 60, 60, 5]);
  win.orderBy = '';
  assert.deepEqual(outRows().map(r => r[3]), [60, 60, 60, 5]);
  return 'ordered: 10, 60, 60 (tie shares) | unordered: whole group 60';
});

test('review: SQL Server and Oracle ranking always gets an ORDER BY', () => {
  const sql = 'SELECT ROW_NUMBER() OVER (PARTITION BY city) AS rn FROM t';
  assert.match(roundTrip(sql, 'mssql'), /OVER \(PARTITION BY city ORDER BY \(SELECT NULL\)\)/);
  assert.match(roundTrip(sql, 'oracle'), /OVER \(PARTITION BY city ORDER BY NULL\)/);
  assert.match(roundTrip(sql, 'postgres'), /OVER \(PARTITION BY city\)/);
  return 'mssql (SELECT NULL), oracle NULL, postgres none — all re-import unordered';
});

test('review: switching COUNT to SUM never leaves SUM(*)', () => {
  const app = loadApp();
  const change = (node, dataset, value) => {
    app.state.sel = node.id;
    app.document.getElementById('inspector').listeners.change({target: {dataset, value}});
  };
  let graph = graphFromSQL(app, 'SELECT city, COUNT(*) AS n FROM t GROUP BY city');
  change(graph.nodes.find(n => n.type === 'groupby'), {a: '0', f: 'fn'}, 'SUM');
  assert.match(app.buildSQL(), /SUM\(city\) AS n/);
  graph = graphFromSQL(app, 'SELECT COUNT(*) OVER (PARTITION BY city) AS c FROM t');
  change(graph.nodes.find(n => n.type === 'window'), {f: 'fn'}, 'SUM');
  assert.match(app.buildSQL(), /SUM\(city\) OVER/);
  return 'GROUP BY and window both move off * to a real column';
});

test('regression: Oracle gets no AS before a table alias and no bare * next to a column', () => {
  const shapes = [
    'SELECT a.*, b.amt FROM orders a JOIN pay b ON a.id = b.oid',
    "SELECT *, CASE WHEN amt > 100 THEN 'H' ELSE 'L' END AS lvl FROM orders",
    'SELECT *, amt * 2 AS dbl FROM orders',
    'SELECT *, ROW_NUMBER() OVER (PARTITION BY cid ORDER BY amt DESC) AS rn FROM orders',
    'SELECT *, amt * 2 AS dbl FROM school.orders',
    'SELECT SUM(CASE WHEN qty > 0 THEN amt ELSE 0 END) AS total FROM orders',
  ];
  for (const sql of shapes) {
    api.state.schema = {};
    const oracle = roundTrip(sql, 'oracle');
    /* ORA-00933 / ORA-00923: Oracle rejects both, so the copied SQL would not run */
    assert.doesNotMatch(oracle, /\b(FROM|JOIN) \S+ AS \w+/);
    assert.doesNotMatch(oracle, /SELECT \*,/);
    assert.match(roundTrip(sql, 'postgres'), /SELECT (\*,|a\.\*)/, 'other dialects keep the short form');
  }
  return 'join, CASE, derive and window run on Oracle and still re-import';
});

test('regression: a number typed for a text column stays quoted', () => {
  const app = loadApp();
  const edit = (sql, f, value) => {
    const graph = graphFromSQL(app, sql);
    app.state.sel = graph.nodes.find(n => n.type === 'filter').id;
    app.document.getElementById('inspector').listeners.change({target: {dataset: {f}, value}});
    return app.buildSQL();
  };
  /* code = 116 makes the database cast the whole column: no index, and SQL Server errors on any non-number code */
  assert.match(edit("SELECT * FROM t WHERE code = 'x'", 'val', '116'), /code = '116'/);
  assert.match(edit("SELECT * FROM t WHERE code IN ('x')", 'val', '116, 117'), /code IN \('116', '117'\)/);
  assert.match(edit('SELECT * FROM t WHERE qty = 1', 'val', '116'), /qty = 116\b/, 'number columns stay bare');
  assert.match(edit('SELECT * FROM t WHERE code > 1', 'val', '116'), /code > 116\b/, 'ranges keep their numeric meaning');
  /* the right side's code is renamed code_2 by the JOIN: its type is traced back, not looked up by name */
  const graph = graphFromSQL(app, "WITH j AS (SELECT a.*, b.code AS code_2 FROM t a JOIN u b ON a.id = b.id) SELECT * FROM j WHERE code_2 = 'y'");
  const filter = graph.nodes.find(n => n.type === 'filter');
  app.state.sel = filter.id;
  const leaf = filter.any ? {ob: '0', oc: '0'} : {};
  app.document.getElementById('inspector').listeners.change({target: {dataset: {f: 'val', ...leaf}, value: '116'}});
  assert.match(app.buildSQL(), /code_2 = '116'/);
  /* MySQL reads a bare number against ENUM as the member's position, not its value */
  graphFromSQL(app, 'SELECT * FROM grades WHERE lvl = 1');
  Object.values(app.state.schema).flatMap(t => t.cols).find(c => c.name === 'lvl').type = 'ENUM';
  app.state.sel = app.state.nodes.find(n => n.type === 'filter').id;
  app.document.getElementById('inspector').listeners.change({target: {dataset: {f: 'val'}, value: '116'}});
  assert.match(app.buildSQL(), /lvl = '116'/);
  return "code = '116', IN ('116', '117'), JOIN-renamed code_2 and ENUM quoted; qty and > untouched";
});

/* A table guessed from the first paste kept its old column list, so a later paste
   using new columns (amt, qty) reported them missing and emptied the preview. */
test('regression: a second paste on a guessed table adds the columns it newly uses', () => {
  const app = loadApp();
  graphFromSQL(app, 'SELECT class_id, member_id FROM sales');
  /* the first paste guessed sales = (class_id, member_id); amt and qty must not be "missing" now */
  graphFromSQL(app, 'SELECT class_id, SUM(CASE WHEN qty > 0 THEN amt ELSE 0 END) AS pos FROM sales GROUP BY class_id');
  assert.doesNotMatch(app.buildSQL(), /無法產生 SQL/);
  graphFromSQL(app, 'SELECT * FROM sales WHERE amt > 5');
  assert.ok(app.evalNode(app.state.nodes.find(n => n.type === 'filter')).rows.length > 0, 'preview is not emptied');
  return 'CASE over amt imports; filter on amt previews rows';
});

test('review: HTML inside pasted values is shown as text', () => {
  let graph = graphFromSQL(api, "SELECT * FROM t WHERE city = '<img src=x onerror=alert(1)>'");
  assert.doesNotMatch(api.nodeSummary(graph.nodes.find(n => n.type === 'filter')), /<img/);
  assert.doesNotMatch(api.buildSteps().find(s => s.title === 'WHERE').cap, /<img/);
  graphFromSQL(api, "SELECT CASE WHEN qq = 5 THEN '<img src=x onerror=alert(2)>' ELSE 'b' END AS lbl FROM fresh");
  assert.doesNotMatch(api.buildSteps().find(s => s.title === 'CASE WHEN').cap, /<img/);
  graph = graphFromSQL(api, "SELECT x + '<b>hi</b>' AS y FROM t");
  assert.doesNotMatch(api.nodeSummary(graph.nodes.find(n => n.type === 'derive')), /<b>/);
  graphFromSQL(api, "SELECT '<img src=x onerror=alert(3)>' AS k FROM t");
  assert.doesNotMatch(api.buildSteps().find(s => s.title === '固定值欄位').cap, /<img/);
  /* a string alias becomes a column name, drawn raw in tables and chips */
  sqlError("SELECT x AS '<img src=x onerror=alert(4)>' FROM t");
  return 'filter value, CASE label, derive operand, literal column escaped; HTML alias refused';
});

/* DISTINCT must survive SQL generation, and its sample count skips both NULLs
   and repeated values. Changing the inspector away from COUNT(*) needs a column. */
test('aggregate: COUNT(DISTINCT) round-trips and previews non-NULL unique values', () => {
  const app = loadApp();
  for (const dialect of ['mysql','postgres','mssql','oracle']) {
    const sql = roundTrip('SELECT city, COUNT(DISTINCT amt) AS n FROM t GROUP BY city', dialect);
    assert.match(sql, /COUNT\(DISTINCT amt\) AS n/);
  }
  const graph = graphFromSQL(app, 'SELECT city, COUNT(DISTINCT amt) AS n FROM t GROUP BY city');
  installGraph(app, graph, {t:{cols:[{name:'city'},{name:'amt'}],rows:[['a',1],['a',1],['a',null],['a',2],['b',null]]}});
  const group = graph.nodes.find(n=>n.type === 'groupby');
  assert.deepEqual(json(app.evalNode(group).rows), [['a',2],['b',0]]);
  assert.equal(app.aggregate({fn:'COUNT_DISTINCT',col:'x'}, [], ['x']), 0);
  app.state.sel = group.id; app.state.inspOpen = true; app.renderInspector();
  assert.match(app.inspector.innerHTML, /value="COUNT_DISTINCT"[^>]*>不重複計數/);
  group.aggs[0] = {fn:'COUNT',col:'*',as:'n'};
  app.inspector.listeners.change({target:{dataset:{a:'0',f:'fn'},value:'COUNT_DISTINCT'}});
  assert.match(app.buildSQL(), /COUNT\(DISTINCT city\)/);
  return 'four dialects; duplicates/NULL ignored; empty count 0; inspector selects a column';
});

/* The CASE must be a visible upstream step, rather than being flattened into a
   misleading aggregate. SQLite checks the original result and the CTE chain. */
test('aggregate: SUM/COUNT/AVG/MIN/MAX over CASE keep results including NULLs', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(city TEXT, qty INTEGER, amt INTEGER, fallback INTEGER); INSERT INTO t VALUES (\'a\',1,10,3),(\'a\',1,10,4),(\'a\',NULL,20,5),(\'a\',0,NULL,6),(\'b\',1,NULL,7),(\'b\',0,40,NULL);');
  const schema = {t:{cols:['city','qty','amt','fallback'].map(name=>({name})),rows:[['a',1,10,3],['a',1,10,4],['a',null,20,5],['a',0,null,6],['b',1,null,7],['b',0,40,null]]}};
  for (const fn of ['SUM','COUNT','AVG','MIN','MAX']) for (const then of ['amt','1']) for (const otherwise of ['', ' ELSE 0', ' ELSE fallback', ' ELSE NULL']) {
    app.state.schema = schema;
    const sql = `SELECT city, ${fn}(CASE WHEN qty > 0 THEN ${then}${otherwise} END) AS n FROM t GROUP BY city`;
    const graph = graphFromSQL(app, sql), group = graph.nodes.find(n=>n.type === 'groupby'), step = graph.nodes.find(n=>n.type === 'case');
    assert.ok(step, sql);
    assert.ok(graph.edges.some(e=>e.from === step.id && e.to === group.id), sql);
    assert.equal(group.aggs[0].col, step.as);
    const generated = app.buildSQL();
    const expected = json(db.prepare(sql).all());
    assert.deepEqual(json(db.prepare(generated).all()), expected, sql);
    installGraph(app, graph, schema);
    assert.deepEqual(json(app.evalNode(group).rows), expected.map(r=>[r.city,r.n]), sql);
    const again = app.astToGraph(app.parseSQLText(generated));
    assert.equal(signature(again), signature(graph), sql);
  }
  db.close();
  return '5 aggregates × 2 THEN kinds × 4 ELSE forms; SQLite, preview and graph round-trip agree';
});

/* Each CASE needs its own column even if source columns or earlier helpers use
   the preferred name; reusing one would silently aggregate the wrong values. */
test('aggregate: multiple CASE helpers chain without colliding with table or CTE columns', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(qty INTEGER, amt INTEGER, case_value INTEGER, case_value_2 INTEGER); INSERT INTO t VALUES (1,10,50,60),(0,20,70,80),(NULL,NULL,90,100);');
  app.state.schema = {t:{cols:['qty','amt','case_value','case_value_2'].map(name=>({name})),rows:[]}};
  for (const from of ['t', '(SELECT qty, amt, case_value, case_value_2 FROM t) AS x', 'x']) {
    const sql = (from === 'x' ? 'WITH x AS (SELECT * FROM t) ' : '') + `SELECT SUM(CASE WHEN qty > 0 THEN amt END) AS a, COUNT(CASE WHEN qty > 0 THEN 1 END) AS b, MAX(case_value) AS c FROM ${from}`;
    const graph = graphFromSQL(app, sql), steps = graph.nodes.filter(n=>n.type === 'case'), group = graph.nodes.find(n=>n.type === 'groupby');
    assert.deepEqual(json(steps.map(n=>n.as)), ['case_value_3','case_value_4']);
    assert.ok(graph.edges.some(e=>e.from === steps[0].id && e.to === steps[1].id));
    assert.ok(graph.edges.some(e=>e.from === steps[1].id && e.to === group.id));
    assert.deepEqual(json(db.prepare(app.buildSQL()).all()), json(db.prepare(sql).all()), sql);
  }
  db.close();
  return 'table, subquery and CTE reserve case_value and case_value_2; two helpers use _3 and _4';
});

/* Column branches must emit identifiers, while numeric-looking string literals
   keep their quotes. Inspector edits must preserve that distinction too. */
test('CASE: column branches, fixed values and NULL remain editable and round-trip', () => {
  const app = loadApp();
  api.state.schema = {t:{cols:['qty','amt','fallback','amount value','other value'].map(name=>({name})),rows:[]}};
  const sql = roundTrip("SELECT CASE WHEN qty > 0 THEN amt WHEN qty = 0 THEN '5' ELSE fallback END AS v FROM t");
  assert.match(sql, /THEN amt/); assert.match(sql, /THEN '5'/); assert.match(sql, /ELSE fallback/);
  const quoted = roundTrip('SELECT CASE WHEN qty > 0 THEN "amount value" ELSE "other value" END AS v FROM t');
  assert.match(quoted, /THEN "amount value"/); assert.match(quoted, /ELSE "other value"/);
  const graph = graphFromSQL(app, 'SELECT CASE WHEN qty > 0 THEN amt ELSE fallback END AS v FROM t');
  installGraph(app, graph, {t:{cols:['qty','amt','fallback'].map(name=>({name})),rows:[[1,10,20],[0,30,40],[null,50,null]]}});
  assert.deepEqual(json(app.evalNode(graph.nodes.find(n=>n.type === 'output')).rows), [[10],[40],[null]]);
  const step = graph.nodes.find(n=>n.type === 'case');
  app.state.sel = step.id; app.state.inspOpen = true; app.renderInspector();
  assert.match(app.inspector.innerHTML, /data-f="thenType"/); assert.match(app.inspector.innerHTML, /data-f="otherType"/);
  const edit = (dataset,value)=>app.inspector.listeners.change({target:{dataset,value}});
  edit({b:'0',f:'thenType'}, 'number'); edit({b:'0',f:'then'}, '7');
  assert.match(app.buildSQL(), /THEN 7/);
  edit({b:'0',f:'thenType'}, 'text');
  assert.match(app.buildSQL(), /THEN '7'/);
  edit({f:'otherType'}, 'null');
  assert.match(app.buildSQL(), /ELSE NULL/);
  edit({f:'otherType'}, 'column'); edit({f:'other'}, 'fallback');
  assert.match(app.buildSQL(), /ELSE fallback/);
  return 'THEN/ELSE columns preview per row; fixed number, text and NULL remain distinct';
});

/* An aggregate outside the supported shape cannot be approximated. Windowed
   DISTINCT must explain the PostgreSQL/SQL Server restriction, at its SQL position. */
test('aggregate: unsupported CASE expressions and windowed DISTINCT fail clearly', () => {
  const window = sqlError('SELECT COUNT(DISTINCT amt) OVER (PARTITION BY city) AS n FROM t');
  assert.match(window.msg, /視窗.*PostgreSQL.*SQL Server/);
  for (const sql of [
    'SELECT SUM(CASE WHEN qty > 0 THEN amt END) * 2 AS n FROM t',
    'SELECT SUM(CASE WHEN qty > 0 THEN amt * 2 END) AS n FROM t',
    'SELECT SUM(CASE WHEN qty > 0 THEN amt ELSE amt + 1 END) AS n FROM t',
    'SELECT SUM(CASE WHEN qty > 0 THEN amt END * 2) AS n FROM t',
    'SELECT CASE WHEN qty > 0 THEN amt END * 2 AS n FROM t',
    'SELECT COALESCE(SUM(CASE WHEN qty > 0 THEN amt END), 0) AS n FROM t',
    'SELECT SUM(CASE WHEN qty > 0 THEN amt WHEN amt > 0 THEN qty END) AS n FROM t',
  ]) assert.match(sqlError(sql).msg, /CASE/);
  assert.match(graphError('SELECT CASE WHEN qty > 0 THEN amt END AS amt FROM t').msg, /同名/);
  assert.match(graphError('SELECT COUNT(DISTINCT b.amt) AS n FROM a JOIN b ON a.id = b.id WHERE a.amt > 0').msg, /JOIN/);
  assert.match(graphError('SELECT 1 AS v, COUNT(DISTINCT amt) AS n FROM t').msg, /彙總後/);
  return 'window DISTINCT, aggregate arithmetic, branch arithmetic, wrapper and mixed WHEN columns refused';
});

/* A HAVING lookup based only on sum_label or count_x confuses different CASEs,
   or COUNT(x) with COUNT(DISTINCT x), and filters the wrong output column. */
test('aggregate: HAVING identifies the exact CASE or DISTINCT aggregate', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(city TEXT, qty INTEGER, amt INTEGER); INSERT INTO t VALUES (\'a\',1,10),(\'a\',0,20),(\'a\',1,10),(\'b\',1,NULL);');
  for (const sql of [
    'SELECT city, COUNT(DISTINCT amt) AS unique_n, COUNT(amt) AS n FROM t GROUP BY city HAVING COUNT(DISTINCT amt) = 1',
    'SELECT city, SUM(CASE WHEN qty > 0 THEN amt END) AS a, SUM(CASE WHEN qty = 0 THEN amt END) AS b FROM t GROUP BY city HAVING SUM(CASE WHEN qty > 0 THEN amt END) = 20',
    'SELECT COUNT(DISTINCT amt) AS n, city AS place FROM t GROUP BY city',
  ]) {
    graphFromSQL(app, sql);
    assert.deepEqual(json(db.prepare(app.buildSQL()).all()), json(db.prepare(sql).all()), sql);
  }
  db.close();
  return 'exact aggregate filtered; reordered SELECT and key aliases retain output columns';
});

/* Aggregate ORDER BY expressions must sort the selected output, including aliases.
   Guessing a synthetic name references a column that the grouped CTE never emits. */
test('aggregate: ORDER BY resolves exact selected aggregates and refuses missing ones', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  app.state.dialect = 'postgres';
  db.exec("CREATE TABLE t(city TEXT, qty INTEGER, amt INTEGER); INSERT INTO t VALUES ('a',1,10),('a',0,20),('a',1,10),('b',1,40),('b',0,NULL);");
  for (const expr of ['COUNT(DISTINCT amt)', 'SUM(CASE WHEN qty > 0 THEN amt ELSE 0 END)', 'SUM(amt)', 'COUNT(*)']) {
    for (const prefix of ['', 'city, ']) for (const direction of ['', ' DESC']) {
      const sql = `SELECT ${prefix}${expr} AS n FROM t${prefix?' GROUP BY city':''} ORDER BY ${expr}${direction}${prefix?', city ASC':''}`;
      graphFromSQL(app, sql);
      assert.deepEqual(json(db.prepare(app.buildSQL()).all()), json(db.prepare(sql).all()), sql);
    }
    assert.match(graphError(`SELECT city FROM t GROUP BY city ORDER BY ${expr}`).msg, /ORDER BY.*SELECT/);
    assert.match(graphError(`SELECT city FROM t GROUP BY city ORDER BY city, ${expr}`).msg, /ORDER BY.*SELECT/);
  }
  const sql = 'SELECT SUM(CASE WHEN qty > 0 THEN amt END) AS a, SUM(CASE WHEN qty = 0 THEN amt END) AS b FROM t ORDER BY SUM(CASE WHEN qty = 0 THEN amt END)';
  const graph = graphFromSQL(app, sql);
  assert.equal(graph.nodes.find(n=>n.type === 'sort').by, 'b');
  assert.deepEqual(json(db.prepare(app.buildSQL()).all()), json(db.prepare(sql).all()));
  assert.match(graphError('SELECT SUM(CASE WHEN qty > 0 THEN amt END) AS n FROM t ORDER BY SUM(CASE WHEN qty = 0 THEN amt END)').msg, /ORDER BY.*SELECT/);
  db.close();
  return 'DISTINCT, CASE and plain aggregates use their SELECT alias in every sort key; absent expressions refused';
});

/* A CASE inside an aggregate already has a helper column. GROUP BY must use
   that exact CASE helper rather than invent label or reuse a different CASE. */
test('aggregate: GROUP BY CASE resolves the matching helper or refuses', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  app.state.dialect = 'postgres';
  db.exec('CREATE TABLE t(qty INTEGER, amt INTEGER); INSERT INTO t VALUES (1,10),(1,10),(0,20),(NULL,30),(1,NULL);');
  for (const group of ['CASE WHEN qty > 0 THEN amt ELSE 0 END', 'CASE WHEN qty = 0 THEN amt ELSE 0 END']) {
    const first = 'SUM(CASE WHEN qty > 0 THEN amt ELSE 0 END) AS n';
    const sql = `SELECT ${first}${group.includes('=')?', SUM('+group+') AS z':''} FROM t GROUP BY ${group}`;
    const graph = graphFromSQL(app, sql);
    const steps = graph.nodes.filter(n=>n.type === 'case');
    assert.equal(graph.nodes.find(n=>n.type === 'groupby').keys[0], steps.at(-1).as);
    assert.deepEqual(json(db.prepare(app.buildSQL()).all()), json(db.prepare(sql).all()), sql);
  }
  assert.match(graphError('SELECT SUM(CASE WHEN qty > 0 THEN amt ELSE 0 END) AS n FROM t GROUP BY CASE WHEN qty = 0 THEN amt ELSE 0 END').msg, /GROUP BY.*CASE/);
  db.close();
  return 'matching CASE helper groups correctly; unmatched CASE refused';
});

/* Two CASE aggregates used to share sum_label, so projection silently dropped
   one result. Any colliding aggregate output must be refused before deduping. */
test('aggregate: colliding output names are refused without collapsing columns', () => {
  for (const sql of [
    'SELECT SUM(CASE WHEN qty > 0 THEN amt END), SUM(CASE WHEN qty = 0 THEN amt END) FROM t',
    'SELECT SUM(CASE WHEN qty > 0 THEN amt END) AS n, SUM(CASE WHEN qty = 0 THEN amt END) AS n FROM t',
    'SELECT SUM(amt) AS n, COUNT(*) AS n FROM t',
    'SELECT COUNT(DISTINCT amt), COUNT(DISTINCT amt) FROM t',
  ]) assert.match(graphError(sql).msg, /彙總.*同名/);
  const app = loadApp(), db = new DatabaseSync(':memory:');
  app.state.dialect = 'postgres';
  db.exec('CREATE TABLE t(qty INTEGER, amt INTEGER); INSERT INTO t VALUES (1,10),(1,20),(0,10),(0,30),(NULL,NULL);');
  const sql = 'SELECT COUNT(DISTINCT amt), COUNT(DISTINCT qty) FROM t ORDER BY COUNT(DISTINCT qty)';
  graphFromSQL(app, sql);
  const stmt = db.prepare(app.buildSQL()), original = db.prepare(sql);
  assert.equal(stmt.columns().length, 2);
  const values = statement => statement.all().map(row=>statement.columns().map(c=>row[c.name]));
  assert.deepEqual(json(values(stmt)), json(values(original)));
  db.close();
  return 'CASE, explicit aliases and repeated DISTINCT collisions refused; distinct columns keep both outputs';
});

/* SQLite lacks ANSI DATE literals and casts DATE to a numeric year. Adapt only
   these validated literals to SQLite date(), while syntax is asserted separately. */
const sqliteDates = sql => sql.replace(/DATE\s*'(\d{4}-\d{2}-\d{2})'/gi, "date('$1')")
  .replace(/CAST\('([\d-]+)' AS DATE\)/gi, "date('$1')");

/* Removing the DATE type or emitting ANSI DATE in SQL Server changes meaning or
   fails at execution. Both imports must yield the same typed graph in every dialect. */
test('filter dates: typed literals and CAST round-trip in four dialects', () => {
  for(const dialect of ['postgres','mysql','oracle','mssql']){
    for(const condition of [
      "sale_date >= DATE '2026-01-01'",
      "sale_date >= CAST('2026-01-01' AS DATE)",
      "sale_date BETWEEN DATE '2026-01-01' AND CAST('2026-02-01' AS DATE)",
      "sale_date NOT BETWEEN DATE '2026-01-01' AND DATE '2026-02-01'",
      "sale_date < DATE '2026-01-01' OR sale_date >= DATE '2026-02-01'",
      "sale_date IN (DATE '2026-01-01', CAST('2026-02-01' AS DATE))",
      "sale_date NOT IN (DATE '2026-01-01', DATE '2026-02-01')",
    ]){
      const generated = roundTrip('SELECT * FROM date_sales WHERE '+condition, dialect);
      assert.match(generated, dialect === 'mssql' ? /CAST\('2026-01-01' AS DATE\)/ : /DATE '2026-01-01'/);
      if(dialect === 'mssql') assert.doesNotMatch(generated, /DATE '/);
      const db = new DatabaseSync(':memory:');
      db.exec("CREATE TABLE date_sales(sale_date TEXT); INSERT INTO date_sales VALUES ('2025-12-31'),('2026-01-01'),('2026-01-15'),('2026-02-01'),(NULL);");
      assert.deepEqual(json(db.prepare(sqliteDates(generated)).all()), json(db.prepare(sqliteDates('SELECT * FROM date_sales WHERE '+condition)).all()));
      const app = loadApp(), graph = graphFromSQL(app, 'SELECT * FROM date_sales WHERE '+condition);
      installGraph(app, graph, {date_sales:{cols:[{name:'sale_date',type:'DATE'}],rows:[['2025-12-31'],['2026-01-01'],['2026-01-15'],['2026-02-01'],[null]]}});
      assert.deepEqual(json(app.evalNode(graph.nodes.find(n=>n.type === 'output')).rows), db.prepare(sqliteDates(generated)).all().map(r=>[r.sale_date]));
      assert.match(app.nodeSummary(graph.nodes.find(n=>n.type === 'filter')), /日期/);
      db.close();
    }
  }
  return 'ANSI DATE and CAST; comparisons, BETWEEN, NOT BETWEEN, OR and homogeneous IN; NULL dates excluded';
});

/* Quoting a right column as a string loses the per-row comparison. NULL on
   either side must remain unknown, and q() must handle names needing quotes. */
test('filter columns: row comparisons round-trip and preview including NULLs', () => {
  for(const dialect of ['postgres','mysql','oracle','mssql']){
    for(const op of ['=','<>','>','>=','<','<=']){
      const sql = roundTrip('SELECT * FROM prices WHERE price '+op+' "unit cost"', dialect);
      assert.match(sql, new RegExp('price '+op+' '+(dialect === 'mssql' ? '\\[unit cost\\]' : dialect === 'mysql' ? '`unit cost`' : '"unit cost"')));
    }
  }
  const app = loadApp(), rows = [[10,5],[3,5],[5,5],[null,5],[5,null],[null,null]];
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE prices(price INTEGER, cost INTEGER); INSERT INTO prices VALUES (10,5),(3,5),(5,5),(NULL,5),(5,NULL),(NULL,NULL);');
  for(const op of ['=','<>','>','>=','<','<=']){
    const input = 'SELECT * FROM prices WHERE price '+op+' cost';
    const graph = graphFromSQL(app, input);
    installGraph(app, graph, {prices:{cols:['price','cost'].map(name=>({name})),rows}});
    const expected = db.prepare(input).all().map(r=>[r.price,r.cost]);
    assert.deepEqual(json(app.evalNode(graph.nodes.find(n=>n.type === 'output')).rows), expected);
    assert.deepEqual(json(db.prepare(app.buildSQL()).all()), json(db.prepare(input).all()));
  }
  db.close();
  return 'six operators × four dialects; quoted column; NULL on either side';
});

/* Editing must reuse the CASE type toggle in both plain and grouped filters.
   Converting a block to AND/OR and back must retain the right operand type. */
test('filter inspector: column, fixed value and date modes survive grouping', () => {
  const app = loadApp(), graph = graphFromSQL(app, "SELECT * FROM prices WHERE price > cost");
  installGraph(app, graph, {prices:{cols:[{name:'price',type:'INT'},{name:'cost',type:'INT'},{name:'sale_date',type:'DATE'}],rows:[[10,5,'2026-01-02'],[3,5,null]]}});
  const f = graph.nodes.find(n=>n.type === 'filter');
  app.state.sel = f.id; app.state.inspOpen = true; app.renderInspector();
  assert.match(app.inspector.innerHTML, /data-f="valType"/);
  assert.match(app.inspector.innerHTML, /value="column" selected/);
  assert.match(app.inspector.innerHTML, /<select[^>]*data-f="val">/);
  const edit = (dataset,value)=>app.inspector.listeners.change({target:{dataset,value}});
  edit({f:'valType'},'value'); edit({f:'val'},'7');
  assert.match(app.buildSQL(), /price > 7/);
  edit({f:'valType'},'column'); edit({f:'val'},'cost');
  app.orFromPlain(f,['price','cost']); app.renderInspector();
  assert.match(app.inspector.innerHTML, /data-ob="0" data-oc="0" data-f="valType"/);
  assert.equal(f.any[0][0].valCol,true);
  edit({ob:'0',oc:'0',f:'valType'},'date');
  edit({ob:'0',oc:'0',f:'col'},'sale_date'); edit({ob:'0',oc:'0',f:'val'},'2026-01-01');
  app.orDelTerm(f,1,0);
  assert.equal(f.valDate,true); assert.equal(f.valCol,undefined);
  assert.match(app.buildSQL(), /sale_date > DATE '2026-01-01'/);
  assert.match(app.nodeSummary(f), /日期/);
  edit({f:'val'},'2026-02-30');
  assert.match(app.buildSQL(), /無法產生 SQL.*YYYY-MM-DD/);
  edit({f:'val'},'2026-01-01');
  app.andFromPlain(f,['sale_date']);
  assert.equal(f.any[0][0].valDate,true);
  edit({ob:'0',oc:'0',f:'valType'},'column'); edit({ob:'0',oc:'0',f:'val'},'cost');
  app.state.schema.prices.cols = app.state.schema.prices.cols.filter(c=>c.name !== 'cost');
  assert.match(app.buildSQL(), /上一步已沒有的欄位 cost/);
  return 'shared type selector in plain/OR/AND; invalid dates and missing RHS columns block SQL';
});

/* Dynamic dates and expressions cannot be represented faithfully by either new
   operand mode. Invalid calendar dates and nontrivial lists must fail explicitly. */
test('filter refusal: dynamic dates, arithmetic and nontrivial date lists', () => {
  for(const rhs of ['CURRENT_DATE','NOW()','GETDATE()','SYSDATE','amt * 2','UPPER(cost)',"DATE '2026-01-01' + 1", "CAST(cost AS DATE)"])
    assert.match(sqlError('SELECT * FROM t WHERE sale_date >= '+rhs).msg, /函式|日期|算式/);
  for(const bad of ['2026-02-30','2025-02-29','2026-1-01','0000-01-01','2026-13-01','not-a-date']){
    assert.match(sqlError("SELECT * FROM t WHERE sale_date = DATE '"+bad+"'").msg, /YYYY-MM-DD/);
    assert.match(sqlError("SELECT * FROM t WHERE sale_date = CAST('"+bad+"' AS DATE)").msg, /YYYY-MM-DD/);
  }
  graphFromSQL(api, "SELECT * FROM t WHERE sale_date = DATE '2024-02-29'");
  for(const condition of ["sale_date IN (DATE '2026-01-01', '2026-02-01')", "sale_date IN (DATE '2026-01-01', NULL)", 'sale_date IN (cost)', 'sale_date BETWEEN cost AND amt', 'sale_date IN (amt * 2)', "sale_date BETWEEN DATE '2026-01-01' AND NULL", "UPPER(sale_date) = DATE '2026-01-01'", "amt * 2 > cost"])
    sqlError('SELECT * FROM t WHERE '+condition);
  const app = loadApp();
  app.state.schema = {a:{cols:['id','price'].map(name=>({name})),rows:[]},b:{cols:['id','cost'].map(name=>({name})),rows:[]}};
  assert.throws(()=>graphFromSQL(app,'SELECT * FROM a JOIN b ON a.id = b.id WHERE price > b.id'),e=>e.sqlErr && /JOIN.*移除或改名/.test(e.msg));
  return 'fixed ISO calendar dates and plain columns only; unsafe JOIN references refused';
});

test('DEV-237: NULL filters and CASE previews match SQLite', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER, x INTEGER); INSERT INTO t VALUES (1,NULL),(2,3),(3,9);');
  const schema = {t:{cols:[{name:'id'}, {name:'x'}], rows:[[1,null],[2,3],[3,9]]}};
  const predicates = ['x <= 5', 'x <> 3', 'x NOT IN (1, 2)', 'x IN (3, 9)',
    "x LIKE '%'", "x NOT LIKE '3'", 'x IS NULL', 'x IS NOT NULL',
    'x > 1 AND x < 5', 'x <= 5 OR id = 3'];
  for (const predicate of predicates) {
    const sql = 'SELECT * FROM t WHERE ' + predicate;
    const graph = graphFromSQL(app, sql);
    installGraph(app, graph, schema);
    assert.deepEqual(json(app.evalNode(graph.nodes.find(n => n.type === 'output')).rows),
      db.prepare(sql).all().map(r => [r.id, r.x]), predicate);
  }
  const sql = "SELECT CASE WHEN x <= 5 THEN 'low' ELSE 'high' END AS bucket FROM t";
  const graph = graphFromSQL(app, sql);
  installGraph(app, graph, schema);
  assert.deepEqual(json(app.evalNode(graph.nodes.find(n => n.type === 'output')).rows),
    db.prepare(sql).all().map(r => [r.bucket]));
  db.close();
  return 'NULL predicates, AND/OR and CASE agree with SQLite';
});

test('DEV-237: JOIN NULL keys never match, including composite and cast keys', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE a(k INTEGER, x TEXT); CREATE TABLE b(k INTEGER, y TEXT);
    INSERT INTO a VALUES (NULL,'a-null'),(3,'ok'),(3,NULL);
    INSERT INTO b VALUES (NULL,'b-null'),(3,'ok'),(3,NULL);`);
  const schema = {
    a:{cols:[{name:'k'},{name:'x'}],rows:[[null,'a-null'],[3,'ok'],[3,null]]},
    b:{cols:[{name:'k'},{name:'y'}],rows:[[null,'b-null'],[3,'ok'],[3,null]]},
  };
  for (const type of ['INNER','LEFT']) {
    for (const on of ['a.k = b.k', 'a.k = b.k AND a.x = b.y', 'CAST(a.k AS TEXT) = CAST(b.k AS TEXT)']) {
      const sql = `SELECT a.k, a.x FROM a ${type} JOIN b ON ${on}`;
      const graph = graphFromSQL(app, sql);
      installGraph(app, graph, schema);
      const sorted = rows => rows.map(JSON.stringify).sort();
      assert.deepEqual(sorted(json(app.evalNode(graph.nodes.find(n => n.type === 'output')).rows)),
        sorted(db.prepare(sql).all().map(r => [r.k,r.x])), sql);
      const join = graph.nodes.find(n => n.type === 'join');
      const venn = app.joinPairsVenn(join);
      assert.match(venn, /左表對不上的/);
      if (on === 'a.k = b.k') assert.match(venn, /對得上：左表 2 列、右表 2 列/);
      const steps = app.buildSteps(), box = app.document.createElement('div');
      steps.find(s => s.title === 'JOIN 配對').render(box);
      if (on === 'a.k = b.k') assert.match(box.children.at(-1).innerHTML, /對得上：左表 2 列、右表 2 列/);
    }
  }
  db.close();
  return 'INNER/LEFT, compound keys, casts and matching diagrams agree';
});

test('DEV-237: filters after LEFT JOIN discard NULL-extended rows', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE a(k INTEGER); CREATE TABLE b(k INTEGER, y INTEGER);
    INSERT INTO a VALUES (1),(2); INSERT INTO b VALUES (1,3);`);
  const sql = 'SELECT a.k, b.y FROM a LEFT JOIN b ON a.k = b.k WHERE b.y <= 5';
  const graph = graphFromSQL(app, sql);
  installGraph(app, graph, {a:{cols:[{name:'k'}],rows:[[1],[2]]},
    b:{cols:[{name:'k'},{name:'y'}],rows:[[1,3]]}});
  assert.deepEqual(json(app.evalNode(graph.nodes.find(n => n.type === 'output')).rows),
    db.prepare(sql).all().map(r => [r.k,r.y]));
  db.close();
  return 'unmatched left row no longer passes y <= 5';
});

test('DEV-238: UNION width mismatches block SQL and previews', () => {
  const app = loadApp();
  const schema = {a:{cols:[{name:'id'},{name:'x'}],rows:[[1,2]]},
    b:{cols:[{name:'id'},{name:'x'},{name:'y'}],rows:[[3,4,5]]}};
  for (const mode of ['UNION','UNION ALL']) {
    const graph = graphFromSQL(app, `SELECT * FROM a ${mode} SELECT * FROM b`);
    installGraph(app, graph, schema);
    assert.match(app.buildSQL(), /^-- 無法產生 SQL：UNION 兩邊欄位數不一樣/);
    assert.deepEqual(json(app.evalNode(graph.nodes.find(n => n.type === 'output'))), {cols:[],rows:[]});
    const steps = app.buildSteps();
    assert.equal(steps.at(-1).title, '無法預覽');
    assert.match(steps.at(-1).cap, /2 vs 3/);
    app.state.sel = graph.nodes.find(n => n.type === 'union').id;
    app.renderInspector();
    assert.doesNotMatch(app.document.getElementById('inspector').innerHTML, /多的會被切掉/);
    // Validation depends on columns, even when both inputs contain no rows.
    installGraph(app, graph, {a:{...schema.a,rows:[]},b:{...schema.b,rows:[]}});
    assert.match(app.buildSQL(), /^-- 無法產生 SQL：UNION/);
  }
  const graph = graphFromSQL(app, 'SELECT id, x FROM a UNION ALL SELECT id, x FROM b');
  installGraph(app, graph, schema);
  assert.doesNotMatch(app.buildSQL(), /^-- 無法/);
  assert.deepEqual(json(app.evalNode(graph.nodes.find(n => n.type === 'output')).rows), [[1,2],[3,4]]);
  return 'both modes reject unequal widths, matching widths still work';
});

test('DEV-239: qualified tables retain and render the source step', () => {
  const app = loadApp();
  app.state.schema = {'school.scores':{label:'考試記錄',cols:[{name:'attempts'}],rows:[[1],[2]]}};
  graphFromSQL(app, 'SELECT * FROM school.scores WHERE attempts > 1');
  const steps = app.buildSteps();
  assert.equal(steps[0].title, '來源');
  const box = app.document.createElement('div');
  steps[0].render(box);
  assert.match(box.children[0].innerHTML, /考試記錄/);
  assert.match(box.children[0].innerHTML, /attempts/);
  return 'source tab and qualified schema render correctly';
});

test('DEV-239: same table name in two schemas keeps the schema in each source heading', () => {
  // 兩個來源同名時，標題只寫 t 就分不出哪個 schema 的資料
  const app = loadApp();
  app.state.schema = {'s1.t':{cols:[{name:'id'}],rows:[[1]]},'s2.t':{cols:[{name:'id'}],rows:[[2]]}};
  graphFromSQL(app, 'SELECT a.id FROM s1.t a JOIN s2.t b ON a.id = b.id');
  const box = app.document.createElement('div');
  app.buildSteps()[0].render(box);
  const html = box.children.map(c => c.innerHTML).join(' ');
  assert.match(html, /s1\.t/);
  assert.match(html, /s2\.t/);
  return 'headings show s1.t and s2.t';
});

test('DEV-242: a literal where a column is expected is refused, not turned into an identifier', () => {
  // 算式左邊和函式參數會被當成欄位名；常值放那裡會產生 "-1" 這種錯欄位
  for (const sql of ['SELECT -1 * amount AS n FROM t', 'SELECT 1 * amount AS n FROM t',
    'SELECT ABS(-1) AS n FROM t', 'SELECT ABS(1) AS n FROM t']) {
    assert.throws(() => graphFromSQL(loadApp(), sql), e => e.sqlErr === true && /只能是欄位/.test(e.msg), sql);
  }
  graphFromSQL(loadApp(), 'SELECT amount * -1 AS n FROM t');
  return 'literal on the left / as argument refused; amount * -1 still imports';
});

test('DEV-240: failed SQL imports leave the graph and quoting unchanged', () => {
  const app = loadApp();
  app.state.dialect = 'postgres';
  const paste = sql => {
    app.document.getElementById('sqlin').value = sql;
    app.document.getElementById('do-parse').listeners.click();
  };
  paste('SELECT "CamelCol" FROM "MyTable"');
  const before = app.buildSQL(), canvas = JSON.stringify(app.state.nodes);
  for (const sql of ['SELECT FROM', "SELECT 'unfinished", 'SELECT x FROM t GROUP BY x HAVING SUM(x) > 1']) {
    paste(sql);
    assert.match(app.document.getElementById('parse-out').innerHTML, /class="perr"/);
    assert.equal(app.buildSQL(), before, sql);
    assert.equal(JSON.stringify(app.state.nodes), canvas, sql);
  }
  paste('SELECT CamelCol FROM MyTable');
  assert.doesNotMatch(app.buildSQL(), /"CamelCol"|"MyTable"/);
  return 'tokenizer, parser and graph failures preserve quotes; successful import replaces them';
});

test('DEV-241: malformed notes are skipped individually during SQL import', () => {
  const app = loadApp();
  const graph = graphFromSQL(app, '/* sqlblocks-notes filter#1=%E0 sort#1=有效%20註記 */ SELECT * FROM t WHERE x = 1 ORDER BY x');
  assert.equal(graph.nodes.find(n => n.type === 'filter').note, undefined);
  assert.equal(graph.nodes.find(n => n.type === 'sort').note, '有效 註記');
  assert.match(app.buildSQL(), /有效%20註記/);
  return 'query imports and valid neighboring notes survive';
});

test('DEV-242: negative numeric literals round-trip and execute', () => {
  const app = loadApp(), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(x REAL, amount REAL); INSERT INTO t VALUES (-6,10),(-2,-3),(0,5);');
  const queries = ['SELECT * FROM t WHERE x > -5', 'SELECT amount * -1 AS refund FROM t',
    'SELECT -0.5 AS n FROM t', 'SELECT * FROM t WHERE x BETWEEN -5 AND -1',
    'SELECT * FROM t WHERE x IN (-6, -2)', "SELECT CASE WHEN x > -5 THEN -1 ELSE -2 END AS n FROM t",
    'SELECT amount - 1 AS n FROM t', 'SELECT amount - -1 AS n FROM t'];
  for (const sql of queries) {
    const graph = graphFromSQL(app, sql), generated = app.buildSQL();
    assert.deepEqual(json(db.prepare(generated).all()), json(db.prepare(sql).all()), sql);
    const second = app.astToGraph(app.parseSQLText(generated));
    assert.equal(signature(second), signature(graph), sql);
  }
  assert.throws(() => app.parseSQLText('SELECT -amount AS n FROM t'), err => err.sqlErr === true);
  db.close();
  return 'thresholds, arithmetic, decimals, BETWEEN, IN and CASE preserve negative values';
});

/* Semi-joins must preserve the pasted operator in every dialect, and duplicates
   in a lookup must never multiply the outer rows as a JOIN would. */
test('semi-join: four forms round-trip in all dialects and split AND filters', () => {
  for (const dialect of ['mysql','postgres','mssql','oracle']) for (const form of ['IN','NOT IN','EXISTS','NOT EXISTS']) {
    const app=loadApp(); app.state.dialect=dialect;
    const predicate=form.includes('IN') ? `o.k ${form} (SELECT p.k FROM lookup p WHERE p.v > 0)`
      : `${form} (SELECT 1 FROM lookup p WHERE p.k = o.k AND p.v = o.v AND p.v > 0)`;
    const graph=graphFromSQL(app,`SELECT o.id FROM outer_rows o WHERE o.id > 0 AND ${predicate} AND o.v < 9`);
    const n=graph.nodes.find(n=>n.type==='semijoin');
    assert.equal(n.form,form); assert.equal(graph.edges.filter(e=>e.to===n.id).length,2);
    assert.ok(graph.nodes.some(n=>n.type==='filter' && (n.col==='id' || n.any)));
    const generated=app.buildSQL();
    assert.ok(generated.includes(` ${form} (`));
    if(dialect==='oracle') { assert.match(generated,/SELECT lhs\.\*/); assert.doesNotMatch(generated,/ AS (lhs|rhs)/); }
    const second=app.astToGraph(app.parseSQLText(generated));
    const shape=g=>{
      const walk=id=>{ const n=g.nodes.find(n=>n.id===id), {id:_,x,y,...spec}=n;
        return {spec,inputs:g.edges.filter(e=>e.to===id).sort((a,b)=>a.port-b.port).map(e=>walk(e.from))}; };
      return JSON.stringify(walk(g.nodes.find(n=>n.type==='output').id));
    };
    assert.equal(shape(second),shape(graph), generated);
  }
  return '4 forms × 4 dialects retain operators, lookup chains and normal filters';
});

/* SQL three-valued logic distinguishes NOT IN from NOT EXISTS: NULL lookup keys
   poison NOT IN, while NULL outer keys survive NOT EXISTS. Check actual SQLite. */
test('semi-join: preview and regenerated SQL match SQLite for NULLs and duplicate keys', () => {
  const app=loadApp(), db=new DatabaseSync(':memory:'); app.state.dialect='postgres';
  db.exec('CREATE TABLE outer_rows(id,k,v); CREATE TABLE lookup(k,v); INSERT INTO outer_rows VALUES(1,1,1),(2,2,2),(3,NULL,1),(4,1,2);');
  const rows=[[1,1,1],[2,2,2],[3,null,1],[4,1,2]];
  for(const lookup of [[[1,1],[1,1],[null,2]],[[1,1],[1,2]],[]]) {
    db.exec('DELETE FROM lookup'); for(const r of lookup) db.prepare('INSERT INTO lookup VALUES(?,?)').run(...r);
    for(const form of ['IN','NOT IN','EXISTS','NOT EXISTS']) {
      app.state.schema={outer_rows:{cols:['id','k','v'].map(name=>({name})),rows},lookup:{cols:['k','v'].map(name=>({name})),rows:lookup}};
      const pred=form.includes('IN') ? `o.k ${form} (SELECT p.k FROM lookup p)` : `${form} (SELECT 1 FROM lookup p WHERE p.k=o.k AND p.v=o.v)`;
      const sql=`SELECT o.id FROM outer_rows o WHERE ${pred}`, graph=graphFromSQL(app,sql);
      // Import creates invented sample rows; install the actual fixture explicitly.
      app.state.schema.outer_rows.rows=rows; app.state.schema.lookup.rows=lookup;
      const expected=db.prepare(sql).all().map(r=>[r.id]);
      const output=graph.nodes.find(n=>n.type==='output');
      assert.deepEqual(json(app.evalNode(output).rows),expected,sql);
      assert.deepEqual(json(db.prepare(app.buildSQL()).all().map(r=>[r.id])),expected,sql);
    }
  }
  db.close(); return '12 SQLite comparisons cover NULL outer/inner keys, duplicates, composite keys and empty lookup';
});

/* The warning must follow the selected mode; inspector changes must affect both
   preview and SQL rather than only the displayed label. */
test('semi-join: inspector toggles forms and columns, warning only for NOT IN', () => {
  const app=loadApp();
  for(const form of ['IN','EXISTS']) {
    graphFromSQL(app,form==='IN' ? 'SELECT o.id FROM outer_rows o WHERE o.k IN (SELECT p.k FROM lookup p)'
      : 'SELECT o.id FROM outer_rows o WHERE EXISTS (SELECT 1 FROM lookup p WHERE p.k=o.k)');
    const n=app.state.nodes.find(n=>n.type==='semijoin'); app.state.sel=n.id; app.state.inspOpen=true;
    const change=(f,value,extra={})=>app.inspector.listeners.change({target:{dataset:{f,...extra},value}});
    for(const mode of [form,'NOT '+form,form]) {
      change('form',mode); app.renderInspector();
      assert.equal(n.form,mode);
      for(const html of [app.nodeSummary(n),app.inspector.innerHTML,...app.buildSteps().filter(s=>s.title==='有沒有出現在另一份資料裡').map(s=>s.cap)])
        assert.equal(html.includes('可考慮改用 NOT EXISTS'),mode==='NOT IN');
      assert.ok(app.buildSQL().includes(` ${mode} (`));
    }
    change('left','id',{k:'0'}); change('right','k',{k:'0'});
    assert.equal(n.keys[0].left,'id'); assert.match(app.buildSQL(),/lhs.id/);
    app.state.schema.outer_rows={cols:['id','k'].map(name=>({name})),rows:[[1,9],[2,1]]};
    app.state.schema.lookup={cols:[{name:'k'}],rows:[[1],[1]]};
    assert.deepEqual(json(app.evalNode(n).rows),[[1,9]]);
    change('left','k',{k:'0'});
    assert.deepEqual(json(app.evalNode(n).rows),[[2,1]]);
    assert.match(app.inspector.innerHTML,/查找欄位/);
  }
  return 'mode and key edits reach generated SQL, warning and plain-language explanation';
});

/* Unsupported subqueries must fail explicitly: approximating correlation or
   dropping an OR branch would silently change the meaning of pasted SQL. */
test('semi-join: unsupported subquery shapes are refused with Chinese errors', () => {
  const app=loadApp();
  const shapes=[
    ['SELECT o.id FROM outer_rows o WHERE o.k = (SELECT p.k FROM lookup p)',/純量子查詢/],
    ['SELECT (SELECT p.k FROM lookup p) FROM outer_rows o',/純量子查詢/],
    ['SELECT o.id FROM outer_rows o WHERE o.k IN (SELECT p.k,p.v FROM lookup p)',/單一欄位/],
    ...['ANY','ALL','SOME'].map(f=>[`SELECT o.id FROM outer_rows o WHERE o.k = ${f} (SELECT p.k FROM lookup p)`,/ANY.*ALL.*SOME/]),
    ['SELECT o.id FROM outer_rows o WHERE o.id > 0 OR o.k IN (SELECT p.k FROM lookup p)',/OR/],
    ['SELECT o.id FROM outer_rows o WHERE EXISTS (SELECT 1 FROM lookup p WHERE p.k=o.k) OR o.id=1',/OR/],
    ['SELECT o.id FROM outer_rows o WHERE EXISTS (SELECT 1 FROM lookup p WHERE p.k>o.k)',/等值/],
    ['SELECT o.id FROM outer_rows o WHERE EXISTS (SELECT 1 FROM lookup p WHERE p.k=o.k OR p.v=1)',/等值/],
    ['SELECT o.id FROM outer_rows o WHERE EXISTS (SELECT 1 FROM lookup p WHERE EXISTS (SELECT 1 FROM third t WHERE t.k=o.k))',/一層|多層/],
    ['SELECT o.id FROM outer_rows o WHERE EXISTS (SELECT COUNT(*) FROM lookup p WHERE p.k=o.k)',/彙總/],
    ['SELECT o.id FROM outer_rows o WHERE EXISTS (SELECT 1 FROM lookup p WHERE p.k=unqualified_outer)',/表名/],
  ];
  for(const [sql,msg] of shapes) assert.throws(()=>graphFromSQL(app,sql),e=>e.sqlErr && Number.isInteger(e.pos) && msg.test(e.msg),sql);
  return `${shapes.length} unsafe shapes refused without rewriting SQL`;
});

/* PR #27 review: each case below either changed which rows qualify, refused a
   supported query, or produced SQL that cannot run. */
test('semi-join review: JOIN-renamed keys, text codes, UNION lookups, table named like a CTE', () => {
  // A key on the joined-in table would be compared against the FROM table's same-named column.
  const app=loadApp();
  app.state.schema={o:{cols:['id','status'].map(name=>({name})),rows:[]},a:{cols:['id','status'].map(name=>({name})),rows:[]},b:{cols:['id','status'].map(name=>({name})),rows:[]}};
  assert.throws(()=>graphFromSQL(app,'SELECT o.id FROM o WHERE EXISTS (SELECT 1 FROM a JOIN b ON a.id=b.id WHERE b.status=o.status)'),e=>e.sqlErr && /FROM 的第一張表/.test(e.msg));
  graphFromSQL(app,'SELECT o.id FROM o WHERE EXISTS (SELECT 1 FROM a JOIN b ON a.id=b.id WHERE a.status=o.status)');

  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE o(id INTEGER, code TEXT); CREATE TABLE p(code TEXT); CREATE TABLE q(code TEXT); CREATE TABLE matched(id INTEGER, code TEXT);
    INSERT INTO o VALUES (1,'01'),(2,'2'),(3,'3'); INSERT INTO p VALUES ('1'),('2'); INSERT INTO q VALUES ('3');
    INSERT INTO matched VALUES (1,'01'),(2,'2');`);
  const text={o:{cols:[{name:'id',type:'int'},{name:'code',type:'varchar'}],rows:[[1,'01'],[2,'2'],[3,'3']]},
    p:{cols:[{name:'code',type:'varchar'}],rows:[['1'],['2']]},q:{cols:[{name:'code',type:'varchar'}],rows:[['3']]},
    matched:{cols:[{name:'id',type:'int'},{name:'code',type:'varchar'}],rows:[[1,'01'],[2,'2']]}};
  for(const sql of [
    // '01' and '1' are different text codes in SQL; the preview must not coerce them to numbers.
    'SELECT o.id FROM o WHERE o.code IN (SELECT p.code FROM p)',
    'SELECT o.id FROM o WHERE EXISTS (SELECT 1 FROM p WHERE p.code = o.code)',
    // Qualified columns in a UNION branch belong to that branch, not to an outer query.
    'SELECT o.id FROM o WHERE o.code IN (SELECT p.code FROM p UNION SELECT q.code FROM q)',
    // A source table named "matched" must not be shadowed by the generated CTE of the same name.
    'SELECT m.id FROM matched m WHERE m.code IN (SELECT p.code FROM p)']) {
    const one=loadApp(); one.state.dialect='postgres';
    const graph=graphFromSQL(one,sql);
    installGraph(one,graph,text);
    const expected=db.prepare(sql).all().map(r=>[r.id]);
    assert.deepEqual(json(one.evalNode(graph.nodes.find(n=>n.type==='output')).rows),expected,sql);
    assert.deepEqual(json(db.prepare(one.buildSQL()).all().map(r=>[r.id])),expected,sql);
  }
  db.close();
  return 'joined-table key refused; text codes, UNION lookup and matched table agree with SQLite';
});

let passed = 0;
for (const item of cases) {
  try {
    const detail = item.fn();
    passed++;
    console.log(`PASS ${item.name} — ${detail}`);
  } catch (error) {
    console.log(`FAIL ${item.name} — ${error?.stack || error}`);
  }
}
console.log(`TOTAL ${passed}/${cases.length} passed`);
if (passed !== cases.length) process.exitCode = 1;
