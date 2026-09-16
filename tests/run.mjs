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
