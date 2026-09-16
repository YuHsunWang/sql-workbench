import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
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

test('generator: empty IN is syntactically guarded', () => {
  assert.equal(api.condSQL({col:'x', op:'IN', val:''}), 'x IN (NULL)');
  sqlError('SELECT * FROM t WHERE x IN ()');
  return 'graph emits IN (NULL); source IN () gets sqlErr';
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

test('graph: chainOrder without output is empty', () => {
  installGraph(api,{nodes:[{id:'t',type:'table',table:'t'}],edges:[]},oneColumnSchema());
  assert.deepEqual(json(api.chainOrder()), []);
  return '[]';
});

test('DEFECT: NULL predicates use two-valued JS logic', () => {
  const actual = [api.cmp(null,'<>','x'), api.cmp(null,'NOT IN','x'), api.cmp('','IS NULL','')];
  assert.deepEqual(actual, [true,true,true]);
  return `cmp(null,'<>','x'), cmp(null,'NOT IN','x'), cmp('','IS NULL') => ${actual.join(',')}`;
});

test('DEFECT: aggregates coerce NULL and reject text', () => {
  const actual = [
    api.aggregate({fn:'AVG',col:'x'}, [[null],[2]], ['x']),
    api.aggregate({fn:'COUNT',col:'x'}, [['a'],['b']], ['x']),
    api.aggregate({fn:'MAX',col:'x'}, [['a'],['b']], ['x']),
  ];
  assert.deepEqual(actual, [1,null,null]);
  return `AVG(NULL,2), COUNT(a,b), MAX(a,b) => ${JSON.stringify(actual)}`;
});

test('DEFECT: global aggregate over empty input emits no row', () => {
  const graph = globalAggregateGraph();
  installGraph(api, graph, {t:{cols:[{name:'x'}],rows:[]}});
  const actual = api.evalNode(graph.nodes[1]);
  assert.deepEqual(json(actual), {cols:['c'],rows:[]});
  return `COUNT(*) result=${JSON.stringify(actual)}`;
});

test('DEFECT: shared upstream is consumed only once', () => {
  const graph = branchedGraph();
  installGraph(api, graph, oneColumnSchema());
  const actual = api.evalNode(graph.nodes.find(n => n.id === 'u')).rows;
  assert.deepEqual(json(actual), [[2],[3]]);
  return `UNION ALL rows=${JSON.stringify(actual)} (second branch missing)`;
});

test('DEFECT: aggregate-only graph generates empty GROUP BY', () => {
  const graph = globalAggregateGraph();
  installGraph(api, graph, {t:{cols:[{name:'x'}],rows:[[1]]}});
  const generated = api.buildSQL();
  assert.match(generated, /GROUP BY \n\)/);
  sqlError(generated);
  return `generated tail=${JSON.stringify(generated.match(/GROUP BY[^)]*/s)[0])}; reparse=sqlErr`;
});

test('DEFECT: comma inside IN string becomes extra values', () => {
  const graph = graphFromSQL(api, "SELECT * FROM t WHERE x IN ('a,b','c')");
  const stored = graph.nodes.find(n => n.type === 'filter').val;
  const generated = api.buildSQL();
  assert.equal(stored, 'a,b, c');
  assert.match(generated, /IN \('a', 'b', 'c'\)/);
  return `stored=${JSON.stringify(stored)} generated=IN ('a', 'b', 'c')`;
});

test('DEFECT: identifier delimiters are not escaped', () => {
  const actual = {};
  for (const [dialect, value] of [['mysql','a`b'],['postgres','a"b'],['mssql','a]b']]) {
    api.state.dialect = dialect; actual[dialect] = api.q(value);
  }
  assert.deepEqual(actual, {mysql:'`a`b`',postgres:'"a"b"',mssql:'[a]b]'});
  return JSON.stringify(actual);
});

test('DEFECT: MySQL backslashes are emitted unescaped', () => {
  api.state.dialect = 'mysql';
  const value = String.raw`a\nb`;
  const actual = api.condSQL({col:'x',op:'=',val:value});
  assert.equal(actual, "x = 'a\\nb'");
  assert.equal((actual.match(/\\/g) || []).length, 1);
  return `condSQL=${JSON.stringify(actual)} (one backslash)`;
});

test('DEFECT: empty NOT IN execution disagrees with generated SQL', () => {
  const generated = api.condSQL({col:'x',op:'NOT IN',val:''});
  const actual = api.cmp(1,'NOT IN','');
  assert.equal(generated, 'x NOT IN (NULL)');
  assert.equal(actual, true);
  return `generated=${generated}; cmp(1,NOT IN,'')=${actual}`;
});

test('DEFECT: unterminated tokens parse successfully', () => {
  const inputs = ["SELECT 'abc", 'SELECT * FROM [abc', 'SELECT * FROM "abc', 'SELECT * FROM t /*'];
  const actual = inputs.map(sql => {
    const parsed = api.parseSQLText(sql);
    return parsed.warn.length;
  });
  assert.deepEqual(actual, [0,0,0,0]);
  return `4 malformed inputs accepted; warningCounts=${actual.join(',')}`;
});

test('DEFECT: statement splitter splits quoted identifier', () => {
  const input = 'SELECT * FROM [a;b]; SELECT 2';
  const actual = api.splitStatements(input);
  assert.deepEqual(json(actual), ['SELECT * FROM [a','b]','SELECT 2']);
  return JSON.stringify(actual);
});

test('DEFECT: cycle silently generates self-referencing CTE', () => {
  const graph = {nodes:[{id:'f',type:'filter',col:'x',op:'=',val:1},{id:'o',type:'output'}],
    edges:[{from:'f',to:'f',port:0},{from:'f',to:'o',port:0}]};
  installGraph(api, graph, oneColumnSchema());
  const generated = api.buildSQL();
  assert.match(generated, /filtered AS \([\s\S]*FROM filtered/);
  assert.deepEqual(json(api.evalNode(graph.nodes[0])), {cols:[],rows:[]});
  return 'eval=EMPTY; SQL has non-recursive FROM filtered self-reference';
});

test('DEFECT: unconnected input silently generates FROM ?', () => {
  const graph = {nodes:[{id:'f',type:'filter',col:'x',op:'=',val:1},{id:'o',type:'output'}],
    edges:[{from:'f',to:'o',port:0}]};
  installGraph(api, graph, oneColumnSchema());
  const generated = api.buildSQL();
  assert.match(generated, /FROM \?/);
  assert.deepEqual(json(api.evalNode(graph.nodes[0])), {cols:[],rows:[]});
  return 'eval=EMPTY; generated FROM ?';
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
