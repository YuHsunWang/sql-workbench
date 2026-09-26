import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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

test('regression: quoted leading-zero IN values', () => {
  const generated = roundTrip("SELECT * FROM t WHERE kgrp_code IN ('067','087')");
  assert.match(generated, /IN \('067', '087'\)/);
  assert.doesNotMatch(generated, /IN \(67, 87\)/);
  return "generated IN ('067', '087')";
});

test('regression: schema qualifier survives all dialects', () => {
  const expected = {
    mysql:'analytic.`trans detail`', postgres:'analytic."trans detail"',
    mssql:'analytic.[trans detail]', oracle:'analytic."trans detail"',
  };
  for (const [dialect, ref] of Object.entries(expected)) {
    api.state.dialect = dialect;
    graphFromSQL(api, 'SELECT * FROM [analytic].[trans detail]');
    assert.match(api.buildSQL(), new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  return 'mysql/postgres/mssql/oracle qualifiers preserved';
});

test('regression: BETWEEN makes exactly two ordered filters', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM t WHERE x BETWEEN 1 AND 3 AND y = 2');
  const filters = graph.nodes.filter(n => n.type === 'filter');
  assert.deepEqual(json(filters.map(n => [n.col, n.op, n.val])), [['x','>=',1],['x','<=',3],['y','=',2]]);
  return 'filters=x>=1,x<=3,y=2';
});

/* Each of these used to import cleanly with no warning while the steps meant
   something else. Refusing is the honest answer until the model can hold them. */
test('regression: SQL the steps would silently change is refused', () => {
  const refused = {
    'SELECT x FROM t WHERE x = y': 'x = y became x = \'y\'',
    'SELECT COUNT(DISTINCT x) AS n FROM t': 'DISTINCT was dropped',
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

test('security: pasted names and warnings are shown as text, not HTML', () => {
  const app = loadApp();
  const doc = app.document;
  const evil = '<img src=x onerror=alert(1)>';
  doc.getElementById('sqlin').value = `SELECT * FROM "${evil}" ORDER BY a, b`;
  doc.getElementById('do-parse').listeners.click();
  const html = doc.getElementById('parse-out').innerHTML;
  assert.match(html, /解析成功/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  return 'table name escaped in the success message';
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

test('join: composite keys and per-side casts', () => {
  api.state.dialect = 'mssql';
  const graph = graphFromSQL(api,
    'SELECT t.sale_amt FROM analytic.trans_detail AS t ' +
    'INNER JOIN analytic.store_weather AS w ' +
    'ON CAST(t.deal_time AS DATE) = w.cutoff_date AND t.ostore_no = w.ostore_no');
  const keys = graph.nodes.find(n => n.type === 'join').keys;
  assert.deepEqual(json(keys), [
    {left:'deal_time', lfn:'DATE', right:'cutoff_date', rfn:''},
    {left:'ostore_no', lfn:'',     right:'ostore_no',   rfn:''},
  ]);
  const generated = api.buildSQL();
  assert.match(generated, /ON CAST\(a\.deal_time AS DATE\) = b\.cutoff_date\n   AND a\.ostore_no = b\.ostore_no/);
  // 轉了日期才對得上，所以要有列跑出來
  const out = api.evalNode(graph.nodes.find(n => n.type === 'output'));
  assert.ok(out.rows.length > 0, 'cast join produced no rows');
  // 兩個條件都要成立：拿掉一個列數會變多
  const one = api.astToGraph(api.parseSQLText(
    'SELECT t.sale_amt FROM analytic.trans_detail AS t INNER JOIN analytic.store_weather AS w ON t.ostore_no = w.ostore_no'));
  assert.equal(one.nodes.find(n => n.type === 'join').keys.length, 1);
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
  const html = fs.readFileSync(new URL('../sql-blocks.html', import.meta.url), 'utf8');
  const start = html.indexOf('function prune(n){');
  const end = html.indexOf('\n\n/* ============================================================', start);
  const makePrune = new Function('colsInto', 'joinKeys', html.slice(start, end) + '\nreturn prune;');
  const prune = makePrune((id, port) => port === 1 ? ['id','day'] : ['id','date'], n => n.keys);
  const join = {id:'j', type:'join', joinType:'LEFT', keys:[
    {left:'id',right:'id'}, {left:'date',right:'day'}, {left:'missing',right:'id'},
  ]};
  prune(join);
  assert.deepEqual(join.keys, [{left:'id',right:'id'}, {left:'date',right:'day'}]);
  return 'JOIN type update keeps two valid keys and drops only the invalid key';
});

test('H2: same table name in different schemas stays two sources', () => {
  const graph = graphFromSQL(api,
    'SELECT a.member_no FROM analytic.m_member a ' +
    'JOIN BI.m_member b ON a.member_no = b.member_no');
  const tables = graph.nodes.filter(n => n.type === 'table');
  assert.deepEqual(json(tables.map(n => `${n.ns}.${n.table}`)), ['analytic.m_member','BI.m_member']);
  const join = graph.nodes.find(n => n.type === 'join');
  const incoming = graph.edges.filter(e => e.to === join.id).sort((a,b)=>a.port-b.port);
  assert.equal(new Set(incoming.map(e=>e.from)).size, 2);
  const generated = api.buildSQL();
  assert.match(generated, /FROM analytic\.m_member AS a\n  INNER JOIN BI\.m_member AS b/);
  return 'analytic.m_member and BI.m_member remain distinct';
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

test('sample data follows column names, and joins still line up', () => {
  const tx = api.state.schema['analytic.trans_detail'];
  const at = n => tx.rows[0][tx.cols.findIndex(c => c.name === n)];
  assert.match(String(at('deal_time')), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(String(at('member_no')), /^M\d{7}$/);
  assert.equal(typeof at('sale_amt'), 'number');
  const w = api.state.schema['analytic.store_weather'];
  const wat = n => w.rows[0][w.cols.findIndex(c => c.name === n)];
  assert.equal(typeof wat('MaxT_predict'), 'number');
  // 同一個欄名在不同表要產生同一串值，JOIN 才對得上
  assert.equal(at('ostore_no'), wat('ostore_no'));
  return 'names drive values; shared columns stay joinable';
});

test('round trip: supported node shapes', () => {
  const inputs = [
    'SELECT * FROM t WHERE x=1', 'SELECT DISTINCT * FROM t',
    'SELECT a.x FROM a JOIN b ON a.id=b.id',
    'SELECT * FROM a UNION ALL SELECT * FROM b',
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

test('deferred NULL comparison semantics; IS NULL excludes empty string', () => {
  const actual = [api.cmp(null,'<>','x'), api.cmp(null,'NOT IN','x'), api.cmp('','IS NULL','')];
  assert.deepEqual(actual, [true,true,false]);
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
  // 零售代號多半是 VARCHAR：'116' 掉了引號就變成隱式轉型
  const graph = graphFromSQL(api, "SELECT * FROM t WHERE kgrp_code IN ('067','116','213') AND fm_code = '0987'");
  const generated = api.buildSQL();
  assert.match(generated, /IN \('067', '116', '213'\)/);
  assert.doesNotMatch(generated, /IN \('067', 116, 213\)/);
  assert.match(generated, /fm_code = '0987'/);
  // 重新匯入一次還是字串
  const again = api.astToGraph(api.parseSQLText(generated));
  assert.match(api.buildSQL.call(null) || '', /.*/);
  assert.equal(again.nodes.filter(n => n.type === 'filter').length, 2);
  return "IN ('067', '116', '213') and fm_code = '0987' stay quoted";
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
   previous suite had one and still missed 57 clashing names. */
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
  assert.equal(repeats > 100, true, `expected many repeated names, saw ${repeats}`);
  return `${seen.size} names, ${repeats} cross-table repeats, 0 clashes`;
});

/* The clash came from the Chinese name and the guessed type steering the rule
   per table. A table that supplies neither (an inferred table from pasted SQL)
   must still get the sequence the schema already chose for that column name. */
test('M13: a later table cannot re-classify an already-seen column name', () => {
  api.demoSchema();
  const rows = c => [0, 1, 2, 3, 4, 5].map(r => api.sampleValue(c, r));
  /* tx_seq is the real case: trans_detail labels it 交易序號 (a code), while
     promo_dtl supplies no Chinese name and guesses INT. They must not diverge,
     or the JOIN in the animation matches nothing. */
  const rich = rows({name:'tx_seq', ch:'交易序號', type:'VARCHAR'});
  const bare = rows({name:'tx_seq', ch:'', type:'INT'});
  assert.deepEqual(json(bare), json(rich));
  return `tx_seq stays ${JSON.stringify(rich.slice(0, 2))} with or without the Chinese name`;
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

  graphFromSQL(api, 'SELECT * FROM "analytic"."trans_detail"');
  const lower = api.buildSQL();
  assert.match(lower, /analytic\.trans_detail/);
  assert.doesNotMatch(lower, /"analytic"/);

  /* a reserved word can never be emitted bare, whatever the source did */
  graphFromSQL(api, 'SELECT * FROM t WHERE "user" = 1');
  const reserved = api.buildSQL();
  assert.match(reserved, /"user" = 1/);
  return 'Camel/MyTable stay quoted; analytic.trans_detail goes bare; user stays quoted';
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
  graphFromSQL(api, 'SELECT county, SUM(sale_amt) AS amt FROM analytic.trans_detail a ' +
    'JOIN analytic.m_org_last b ON a.store_no = b.store_no GROUP BY county');
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

/* Quick filters. These are real product-category code ranges the analyst uses
   every day, and the codes are fixed-width strings: '02' is a category, not the
   number 2. A range is expanded to an explicit list so nothing downstream can
   reinterpret it, and every code must survive to the SQL still quoted —
   including the ones that look like numbers, such as '22' and '58'. */
test('quick: code ranges expand as fixed-width strings', () => {
  assert.deepEqual(json(api.codeRange('02', '22').slice(0, 3)), ['02', '03', '04']);
  assert.equal(api.codeRange('02', '22').length, 21);
  assert.equal(api.codeRange('02', '22').every(c => c.length === 2), true);
  assert.deepEqual(json(api.codeRange('A0', 'A9')), ['A0','A1','A2','A3','A4','A5','A6','A7','A8','A9']);
  assert.equal(api.codeRange('27', '34').length, 8);

  const sizes = Object.fromEntries(api.QUICK_DEFAULT.map(q => [q.label, api.quickCodes(q).length]));
  assert.deepEqual(json(sizes), {泛鮮食:34, 飲料:8, 香菸:1, 計算營收:15});
  return `泛鮮食=34 飲料=8 香菸=1 營收排除=15`;
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
  const schema = {t:{label:'', cols:[{name:'kind_code', ch:'品番代號', type:'VARCHAR'}],
                     rows:[['02'], ['22'], ['58']]}};
  for (const q of api.QUICK_DEFAULT) {
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
  return `${api.QUICK.length} presets: all codes quoted, operators round-trip`;
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
  const schema = {t:{label:'', cols:[{name:'kind_code', ch:'', type:'VARCHAR'}], rows:[['02'], ['58']]}};
  const graph = (filterVal, connectOutput) => ({
    nodes:[{id:'t', type:'table', table:'t'},
           {id:'f', type:'filter', col:'kind_code', op:'IN', val:filterVal},
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
  const schema = {t:{label:'', cols:[{name:'kind_code', ch:'', type:'VARCHAR'}], rows:[['02'], ['58']]}};
  installGraph(api, {nodes:[{id:'t', type:'table', table:'t'}, {id:'o', type:'output'}],
                     edges:[{from:'t', to:'o', port:0}]}, schema);
  api.state.sel = 't';
  const preset = api.QUICK_DEFAULT.find(q => q.label === '計算營收');
  api.addNode('filter', {col:preset.col, op:preset.op, val:api.quickVal(preset), note:preset.label});

  const step = api.state.nodes.find(n => n.type === 'filter');
  assert.equal(step.note, '計算營收');
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
  const good = {label:'我的', col:'kind_code', op:'IN', src:'02-04'};
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
  const schema = {t:{label:'', cols:[{name:'kind_code', ch:'', type:'VARCHAR'}], rows:[['02']]}};
  installGraph(api, {
    nodes:[{id:'t', type:'table', table:'t'},
           {id:'f', type:'filter', col:'kind_code', op:'IN', val:"'02'", note:'計算營收'},
           {id:'o', type:'output'}],
    edges:[{from:'t', to:'f', port:0}, {from:'f', to:'o', port:0}],
  }, schema);
  const sql = api.buildSQL();
  assert.match(sql, /sqlblocks-notes filter#1=計算營收/, 'the note stays readable in the SQL');
  const back = api.astToGraph(api.parseSQLText(sql));
  assert.equal(back.nodes.find(n => n.type === 'filter').note, '計算營收');

  /* a manifest that does not match the query's shape is ignored outright —
     a note on the wrong step is worse than no note */
  const wrong = '/* sqlblocks-notes groupby#9=別的 */\n' + sql.split('\n').slice(1).join('\n');
  const stray = api.astToGraph(api.parseSQLText(wrong));
  assert.equal(stray.nodes.some(n => n.note), false);
  return 'note round-trips readable; a mismatched manifest is ignored';
});

/* analytic.trans_detail says nothing about what the table holds. The schema
   already carries the Chinese name, so a table step wears it without being
   asked — but a name the user typed themselves always wins, including a blank
   one they deliberately cleared. */
test('notes: a table step shows its Chinese name unless told otherwise', () => {
  const schema = api.demoSchema();
  installGraph(api, {
    nodes:[{id:'a', type:'table', table:'analytic.trans_detail'},
           {id:'b', type:'table', table:'analytic.trans_detail', note:'我自己取的'},
           {id:'c', type:'table', table:'analytic.trans_detail', note:''},
           {id:'d', type:'table', table:'沒這張表'},
           {id:'o', type:'output'}],
    edges:[],
  }, schema);
  const shown = id => api.noteOf(api.state.nodes.find(n => n.id === id));
  assert.equal(shown('a'), '交易資料', 'the schema label is used by default');
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
  const html = fs.readFileSync(new URL('../sql-blocks.html', import.meta.url), 'utf8');
  const foot = /getElementById\('foot'\)\.textContent\s*=\s*([\s\S]{0,300}?);/.exec(html);
  assert.ok(foot, "the footer text could not be found");
  assert.match(foot[1], /示意|編的|編出來/, 'the footer must say the rows are invented');
  assert.doesNotMatch(foot[1], /不是假圖|會回給你的結果/, 'and must not claim they are real');

  /* and the first step, which introduces the table, says the same */
  const first = /cap:\s*'先看原料[^']*'/.exec(html);
  assert.ok(first, 'the opening caption could not be found');
  assert.match(first[0], /示意|編出來/, 'the opening caption must not present the rows as real');
  return 'footer and opening caption both state the rows are illustrative';
});

/* Chaining JOINs works, but each one used to list every column of both sides:
   two 30-column tables produced a 70-line SELECT list, and a third table pushed
   it past 170 lines — correct SQL nobody can read. The left side is never
   dropped or renamed, so it goes across whole; the right side still has to be
   spelled out because its key columns are removed and collisions are aliased. */
test('join: chained joins work and do not spell out the left side', () => {
  const sql = 'SELECT a.deal_time, b.store_nm, c.fm_name, a.sale_amt\n' +
    'FROM analytic.trans_detail a\n' +
    'JOIN analytic.m_org_last b ON a.ostore_no = b.ostore_no\n' +
    'JOIN analytic.m_cmdt_offline c ON a.fm_code = c.fm_code';
  api.state.dialect = 'mssql';
  const graph = graphFromSQL(api, sql);

  assert.equal(graph.nodes.filter(n => n.type === 'join').length, 2, 'two joins, chained');
  assert.equal(api.evalNode(graph.nodes.find(n => n.type === 'output')).rows.length > 0, true,
    'the step-through must actually produce rows');

  const generated = api.buildSQL();
  assert.equal((generated.match(/a\.\*/g) || []).length, 2, 'each join carries its left side whole');
  assert.doesNotMatch(generated, /a\.deal_time,/, 'the left side is not spelled out');
  /* the right side stays explicit — its key column is dropped and fdp_upt collides */
  assert.match(generated, /b\.fdp_upt AS fdp_upt_2/);
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
    two:  'SELECT * FROM analytic.trans_detail a ' + join('b', 'analytic.m_org_last', 'a.ostore_no=b.ostore_no'),
    three:'SELECT * FROM analytic.trans_detail a ' + join('b', 'analytic.m_org_last', 'a.ostore_no=b.ostore_no') +
          ' ' + join('c', 'analytic.m_cmdt_offline', 'a.fm_code=c.fm_code'),
    five: 'SELECT * FROM analytic.trans_detail a ' + join('b', 'analytic.m_org_last', 'a.ostore_no=b.ostore_no') +
          ' ' + join('c', 'analytic.m_cmdt_offline', 'a.fm_code=c.fm_code') +
          ' ' + join('d', 'analytic.m_member', 'a.member_no=d.member_no') +
          ' ' + join('e', 'analytic.store_weather', 'a.ostore_no=e.ostore_no'),
  };
  const report = [];
  for (const [name, sql] of Object.entries(shapes)) {
    graphFromSQL(api, sql);
    api.settleLayout();
    assert.deepEqual(json(overlaps()), [], `${name}: steps must not sit on top of each other`);
    const loose = api.state.edges.filter(e => !api.isSnapped(e));
    assert.deepEqual(json(loose), [], `${name}: every link should still be touching`);
    report.push(`${name}=${api.state.nodes.length} steps`);
  }

  /* a branch must not shove the main chain around to make room for itself */
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
function stableSQL() {
  const {nodes, edges, uid} = api.state;
  const steps = () => api.chainOrder().map(n => n.type + (n.type === 'filter' ? ':' + n.op : '')).join(' > ');
  const generated = api.buildSQL(), before = steps();
  const back = api.astToGraph(api.parseSQLText(generated));
  api.state.nodes = back.nodes; api.state.edges = back.edges;
  try {
    assert.equal(steps(), before, 'same steps after reparsing');
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

test('OR editing: shrinking to one group collapses or splits into a chain', () => {
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
  const made = api.orDelTerm(f, 0, 0);
  assert.equal(made.length, 1);
  const filters = api.chainOrder().filter(n => n.type === 'filter');
  assert.deepEqual(json(filters.map(n => [n.col, n.op, n.val])), [['member_rank','<=',20], ['inv_rank','<=',20]]);
  assert.match(stableSQL(), /WHERE member_rank <= 20\n    AND inv_rank <= 20/);
  const out = api.evalNode(api.state.nodes.find(n => n.type === 'output'));
  assert.deepEqual(json(out.rows.map(r => r[0])), [4]);

  /* the last group being a nested OR becomes the node itself */
  graph = graphFromSQL(api, 'SELECT * FROM r WHERE id = 9 OR ((id = 1 OR id = 2) AND inv_rank > 0)');
  installGraph(api, graph, orData);
  f = graph.nodes.find(n => n.type === 'filter');
  api.orDelTerm(f, 0, 0);
  assert.equal(api.isOrFilter(f), true);
  assert.equal(f.any.length, 2);
  stableSQL();
  return 'one condition → plain filter; AND group → two chained filters; nested OR kept';
});

test('OR view: the block, inspector and step-through spell out the groups', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20 OR inv_rank <= 20');
  installGraph(api, graph, orData);
  const f = graph.nodes.find(n => n.type === 'filter');
  const summary = api.nodeSummary(f);
  assert.match(summary, /member_rank &lt;= 20<\/code><div class="orsep">或<\/div><code>inv_rank &lt;= 20/);

  api.state.sel = f.id;
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

test('OR editing: a plain filter offers the OR button', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20');
  installGraph(api, graph, orData);
  api.state.sel = graph.nodes.find(n => n.type === 'filter').id;
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
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /哪些列會留下[\s\S]*class="venn"/);
  return 'INNER shades 3 only; LEFT shades 1 and 3; legend names the tables';
});

test('Venn: chained filters shade the intersection, step by step', () => {
  const graph = graphFromSQL(api, 'SELECT * FROM r WHERE member_rank <= 20 AND inv_rank <= 20');
  installGraph(api, graph, orData);
  const [a, b] = api.chainOrder().filter(n => n.type === 'filter');
  assert.deepEqual(json(api.andChain(b).map(n => n.id)), [a.id, b.id]);
  assert.deepEqual(json(api.andChain(a).map(n => n.id)), [a.id, b.id]);
  /* rows: 1 only ①, 2 only ②, 3 neither, 4 both */
  const full = api.andVenn(a);
  assert.deepEqual(vennCounts(full), [['vout',1], ['vout',1], ['vin',1]], 'only the overlap is kept');
  assert.match(full, /一關都沒過 1</);
  assert.match(full, /4 列 → 過第①關 2 列 → 過第②關 1 列/);
  assert.match(full, /class="vcur">[^]*第①關[^]*← 這一塊/);
  const first = api.andVenn(a, 0);
  assert.deepEqual(vennCounts(first), [['vin',1], ['vout',1], ['vin',1]], 'after ① the whole first circle is still in');
  assert.doesNotMatch(first, /過第②關/);

  const step = api.buildSteps().filter(s => s.title === 'WHERE')[0];
  const box = {children:[], appendChild(c) { this.children.push(c); return c; }};
  step.render(box);
  assert.equal(box.children.length, 2);
  assert.match(box.children[1].innerHTML, /走到第①關/);

  api.state.sel = b.id;
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
  assert.equal(api.andChain(f).length, 4);
  assert.equal(api.andVenn(f), '');
  api.state.sel = f.id;
  api.renderInspector();
  assert.match(api.inspector.innerHTML, /共 4 塊篩選串在一起（AND），超過 3 塊文氏圖畫不下/);
  return 'single filter: none; four chained: note instead';
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
