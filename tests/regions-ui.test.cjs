const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require.resolve('../policy/regions.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
// Small DOM fixture: execute the real page handlers and inspect their rendered state.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.className = ''; this._text = ''; this._value = undefined; this.style = {}; }
  append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
  replaceChildren(...items) { this.children = []; this._text = ''; this._value = undefined; this.append(...items); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.children = []; this._text = String(value); }
  get value() { return this._value ?? (this.tagName === 'select' ? this.children[0]?.value || '' : ''); }
  set value(value) { this._value = String(value); }
  get options() { return this.children; }
  get innerHTML() { return ''; }
  set innerHTML(value) { this.replaceChildren(); parse(value, this); }
  querySelectorAll(selector) { const result = []; for (const child of this.children) { if (selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) result.push(child); result.push(...child.querySelectorAll(selector)); } return result; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  addEventListener(type, handler) { this['on' + type] = handler; }
  remove() { this.parent.children = this.parent.children.filter(c => c !== this); }
  select() { this.selected = true; }
}
function parse(markup, root) {
  const stack = [root];
  for (const match of markup.matchAll(/<\/?([a-z][a-z0-9]*)\b([^>]*)>|([^<]+)/gi)) {
    if (!match[1]) { stack.at(-1)._text += match[3]; continue; }
    if (match[0].startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const el = new Element(match[1]);
    for (const attr of match[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el[attr[1] === 'class' ? 'className' : attr[1]] = attr[2] ?? true;
    stack.at(-1).append(el);
    if (!['input', 'meta', 'br'].includes(el.tagName)) stack.push(el);
  }
}
const codes = ['US', 'US-EAST', 'US-CENTRAL', 'US-WEST', 'JP', 'SG', 'HK', 'DE', 'GB'];
function fixture() {
  const regions = ['US', 'JP', 'SG', 'HK', 'DE', 'GB'].map(code => ({ code, name: code, exits: [], auto: true, source: code }));
  return { config: { version: 3, defaultRegion: 'US', regions }, sources: regions,
    entries: codes.map(code => ({ code, name: 'Naiops-' + code, country: code.startsWith('US') ? 'US' : code, area: code.includes('-') ? code.split('-')[1].toLowerCase() : null })),
    subscriptions: { clash: 'https://fixture.invalid/sub?target=clash', vless: 'https://fixture.invalid/sub?protocol=vless', ss: 'https://fixture.invalid/sub?protocol=ss' } };
}
function pool(code, state = 'not_checked') {
  return { region: code, country: code.startsWith('US') ? 'US' : code, area: code.includes('-') ? code.split('-')[1].toLowerCase() : null, colo: 'SJC', available: state === null, availableCount: state === null ? 1 : 0,
    unavailableState: state, unavailableReason: state ? 'server reason: ' + state : null, pool: null,
    countryPool: { discoveredCount: 8, probedCount: 4, lastAttemptAt: 1000, nextRefreshAt: 2000 } };
}
async function page(handler) {
  const root = new Element('document');
  parse(html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*?<\/script>/g, ''), root);
  const document = { querySelectorAll: s => root.querySelectorAll(s), createElement: tag => new Element(tag) };
  // IDs do not need a general CSS selector implementation.
  document.getElementById = id => { const walk = el => el.id === id ? el : el.children.map(walk).find(Boolean); return walk(root); };
  const calls = []; let active = 0, peak = 0;
  const fetch = async (url, options = {}) => {
    calls.push({ url, options }); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    try { const result = await handler(url, options); return { ok: result.status === undefined || result.status < 400, status: result.status || 200, redirected: false, json: async () => result.data }; } finally { active--; }
  };
  const context = vm.createContext({ document, fetch, URL, console, navigator: { clipboard: { writeText: async () => {} } }, location: { assign() {} }, Option: function(text, value) { const el = new Element('option'); el.textContent = text; el.value = value; return el; } });
  new vm.Script(script).runInContext(context);
  async function settle() { for (let i = 0; i < 100 && vm.runInContext('loading || typeof statusReading !== "undefined" && statusReading', context); i++) await new Promise(resolve => setTimeout(resolve, 5)); }
  await settle();
  return { context, calls, document, root, settle, peak: () => peak, run: code => vm.runInContext(code, context) };
}
const defaultHandler = (url, options) => ({ data: url.startsWith('/admin/regions.json') ? options.method === 'POST' ? { config: JSON.parse(options.body), message: 'saved' } : fixture() : pool(new URL(url, 'https://fixture.invalid').searchParams.get('region')) });
test('page loads all nine server entries with at most two read-only requests', async () => {
  const p = await page(defaultHandler);
  assert.equal(p.document.getElementById('scope').options.length, 10);
  assert.equal(p.root.querySelectorAll('.entry-card').length, 9);
  assert.deepEqual(p.calls.filter(c => c.url.startsWith('/admin/exits')).map(c => new URL(c.url, 'https://fixture.invalid').searchParams.get('region')).sort(), [...codes].sort());
  assert.ok(p.peak() <= 2);
  assert.ok(p.calls.every(c => !c.options.method));
  assert.equal(p.root.querySelectorAll('.region').length, 6);
});
test('server unavailable states and reasons remain distinct, including available null state', async () => {
  const states = ['not_checked', 'expired', 'source_failed', 'missing_geo', 'area_unavailable', 'country_unavailable', null];
  const p = await page((url, options) => url.startsWith('/admin/regions') ? defaultHandler(url, options) : { data: pool(new URL(url, 'https://fixture.invalid').searchParams.get('region'), states[codes.indexOf(new URL(url, 'https://fixture.invalid').searchParams.get('region')) % states.length]) });
  const cards = p.root.querySelectorAll('.entry-card');
  const labels = ['待检测', '已过期', '来源或检测失败', '缺少地理证明', '子区域不可用', '国家不可用', '可用'];
  for (let i = 0; i < states.length; i++) { assert.equal(cards[i].querySelector('.state').textContent, labels[i]); if (states[i]) assert.ok(cards[i].textContent.includes('server reason: ' + states[i])); }
});
test('US refresh posts once and rereads all US siblings; 429 remains visible', async () => {
  const p = await page((url, options) => options.method === 'POST' && url.startsWith('/admin/exits') ? { status: 429, data: { error: '请至少等待 60 秒' } } : defaultHandler(url, options));
  const before = p.calls.length;
  await Promise.all([p.run("refreshEntry('US-WEST')"), p.run("refreshEntry('US-EAST')")]);
  const calls = p.calls.slice(before);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
  assert.deepEqual(calls.filter(c => !c.options.method).map(c => new URL(c.url, 'https://fixture.invalid').searchParams.get('region')).sort(), codes.slice(0, 4).sort());
  assert.ok(p.root.textContent.includes('60 秒'));
});
test('selected subscription scope survives config-only save and failed reload preserves edits', async () => {
  let fail = false;
  const p = await page((url, options) => fail && url.startsWith('/admin/regions') ? { status: 503, data: { error: 'temporarily unavailable' } } : defaultHandler(url, options));
  const scope = p.document.getElementById('scope'); scope.value = 'US-WEST'; scope.onchange();
  const first = p.document.getElementById('addresses').querySelector('input');
  assert.equal(new URL(first.value).searchParams.get('region'), 'US-WEST');
  const before = p.calls.length;
  await p.document.getElementById('form').onsubmit({ preventDefault() {} });
  assert.equal(scope.value, 'US-WEST');
  const saveCalls = p.calls.slice(before);
  assert.ok(saveCalls.some(c => c.url === '/admin/regions.json' && c.options.method === 'POST'));
  assert.ok(saveCalls.some(c => c.url === '/admin/regions.json' && !c.options.method));
  const rows = p.root.querySelectorAll('.region'); rows[0].querySelector('.name').value = 'unsaved edit'; fail = true;
  await p.run('read()');
  assert.equal(p.root.querySelectorAll('.region')[0].querySelector('.name').value, 'unsaved edit');
  assert.ok(p.document.getElementById('status').textContent.includes('temporarily unavailable'));
});
test('empty entries and initial network failure expose recovery without inventing a country', async () => {
  const empty = await page(() => ({ data: { ...fixture(), entries: [] } }));
  assert.equal(empty.root.querySelectorAll('.entry-card').length, 0);
  assert.ok(empty.document.getElementById('overviewStatus').textContent.includes('暂无地区入口'));
  assert.equal(empty.document.getElementById('links').hidden, true);
  const failed = await page(() => ({ status: 503, data: { error: 'configuration unavailable' } }));
  assert.equal(failed.root.querySelectorAll('.region').length, 0);
  assert.equal(failed.document.getElementById('save').disabled, true);
  assert.equal(failed.document.getElementById('reload').disabled, false);
  assert.ok(failed.document.getElementById('status').textContent.includes('configuration unavailable'));
});
test('failed status reread retains last known state and gives per-card recovery feedback', async () => {
  let fail = false;
  const p = await page((url, options) => url.startsWith('/admin/regions') ? defaultHandler(url, options) : fail ? { status: 503, data: { error: 'status unavailable' } } : { data: pool(new URL(url, 'https://fixture.invalid').searchParams.get('region'), null) });
  fail = true; await p.document.getElementById('statusRead').onclick();
  const card = p.root.querySelectorAll('.entry-card')[0];
  assert.equal(card.querySelector('.state').textContent, '可用');
  assert.ok(card.querySelector('.feedback').textContent.includes('status unavailable'));
  assert.ok(p.document.getElementById('overviewStatus').textContent.includes('9 个地区读取失败'));
  assert.equal(p.document.getElementById('statusRead').disabled, false);
});
