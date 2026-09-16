import fs from 'node:fs';
import vm from 'node:vm';

function element() {
  const target = {
    value: '', innerHTML: '', textContent: '', hidden: false, disabled: false,
    dataset: {}, style: {}, children: [], clientWidth: 1200, clientHeight: 700,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, focus() {},
    appendChild(child) { this.children.push(child); return child; },
    remove() {}, closest() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1200, height: 700 }; },
  };
  return new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key];
      if (key === Symbol.toPrimitive) return () => '';
      return () => null;
    },
  });
}

export function loadApp() {
  const html = fs.readFileSync(new URL('../sql-blocks.html', import.meta.url), 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('sql-blocks.html script not found');

  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement() { return element(); },
    addEventListener() {},
    elementFromPoint() { return null; },
  };
  const context = {
    console,
    document,
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { clipboard: { async writeText() {} } },
    setTimeout() { return 0; }, clearTimeout() {},
  };
  context.window = context;
  context.globalThis = context;
  vm.createContext(context);

  const exported = [
    'state', 'tokenize', 'parseSQLText', 'splitStatements', 'astToGraph',
    'evalNode', 'cmp', 'aggregate', 'numish', 'buildSQL', 'condSQL', 'lit',
    'q', 'tableRef', 'limHead', 'limTail', 'chainOrder',
    'demoSchema', 'sampleValue', 'joinLayout',
  ];
  const marker = '})();';
  const at = match[1].lastIndexOf(marker);
  if (at < 0) throw new Error('sql-blocks.html IIFE terminator not found');
  const hook = `Object.assign(globalThis.__sqlblocks, {${exported.join(',')}});\n`;
  const script = match[1].slice(0, at) + hook + match[1].slice(at);
  context.__sqlblocks = {};
  vm.runInContext(script, context, { filename: 'sql-blocks.html', timeout: 3000 });
  return context.__sqlblocks;
}

export function installGraph(api, graph, schema = {}) {
  api.state.nodes = graph.nodes;
  api.state.edges = graph.edges;
  api.state.schema = schema;
  api.state.uid = graph.nodes.length;
}

export function graphFromSQL(api, sql) {
  const graph = api.astToGraph(api.parseSQLText(sql));
  installGraph(api, graph, graph.schema);
  return graph;
}
