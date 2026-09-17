import fs from 'node:fs';
import vm from 'node:vm';

function element() {
  const target = {
    value: '', innerHTML: '', textContent: '', hidden: false, disabled: false,
    dataset: {}, style: {}, children: [], clientWidth: 1200, clientHeight: 700,
    scrollLeft: 0, scrollTop: 0, scrollTo() {},
    /* nodes are a fixed width and a natural height, but grow when the layout
       gives them a min-height — the snapping geometry depends on that */
    offsetWidth: 164,
    get offsetHeight() { return Math.max(86, parseInt(this.style.minHeight, 10) || 0); },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, focus() {},
    appendChild(child) {
      if (child) child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      const parent = this.parentNode;
      if (parent) parent.children = parent.children.filter(c => c !== this);
    },
    closest() { return null; },
    /* enough of a DOM for the canvas: nodes are appended, found back by their
       data-id, and removed — which is what the snapping geometry reads */
    querySelector(selector) {
      const id = /\[data-id="([^"]+)"\]/.exec(selector || '');
      if (!id) return null;
      return this.children.find(c => c.dataset && c.dataset.id === id[1]) || null;
    },
    querySelectorAll(selector) {
      if (!/\.node\b/.test(selector || '')) return [];
      return this.children.filter(c => c.dataset && c.dataset.id);
    },
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

/* `stored` seeds localStorage before the app boots, so a test can start it the
   way a returning user's browser would — including with corrupt saved data. */
export function loadApp(stored = {}) {
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
    localStorage: {
      getItem(key) { return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null; },
      setItem(key, value) { stored[key] = String(value); },
    },
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
    'isSnapped', 'snapFor', 'snapLayout', 'settleLayout', 'nodeBox', 'SNAP_GAP',
    'QUICK', 'QUICK_DEFAULT', 'codeRange', 'parseCodes', 'readCodes', 'expandRange',
    'validQuick', 'quickCodes', 'quickVal', 'noteManifest', 'applyNotes', 'chainOf',
    'nodeSummary', 'removeNode', 'addNode', 'viewCenter', 'noteOf', 'autoNote',
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
