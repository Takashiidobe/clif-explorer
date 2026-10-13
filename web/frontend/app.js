import { defaultArgument, formatFloat, parseArgument, parseSharedArguments } from '../src/args.mjs';

const ARCHS = [
  ['x86_64', 'x86-64'],
  ['aarch64', 'AArch64'],
  ['riscv64', 'RISC-V 64'],
  ['s390x', 's390x'],
];
const BASELINE_FLAGS = { unwind_info: 'false' };
const TYPING_DELAY_MS = 300;
const INIT_TIMEOUT_MS = 60000;
const COMPILE_TIMEOUT_MS = 30000;
const RUN_TIMEOUT_MS = 20000;

const $ = (selector) => document.querySelector(selector);

function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') element.className = value;
    else if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (value === true) element.setAttribute(key, '');
    else if (value !== false && value != null) element.setAttribute(key, value);
  }
  element.append(...children.flat().filter((child) => child != null && child !== false));
  return element;
}

const storage = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  },
};

const hex = (value, digits = 0) => `0x${value.toString(16).padStart(digits, '0')}`;

function encodeProgram(program) {
  let binary = '';
  for (const byte of new TextEncoder().encode(program)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function decodeProgram(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
}

const toolbar = $('.toolbar');
const statusLine = $('#status');
const examplesSelect = $('#examples');
const versionSelect = $('#version');
const keymapSelect = $('#keymap');
const archSelect = $('#arch');
const flagsMenu = $('#flags-menu');
const flagsSummary = $('#flags-summary');
const flagsFilter = $('#flags-filter');
const flagsList = $('#flags-list');
const diagnostics = $('#diagnostics');
const clifShell = $('#clif-shell');
const asmContainer = $('#asm');
const runFunction = $('#run-function');
const runArgs = $('#run-args');
const runButton = $('#run');
const runResult = $('#run-result');

function setStatus(text, kind = '') {
  statusLine.textContent = text;
  statusLine.className = kind;
}

const KEYMAPS = ['default', 'emacs', 'vim'];
const storedKeymap = storage.get('clif:keymap');
const keymap = KEYMAPS.includes(storedKeymap) ? storedKeymap : 'default';

const editor = CodeMirror.fromTextArea($('#clif'), {
  keyMap: keymap,
  mode: 'clif',
  theme: 'material-darker',
  lineNumbers: true,
  indentUnit: 4,
  tabSize: 4,
  gutters: ['diagnostics-gutter', 'CodeMirror-linenumbers'],
});
new ResizeObserver(() => editor.refresh()).observe(clifShell);

const state = {
  version: '',
  arch: 'x86_64',
  flags: { ...BASELINE_FLAGS },
  tab: 'clif',
  syntax: 'intel',
  run: { function: '', args: [] },
};

let manifest;
let examples = [];
let settingSource = false;

class Client {
  constructor(version) {
    this.version = version;
    this.worker = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 0;
  }

  start() {
    if (this.worker) return this.ready;
    this.worker = new Worker(manifest.worker);
    this.worker.addEventListener('message', ({ data }) => this.receive(data));
    this.worker.addEventListener('error', (event) => this.kill(new Error(event.message || 'The worker failed to load.')));
    const version = manifest.versions.find((v) => v.id === this.version);
    this.ready = this.send('init', { version, assets: manifest.assets }, INIT_TIMEOUT_MS);
    this.ready.catch(() => {});
    return this.ready;
  }

  receive(data) {
    if (data.type === 'status') {
      setStatus(data.text);
      return;
    }
    const request = this.pending.get(data.id);
    if (!request) return;
    this.pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.ok) request.resolve(data.result);
    else request.reject(new Error(data.error));
  }

  send(type, payload, timeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.kill(new Error(`${type} timed out after ${timeoutMs / 1000}s.`)),
        timeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }

  async call(type, payload, timeoutMs) {
    await this.start();
    return this.send(type, payload, timeoutMs);
  }

  kill(error) {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

const clients = new Map();

function client() {
  if (!clients.has(state.version)) clients.set(state.version, new Client(state.version));
  return clients.get(state.version);
}

const schemas = new Map();
let currentSchema = [];

async function loadSchema() {
  const key = `${state.version}:${state.arch}`;
  if (!schemas.has(key)) {
    const pending = client().call('schema', { arch: state.arch }, INIT_TIMEOUT_MS);
    schemas.set(key, pending);
    pending.catch(() => schemas.delete(key));
  }
  currentSchema = await schemas.get(key);
  const known = new Set(currentSchema.map((flag) => flag.name));
  for (const name of Object.keys(state.flags)) if (!known.has(name)) delete state.flags[name];
  renderFlags();
}

function effectiveValue(flag) {
  if (flag.kind === 'preset') return state.flags[flag.name] ? 'on' : 'off';
  return state.flags[flag.name] ?? flag.default;
}

function setFlag(flag, value) {
  const isDefault = flag.kind === 'preset' ? value === 'off' : value === flag.default;
  if (isDefault) delete state.flags[flag.name];
  else state.flags[flag.name] = value;
  updateFlagsSummary();
  compileSoon(0);
}

function flagControl(flag) {
  const value = effectiveValue(flag);
  if (flag.kind === 'bool' || flag.kind === 'preset') {
    const on = flag.kind === 'bool' ? 'true' : 'on';
    const off = flag.kind === 'bool' ? 'false' : 'off';
    return [
      h('label', {},
        h('input', { type: 'checkbox', checked: value === on, onchange: (e) => setFlag(flag, e.target.checked ? on : off) }),
        h('span', { class: 'name' }, flag.name),
      ),
    ];
  }
  const control =
    flag.kind === 'enum'
      ? h('select', { onchange: (e) => setFlag(flag, e.target.value) },
          flag.values.map((option) => h('option', { value: option, selected: option === value }, option)))
      : h('input', { type: 'number', min: 0, max: 255, value, onchange: (e) => setFlag(flag, e.target.value) });
  return [h('span', { class: 'name' }, flag.name), control];
}

function renderFlags() {
  const needle = flagsFilter.value.trim().toLowerCase();
  const matches = currentSchema.filter(
    (flag) => !needle || flag.name.includes(needle) || flag.description.toLowerCase().includes(needle),
  );
  const group = (title, flags) =>
    flags.length
      ? [
          h('h4', {}, title),
          ...flags.map((flag) =>
            h('div', { class: `flag${flag.name in state.flags ? ' changed' : ''}` },
              flagControl(flag),
              h('span', { class: 'hint' }, flag.description),
            ),
          ),
        ]
      : [];
  const archName = ARCHS.find(([id]) => id === state.arch)[1];
  flagsList.replaceChildren(
    ...group('Shared', matches.filter((flag) => flag.shared)),
    ...group(`${archName}`, matches.filter((flag) => !flag.shared)),
  );
  flagsSummary.classList.toggle('disabled', !currentSchema.length);
  updateFlagsSummary();
}

function changedFlagCount() {
  const added = Object.entries(state.flags).filter(([name, value]) => BASELINE_FLAGS[name] !== value).length;
  const removed = Object.keys(BASELINE_FLAGS).filter((name) => !(name in state.flags)).length;
  return added + removed;
}

function updateFlagsSummary() {
  const count = changedFlagCount();
  flagsSummary.replaceChildren('Flags', count ? h('span', { class: 'count' }, ` (${count})`) : '');
}

function flagArguments() {
  const kinds = new Map(currentSchema.map((flag) => [flag.name, flag.kind]));
  const entries = Object.entries(state.flags).filter(([name]) => kinds.has(name));
  return [
    ...entries.filter(([name]) => kinds.get(name) === 'preset').map(([name]) => name),
    ...entries.filter(([name]) => kinds.get(name) !== 'preset').map(([name, value]) => `${name}=${value}`),
  ];
}

let markedLines = [];

function clearDiagnostics() {
  for (const [line, className] of markedLines) editor.removeLineClass(line, 'background', className);
  markedLines = [];
  editor.clearGutter('diagnostics-gutter');
  diagnostics.replaceChildren();
  diagnostics.hidden = true;
}

function showDiagnostics(errors) {
  clearDiagnostics();
  for (const error of errors) {
    diagnostics.append(h('pre', {}, error));
    const line = /^(\d+): /.exec(error)?.[1];
    if (!line || Number(line) > editor.lineCount()) continue;
    const index = Number(line) - 1;
    markedLines.push([editor.addLineClass(index, 'background', 'error-line'), 'error-line']);
    editor.setGutterMarker(index, 'diagnostics-gutter', h('span', { class: 'diagnostic-marker', title: error }, '●'));
  }
  diagnostics.hidden = !errors.length;
  $('#tab-button-clif').replaceChildren('CLIF', errors.length ? h('span', { class: 'badge' }, '●') : '');
}

function instructionCell(text, decoded) {
  const split = text.indexOf(' ');
  if (!decoded || split < 0) return h('td', { class: 'insn' }, text);
  return h('td', { class: 'insn' }, h('span', { class: 'mn' }, text.slice(0, split)), text.slice(split));
}

function listingRow(line) {
  const note = line.note ?? (line.trap ? `; trap: ${line.trap}` : '');
  return h('tr', { class: `${line.decoded ? '' : 'raw'}${line.trap ? ' trap' : ''}`.trim() },
    h('td', { class: 'off' }, line.offset.toString(16).padStart(4, '0')),
    h('td', { class: 'bytes' }, Array.from(line.bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')),
    instructionCell(line.text, line.decoded),
    h('td', { class: 'note' }, note),
  );
}

function relocTarget(reloc) {
  const addend = reloc.addend ? `${reloc.addend > 0 ? '+' : ''}${reloc.addend}` : '';
  return `${reloc.target}${addend}`;
}

function annotateRelocs(f) {
  const lines = [];
  for (const line of f.lines) {
    const constant = f.relocs.find((r) => r.kind === 'Abs8' && line.offset >= r.offset && line.offset < r.offset + 8);
    if (constant) {
      if (line.offset === constant.offset) {
        const bytes = f.code.slice(constant.offset, constant.offset + 8);
        lines.push({ offset: constant.offset, bytes, text: `.quad ${relocTarget(constant)}`, decoded: false });
      }
      continue;
    }
    const inside = f.relocs.filter((r) => r.offset >= line.offset && r.offset < line.offset + line.size);
    lines.push(inside.length ? { ...line, note: `; reloc: ${inside.map(relocTarget).join(', ')}` } : line);
  }
  return lines;
}

function signature(f) {
  return `(${f.params.join(', ')})${f.returns.length ? ` -> ${f.returns.join(', ')}` : ''}`;
}

let lastCompile = null;

function renderAsm() {
  const vcode = document.querySelector('input[name=asm-view]:checked').value === 'vcode';
  $('#asm-syntax').hidden = state.arch !== 'x86_64' || vcode;
  if (!lastCompile) return;
  const att = state.syntax === 'att';
  const blocks = lastCompile.result.functions.map((f) =>
    h('div', { class: 'fn-block' },
      h('h3', {}, f.name, ' ', h('span', { class: 'muted' }, `${f.code.length} bytes · ${f.call_conv} · ${signature(f)}`)),
      vcode
        ? h('pre', { class: 'vcode' }, f.vcode ?? '')
        : h('table', { class: 'listing' }, h('tbody', {}, annotateRelocs(att && f.attLines ? { ...f, lines: f.attLines } : f).map(listingRow))),
      !vcode && f.relocs.length
        ? h('ul', { class: 'relocs' },
            f.relocs.map((r) => h('li', {}, `+0x${r.offset.toString(16)}: ${r.kind} ${r.target}${r.addend ? ` ${r.addend > 0 ? '+' : ''}${r.addend}` : ''}`)))
        : null,
    ),
  );
  asmContainer.replaceChildren(...blocks);
}

function renderRunFunctions() {
  const functions = lastCompile?.result.functions ?? [];
  const wanted = state.run.function;
  runFunction.replaceChildren(
    ...functions.map((f) => h('option', { value: f.name, selected: f.name === wanted }, f.name)),
  );
  if (!functions.some((f) => f.name === wanted)) state.run.function = functions[0]?.name ?? '';
  runFunction.value = state.run.function;
  renderRunArgs();
}

function renderRunArgs() {
  const f = lastCompile?.result.functions.find((fn) => fn.name === state.run.function);
  runArgs.replaceChildren(
    ...(f?.params ?? []).map((type, i) =>
      h('label', {}, `v${i}: ${type}`,
        h('input', {
          type: 'text',
          spellcheck: 'false',
          autocomplete: 'off',
          value: state.run.args[i] ?? defaultArgument(type),
          style: type.includes('x') || type === 'i128' ? 'width: 280px' : '',
          'data-index': i,
          oninput: (e) => {
            state.run.args[i] = e.target.value;
          },
          onkeydown: (e) => {
            if (e.key === 'Enter') run();
          },
        }),
      ),
    ),
  );
  runButton.disabled = !f;
}

let compileSeq = 0;
let compileTimer;

function compileSoon(delay = TYPING_DELAY_MS) {
  clearTimeout(compileTimer);
  setStatus('');
  compileTimer = setTimeout(compile, delay);
}

async function compile() {
  clearTimeout(compileTimer);
  compileTimer = undefined;
  const seq = ++compileSeq;
  toolbar.classList.add('busy');
  try {
    await loadSchema();
    if (seq !== compileSeq) return;
    const request = { arch: state.arch, clif: editor.getValue(), flags: flagArguments() };
    const result = await client().call('compile', request, COMPILE_TIMEOUT_MS);
    if (seq !== compileSeq) return;
    saveState();
    showDiagnostics(result.errors);
    if (result.errors.length) {
      lastCompile = null;
      asmContainer.replaceChildren(h('p', {}, 'The program does not compile. See the errors on the CLIF tab.'));
      renderRunFunctions();
      setStatus(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}.`, 'error');
      return;
    }
    lastCompile = { request, result };
    clifShell.classList.remove('stale');
    renderAsm();
    renderRunFunctions();
    setStatus(`Compiled ${result.functions.length} function${result.functions.length === 1 ? '' : 's'} in ${Math.round(result.ms)} ms.`, 'ok');
  } catch (error) {
    if (seq !== compileSeq) return;
    lastCompile = null;
    setStatus(error.message, 'error');
  } finally {
    if (seq === compileSeq) toolbar.classList.remove('busy');
  }
}

function formatReturn(r) {
  if (r.lanes) {
    const lanes = r.lanes.map((lane) => lane.type.startsWith('f') ? formatFloat(lane.value) : String(lane.signed));
    return `[${lanes.join(', ')}] (${hex(r.bits)})`;
  }
  if (r.type.startsWith('f')) return `${formatFloat(r.value)} (${hex(r.bits)})`;
  const unsigned = hex(r.unsigned);
  return r.signed === r.unsigned ? `${r.signed} (${unsigned})` : `${r.signed} (${unsigned}, unsigned ${r.unsigned})`;
}

function showRunResult(result) {
  const where = result.function ? `${result.function}+${hex(result.offset ?? 0)}` : '';
  const instruction = result.text ? ` (${result.text})` : '';
  const elapsed = `${Math.round(result.ms)} ms`;
  runResult.hidden = false;
  runResult.className = `result ${result.status === 'ok' ? 'ok' : result.status === 'trap' ? 'trap' : 'fault'}`;
  const detail = (text) => h('div', { class: 'detail' }, text);
  if (result.status === 'ok') {
    runResult.replaceChildren(
      result.returns.length ? `Returned ${result.returns.map(formatReturn).join(', ')}` : 'Returned',
      detail(elapsed),
    );
  } else if (result.status === 'trap') {
    runResult.replaceChildren(`Trapped: ${result.trapCode} at ${where}${instruction}`, detail(`${result.error}, ${elapsed}`));
  } else if (result.status === 'timeout') {
    runResult.replaceChildren('Timed out.', detail('The function did not return. It may loop forever.'));
  } else {
    runResult.replaceChildren(`Fault: ${result.error}${where ? ` at ${where}` : ''}${instruction}`, detail(elapsed));
  }
}

async function run() {
  if (compileTimer) await compile();
  const f = lastCompile?.result.functions.find((fn) => fn.name === state.run.function);
  if (!f) return;
  let args;
  try {
    args = f.params.map((type, i) => parseArgument(type, state.run.args[i] ?? defaultArgument(type)));
  } catch (error) {
    setStatus(error.message, 'error');
    return;
  }
  toolbar.classList.add('busy');
  runButton.disabled = true;
  setStatus('Running…');
  try {
    const result = await client().call(
      'run',
      { ...lastCompile.request, function: f.name, args },
      RUN_TIMEOUT_MS,
    );
    showRunResult(result);
    setStatus('');
    saveState();
  } catch (error) {
    runResult.hidden = false;
    runResult.className = 'result fault';
    runResult.replaceChildren(error.message);
      setStatus('');
  } finally {
    toolbar.classList.remove('busy');
    runButton.disabled = false;
  }
}

function setTab(name) {
  state.tab = name;
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const id of ['clif', 'asm', 'run']) $(`#tab-${id}`).hidden = id !== name;
  if (name === 'clif') editor.refresh();
}

function currentState() {
  return { code: editor.getValue(), ...state, run: { ...state.run, args: [...state.run.args] } };
}

function formatFlags(flags) {
  return Object.entries(flags)
    .map(([name, value]) => `${name}=${value}`)
    .join(',');
}

function parseFlags(text) {
  const flags = {};
  for (const item of text.split(',')) {
    const [name, ...value] = item.split('=');
    if (name) flags[name] = value.join('=');
  }
  return flags;
}

function stateParams(snapshot) {
  const params = new URLSearchParams({
    code: encodeProgram(snapshot.code),
    version: snapshot.version,
    arch: snapshot.arch,
    tab: snapshot.tab,
  });
  if (Object.keys(snapshot.flags).length) params.set('flags', formatFlags(snapshot.flags));
  if (snapshot.run.function) params.set('fn', snapshot.run.function);
  if (snapshot.run.args.length) params.set('args', JSON.stringify(snapshot.run.args));
  return params;
}

function saveState() {
  const snapshot = currentState();
  storage.set('clif:state', JSON.stringify(snapshot));
  const query = new URLSearchParams(location.search);
  query.set('syntax', state.syntax);
  history.replaceState(null, '', `${location.pathname}?${query}#${stateParams(snapshot).toString().replaceAll('%2C', ',').replaceAll('%3D', '=')}`);
}

function linkedState() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('code')) return null;
  return {
    code: decodeProgram(params.get('code')),
    version: params.get('version'),
    arch: params.get('arch'),
    tab: params.get('tab'),
    flags: parseFlags(params.get('flags') ?? ''),
    run: {
      function: params.get('fn') ?? '',
      args: params.has('args') ? parseSharedArguments(params.get('args')) : [],
    },
  };
}

function storedState() {
  try {
    const stored = JSON.parse(storage.get('clif:state'));
    return typeof stored?.code === 'string' ? stored : null;
  } catch {
    return null;
  }
}

function applyState(snapshot) {
  if (manifest.versions.some((v) => v.id === snapshot.version)) state.version = snapshot.version;
  if (ARCHS.some(([id]) => id === snapshot.arch)) state.arch = snapshot.arch;
  state.flags = { ...(snapshot.flags ?? BASELINE_FLAGS) };
  state.run = { function: snapshot.run?.function ?? '', args: snapshot.run?.args ?? [] };
  if (['intel', 'att'].includes(snapshot.syntax)) state.syntax = snapshot.syntax;
  versionSelect.value = state.version;
  archSelect.value = state.arch;
  settingSource = true;
  editor.setValue(snapshot.code);
  settingSource = false;
  setTab(['clif', 'asm', 'run'].includes(snapshot.tab) ? snapshot.tab : 'clif');
}

function chooseExample() {
  const example = examples.find(({ name }) => name === examplesSelect.value);
  if (!example) return;
  state.flags = { ...BASELINE_FLAGS };
  state.run = { function: example.run.function, args: [...example.run.args] };
  settingSource = true;
  editor.setValue(example.source);
  settingSource = false;
  runResult.hidden = true;
  compileSoon(0);
}

async function copyShareLink() {
  saveState();
  try {
    await navigator.clipboard.writeText(location.href);
    setStatus('Share link copied.', 'ok');
  } catch {
    window.prompt('Copy this share link:', location.href);
  }
}

async function loadExamples() {
  const fetchOk = async (path) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path} failed (${response.status})`);
    return response;
  };
  const groups = await (await fetchOk('examples/index.json')).json();
  for (const { group, examples: entries } of groups) {
    const loaded = await Promise.all(
      entries.map(async (entry) => ({ ...entry, source: await (await fetchOk(`examples/${entry.file}`)).text() })),
    );
    examplesSelect.append(h('optgroup', { label: group }, loaded.map(({ name }) => h('option', { value: name }, name))));
    examples.push(...loaded);
  }
}

function wireEvents() {
  editor.on('change', () => {
    if (settingSource) return;
    examplesSelect.value = '';
    clifShell.classList.add('stale');
    compileSoon();
  });
  examplesSelect.addEventListener('change', chooseExample);
  versionSelect.addEventListener('change', () => {
    state.version = versionSelect.value;
    currentSchema = [];
    compileSoon(0);
  });
  archSelect.addEventListener('change', () => {
    state.arch = archSelect.value;
    renderAsm();
    currentSchema = [];
    renderFlags();
    compileSoon(0);
  });
  flagsFilter.addEventListener('input', renderFlags);
  $('#flags-reset').addEventListener('click', () => {
    state.flags = { ...BASELINE_FLAGS };
    renderFlags();
    compileSoon(0);
  });
  document.addEventListener('click', (event) => {
    if (!flagsMenu.contains(event.target)) flagsMenu.open = false;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') flagsMenu.open = false;
  });
  for (const button of document.querySelectorAll('.tabs button')) {
    button.addEventListener('click', () => {
      setTab(button.dataset.tab);
      saveState();
    });
  }
  for (const radio of document.querySelectorAll('input[name=asm-view]')) radio.addEventListener('change', renderAsm);
  for (const radio of document.querySelectorAll('input[name=asm-syntax]')) {
    radio.addEventListener('change', () => {
      state.syntax = radio.value;
      renderAsm();
      saveState();
    });
  }
  runFunction.addEventListener('change', () => {
    state.run.function = runFunction.value;
    state.run.args = [];
    renderRunArgs();
  });
  runButton.addEventListener('click', run);
  $('#share').addEventListener('click', copyShareLink);
  keymapSelect.value = keymap;
  keymapSelect.addEventListener('change', () => {
    editor.setOption('keyMap', keymapSelect.value);
    storage.set('clif:keymap', keymapSelect.value);
    editor.focus();
  });
}

async function main() {
  manifest = await (await fetch('manifest.json')).json();
  versionSelect.replaceChildren(...manifest.versions.map((v) => h('option', { value: v.id }, v.label)));
  archSelect.replaceChildren(...ARCHS.map(([id, label]) => h('option', { value: id }, label)));
  state.version = manifest.defaultVersion;
  const querySyntax = new URLSearchParams(location.search).get('syntax');
  const storedSyntax = storedState()?.syntax;
  if (['intel', 'att'].includes(storedSyntax)) state.syntax = storedSyntax;
  wireEvents();
  try {
    await loadExamples();
  } catch (error) {
    setStatus(String(error), 'error');
  }

  let snapshot = null;
  try {
    snapshot = linkedState();
  } catch {
    setStatus('The shared program link is invalid.', 'error');
  }
  snapshot ??= storedState();
  if (snapshot) {
    applyState(snapshot);
    examplesSelect.value = examples.find((e) => e.source === snapshot.code)?.name ?? '';
    compileSoon(0);
  } else {
    examplesSelect.value = examples[0]?.name ?? '';
    versionSelect.value = state.version;
    archSelect.value = state.arch;
    chooseExample();
  }
  if (['intel', 'att'].includes(querySyntax)) state.syntax = querySyntax;
  $(`input[name=asm-syntax][value=${state.syntax}]`).checked = true;
  renderAsm();
}

main().catch((error) => setStatus(String(error), 'error'));
