import { defaultArgument, formatFloat, parseArgument, parseSharedArguments } from '../src/args.mjs';
import riscvInstructionHelp from '../src/riscv-instruction-help.json';
import x86InstructionHelp from '../src/x86-instruction-help.json';
import armInstructionHelp from '../src/arm-instruction-help.json';
import s390xInstructionHelp from '../src/s390x-instruction-help.json';

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

function disassemblerFlags() {
  return Object.fromEntries(
    currentSchema
      .filter((flag) => !flag.shared && flag.kind === 'bool')
      .map((flag) => [flag.name, effectiveValue(flag) === 'true']),
  );
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

const instructionHelp = {
  udf: 'Raises an Undefined Instruction exception. The immediate value can identify the trap to an exception handler.',
  unimp: 'Deliberately raises an illegal-instruction exception. UNIMP is an assembler pseudo-instruction encoded using an instruction reserved as illegal.',
  mv: 'Copies the source register value into the destination register. In RISC-V this is an assembler alias for addi with an immediate of 0.',
  add: 'Adds the source operands and writes the result to the destination.',
  addi: 'Adds a sign-extended immediate value to a register and writes the result.',
  sub: 'Subtracts the second source operand from the first and writes the result.',
  lui: 'Loads an immediate into the upper bits of the destination register; the lower bits are zeroed.',
  auipc: 'Adds an upper-immediate value to the current instruction address and writes the result.',
  li: 'Loads an immediate constant into the destination register. In RISC-V this may expand to one or more instructions.',
  lw: 'Loads a 32-bit word from memory into a register, sign-extending it on RV64.',
  ld: 'Loads a 64-bit doubleword from memory into a register.',
  sw: 'Stores the low 32 bits of a register to memory.',
  sd: 'Stores a 64-bit register value to memory.',
  lb: 'Loads a byte from memory and sign-extends it to the register width.',
  lbu: 'Loads a byte from memory and zero-extends it to the register width.',
  beq: 'Branches to the target if the two registers are equal.',
  bne: 'Branches to the target if the two registers are not equal.',
  blt: 'Branches to the target if the first register is less than the second, using signed comparison.',
  bge: 'Branches to the target if the first register is greater than or equal to the second, using signed comparison.',
  bltu: 'Branches to the target if the first register is less than the second, using unsigned comparison.',
  bgeu: 'Branches to the target if the first register is greater than or equal to the second, using unsigned comparison.',
  jal: 'Jumps to the target and saves the address of the following instruction in the destination register.',
  jalr: 'Jumps to an address computed from a register and offset, saving the following instruction address in the destination register.',
  ret: 'Returns from the current function by jumping to the saved return address.',
  call: 'Calls a function, saving the return address. The assembler or linker may expand this into multiple instructions.',
  and: 'Performs a bitwise AND of the source operands.',
  andi: 'Performs a bitwise AND between a register and an immediate value.',
  or: 'Performs a bitwise OR of the source operands.',
  ori: 'Performs a bitwise OR between a register and an immediate value.',
  xor: 'Performs a bitwise exclusive OR of the source operands.',
  xori: 'Performs a bitwise exclusive OR between a register and an immediate value.',
  sll: 'Shifts the first source operand left by the shift amount in the second operand.',
  slli: 'Shifts a register left by the encoded immediate shift amount.',
  srl: 'Shifts the first source operand right, filling vacated bits with zero.',
  srli: 'Shifts a register right logically by the encoded immediate shift amount.',
  sra: 'Shifts the first source operand right arithmetically, preserving its sign.',
  srai: 'Shifts a register right arithmetically by the encoded immediate shift amount.',
  mul: 'Multiplies the source operands and writes the low XLEN bits of the product.',
  div: 'Divides the first source operand by the second using signed division.',
  divu: 'Divides the first source operand by the second using unsigned division.',
  rem: 'Writes the signed remainder of dividing the first source operand by the second.',
  remu: 'Writes the unsigned remainder of dividing the first source operand by the second.',
  ecall: 'Requests a service from the execution environment, such as the operating system or runtime.',
  ebreak: 'Raises a breakpoint exception, typically for a debugger.',
  nop: 'Does not change program state; in RISC-V this is an assembler alias for addi x0, x0, 0.',
};

function splitOperands(operands) {
  const result = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < operands.length; i++) {
    if ('([{'.includes(operands[i])) depth++;
    if (')]}'.includes(operands[i])) depth--;
    if (operands[i] === ',' && depth === 0) {
      result.push(operands.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (operands.slice(start).trim()) result.push(operands.slice(start).trim());
  return result;
}

function describeRiscvOperands(description, template, operands) {
  const values = {};
  const templateOperands = splitOperands(template ?? '');
  const actualOperands = splitOperands(operands);
  for (let i = 0; i < Math.min(templateOperands.length, actualOperands.length); i++) {
    const form = /^([a-z][a-z\d]*)(?:\(([a-z][a-z\d]*)\))?$/i.exec(templateOperands[i]);
    if (!form) continue;
    const memory = /^([^()]*)\(([^()]*)\)$/.exec(actualOperands[i]);
    values[form[1]] = form[2] && memory ? memory[1] : actualOperands[i];
    if (form[2] && memory) values[form[2]] = memory[2];
  }
  const names = Object.keys(values);
  if (!names.length) return description;
  const pattern = new RegExp(`\\b(?:${names.join('|')})\\b`, 'g');
  return description.replace(pattern, (name) => values[name]).replaceAll('`', '');
}

function describeX86Operands(record, operands, syntax) {
  const actual = splitOperands(operands);
  const template = splitOperands((record.syntax ?? '').replace(/^\S+\s*/, ''));
  const values = {};
  const att = syntax === 'att';
  for (let i = 0; i < Math.min(actual.length, template.length); i++) {
    const index = att ? actual.length - i - 1 : i;
    const role = record.operands?.[index]?.name;
    if (role) values[role] = actual[i].replace(/^\*/, '').replace(/^\$/, '');
  }
  const mnemonic = record.syntax?.split(' ')[0]?.toLowerCase();
  const clean = (value) => value?.replace(/^\*/, '').replace(/^%/, '').replace(/^\$/, '');
  if (mnemonic === 'mov' && values.src && values.dest && /^[a-z]+\d*$/i.test(clean(values.src)) && /^[a-z]+\d*$/i.test(clean(values.dest))) {
    const names = { rsp: 'current stack pointer', esp: 'current stack pointer', sp: 'current stack pointer', rbp: 'current base pointer', ebp: 'current base pointer', bp: 'current base pointer' };
    const src = clean(values.src);
    const dest = clean(values.dest);
    const source = names[src.toLowerCase()] ? `${names[src.toLowerCase()]} (${src})` : src;
    const destination = names[dest.toLowerCase()] ? `${names[dest.toLowerCase()]} (${dest})` : dest;
    return `Copies ${source} into ${destination}. No flags are affected.`;
  }
  let description = record.description;
  if (values.src) description = description.replace(/\bsource operand\b/gi, `source (${values.src})`);
  if (values.dest) description = description.replace(/\bdestination operand\b/gi, `destination (${values.dest})`);
  if (actual.length === 1) {
    const operand = clean(values.src ?? values.dest ?? actual[0]);
    if (mnemonic === 'push') {
      const stackPointer = 'rsp';
      const immediate = /^\s*\$/.test(actual[0]);
      return `Pushes ${immediate ? operand : `the value in ${operand}`} onto the stack, then decrements ${stackPointer} by 8 bytes and stores it at [${stackPointer}]. No flags are modified.`;
    }
    if (mnemonic === 'pop') {
      return `Pops the value at [rsp] into ${operand}, then increments rsp by 8 bytes. No flags are modified.`;
    }
    description = description.replace(/\bthe operand\b/gi, operand).replace(/\boperand\b/gi, operand);
  }
  return description;
}

function describeArmOperands(record, operands) {
  const actual = splitOperands(operands);
  const template = splitOperands((record.syntax ?? '').replace(/^\S+\s*/, '').replace(/\s*\{.*$/, ''));
  const values = {};
  for (let i = 0; i < Math.min(actual.length, template.length); i++) {
    const names = [...template[i].matchAll(/<([^>]+)>/g)].flatMap((m) => m[1].split('|'));
    for (const name of names) {
      const family = /^([BHWXSDQVZP])/.exec(name)?.[1];
      const match = family ? new RegExp(`\\b${family}\\d+\\b|\\bSP\\b`, 'i').exec(actual[i]) : null;
      values[name] = match?.[0] ?? actual[i];
    }
  }
  const keys = Object.keys(values).sort((a, b) => b.length - a.length);
  return keys.length
    ? record.description.replace(new RegExp(`\\b(?:${keys.join('|')})\\b`, 'g'), (name) => values[name])
    : record.description;
}

function describeS390Operands(record, operands) {
  const actual = splitOperands(operands);
  return record.description.replace(/\{(\d+)\}/g, (_, index) => actual[Number(index)] ?? `operand ${Number(index) + 1}`);
}

function scoreInstructionRecord(record, operands, arch, asmSyntax) {
  const actual = splitOperands(operands);
  const syntax = record.syntax ?? '';
  const template = syntax.slice(syntax.indexOf(' ') + 1);
  const expected = splitOperands(template);
  const optionalExpected = splitOperands(template.replace(/[{}]/g, ''));
  let score = -Math.min(
    Math.abs(actual.length - expected.length),
    Math.abs(actual.length - optionalExpected.length),
  ) * 4;
  if (arch === 'x86') {
    for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
      const form = expected[i].toLowerCase();
      const operand = actual[asmSyntax === 'att' ? actual.length - i - 1 : i].toLowerCase();
      const registerClass = /%?mm\d+\b/.test(operand) ? 'mm' : /%?xmm\d+\b/.test(operand) ? 'xmm' : /%?ymm\d+\b/.test(operand) ? 'ymm' : /%?zmm\d+\b/.test(operand) ? 'zmm' : /%?r(?:ax|bx|cx|dx|si|di|sp|bp|\d+)\b|%?e(?:ax|bx|cx|dx|si|di|sp|bp)\b/.test(operand) ? 'gpr' : null;
      if (registerClass) score += form.includes(registerClass) ? 8 : -8;
      if (/^\$/.test(operand)) score += /imm/.test(form) ? 5 : -2;
      if (/\[|\(/.test(operand)) score += /m(?:\d+)?|r\/m/.test(form) ? 2 : 0;
    }
    return score;
  }
  if (arch !== 'arm') return score;
  if (record.isa && !record.isa.includes('A64')) return -Infinity;
  const families = [
    [/[xy]\d+|\bsp\b/i, /<X/i],
    [/\bw\d+\b/i, /<W/i],
    [/\bv\d+\b/i, /<V/i],
    [/\bz\d+\b/i, /<Z/i],
    [/\bp\d+\b/i, /<P/i],
  ];
  for (let i = 0; i < actual.length; i++) {
    const operand = actual[i];
    const form = expected[i] ?? '';
    for (const [register, placeholder] of families) {
      if (!register.test(operand)) continue;
      score += placeholder.test(form) ? 5 : -4;
    }
    if (/[bhdsq]\d+/i.test(operand) && /<[BHDSQ]/.test(form)) score += 4;
    if (operand.includes('[') === form.includes('[')) score++;
    if (operand.includes('#') === form.includes('#')) score++;
  }
  return score;
}

function selectInstructionRecord(records, operands, arch, syntax) {
  if (!records) return undefined;
  const ranked = [...records].sort((a, b) =>
    scoreInstructionRecord(b, operands, arch, syntax) - scoreInstructionRecord(a, operands, arch, syntax),
  );
  return arch === 'arm' && scoreInstructionRecord(ranked[0], operands, arch, syntax) < 0 ? undefined : ranked[0];
}

function registerHelp(register, arch) {
  const name = register.toLowerCase();
  if (arch === 'riscv64') {
    const integerAliases = {
      zero: 'x0', ra: 'x1', sp: 'x2', gp: 'x3', tp: 'x4',
      t0: 'x5', t1: 'x6', t2: 'x7', s0: 'x8', fp: 'x8', s1: 'x9',
      a0: 'x10', a1: 'x11', a2: 'x12', a3: 'x13', a4: 'x14', a5: 'x15', a6: 'x16', a7: 'x17',
      s2: 'x18', s3: 'x19', s4: 'x20', s5: 'x21', s6: 'x22', s7: 'x23', s8: 'x24', s9: 'x25', s10: 'x26', s11: 'x27',
      t3: 'x28', t4: 'x29', t5: 'x30', t6: 'x31',
    };
    const integerNumber = /^x\d+$/.test(name) ? Number(name.slice(1)) : Number(integerAliases[name]?.slice(1));
    if (name === 'zero' || name === 'x0') return 'Integer register x0, also named zero. It always reads as 0; writes are discarded.';
    if (name === 'ra' || name === 'x1') return 'Integer register x1, also named ra. Holds a return address after a call; caller-saved.';
    if (name === 'sp' || name === 'x2') return 'Integer register x2, also named sp. The stack pointer; preserved across calls.';
    if (name === 'gp' || name === 'x3') return 'Integer register x3, also named gp. Global pointer; reserved by the standard ABI.';
    if (name === 'tp' || name === 'x4') return 'Integer register x4, also named tp. Thread pointer; reserved by the standard ABI.';
    if (integerNumber >= 5 && integerNumber <= 7 || integerNumber >= 28 && integerNumber <= 31) return `64-bit integer register ${name}. Temporary register; caller-saved.`;
    if (integerNumber === 8 || integerNumber === 9 || integerNumber >= 18 && integerNumber <= 27) return `64-bit integer register ${name}. Callee-saved; x8 is also the optional frame pointer (s0/fp).`;
    if (integerNumber >= 10 && integerNumber <= 17) return `64-bit integer register ${name}. Argument register ${integerNumber - 10}; a0 and a1 also carry return values.`;
    const floatAliases = { ft0: 'f0', ft1: 'f1', ft2: 'f2', ft3: 'f3', ft4: 'f4', ft5: 'f5', ft6: 'f6', ft7: 'f7', fs0: 'f8', fs1: 'f9', fa0: 'f10', fa1: 'f11', fa2: 'f12', fa3: 'f13', fa4: 'f14', fa5: 'f15', fa6: 'f16', fa7: 'f17', fs2: 'f18', fs3: 'f19', fs4: 'f20', fs5: 'f21', fs6: 'f22', fs7: 'f23', fs8: 'f24', fs9: 'f25', fs10: 'f26', fs11: 'f27', ft8: 'f28', ft9: 'f29', ft10: 'f30', ft11: 'f31' };
    const floatName = /^f\d+$/.test(name) ? name : floatAliases[name];
    if (floatName) {
      const n = Number(floatName.slice(1));
      if (n >= 10 && n <= 17) return `Floating-point register ${name}. Argument register fa${n - 10}; fa0 and fa1 can return floating-point values.`;
      if (n === 8 || n === 9 || n >= 18 && n <= 27) return `Floating-point register ${name}. Callee-saved when the ABI uses a compatible floating-point width.`;
      return `Floating-point register ${name}. Caller-saved temporary register.`;
    }
    if (/^v\d+$/.test(name)) return `Vector register ${name}. Holds vector data; the standard calling convention does not preserve vector register contents across calls.`;
    if (/^[a-z][a-z0-9_]*$/.test(name)) return `RISC-V control and status register ${register}. Its meaning is defined by the relevant ISA privilege or extension specification.`;
  }
  if (arch === 'x86_64') {
    const roles = { rsp: 'Stack pointer.', esp: 'Low 32 bits of the stack pointer.', rbp: 'Base/frame pointer register.', ebp: 'Low 32 bits of the base/frame pointer.', rip: 'Instruction pointer.', eip: 'Low 32 bits of the instruction pointer.', rax: 'Accumulator register.', eax: 'Low 32 bits of the accumulator.', rdi: 'First integer argument register in the System V ABI.', rsi: 'Second integer argument register in the System V ABI.' };
    if (roles[name]) return roles[name];
    if (/^(r|e)?(bx|cx|dx|si|di|[0-9]+)[dwb]?$/.test(name)) return 'General-purpose register.';
    if (/^(xmm|ymm|zmm|mm|k|st)\d+$/.test(name)) return 'Vector, mask, or floating-point register.';
  }
  if (arch === 'aarch64') {
    if (name === 'sp' || name === 'wsp') return `Stack pointer ${register}. SP/WSP refers to the same stack-pointer state as the general-purpose register bank.`;
    if (name === 'xzr' || name === 'wzr') return `Zero register ${register}. Reads as 0; writes are discarded.`;
    if (name === 'x29' || name === 'w29' || name === 'fp') return 'Frame pointer (x29/fp). Commonly points to the current stack frame; callee-saved. w29 is its low 32-bit view.';
    if (name === 'x30' || name === 'w30' || name === 'lr') return 'Link register (x30/lr). A call instruction saves its return address here. w30 is its low 32-bit view.';
    if (name === 'ip0' || name === 'x16') return 'Intra-procedure-call temporary register. Linkers may use it for veneers and stubs.';
    if (name === 'ip1' || name === 'x17') return 'Intra-procedure-call temporary register. Linkers may use it for veneers and stubs.';
    const gp = /^[xw](\d+)$/.exec(name);
    if (gp) {
      const n = Number(gp[1]);
      if (n <= 7) return `${name[0] === 'w' ? '32-bit w register, a view of the same state as ' + `x${n}` + '; writes clear the upper 32 bits. ' : '64-bit general-purpose register. '}${register} is used for integer arguments and results; caller-saved.`;
      if (n === 8) return `${name[0] === 'w' ? '32-bit w8 view of x8; writes clear the upper 32 bits. ' : '64-bit general-purpose register. '}Register ${register} carries an indirect result address; caller-saved.`;
      if (n === 18) return 'General-purpose register x18/w18. Platform register; its use depends on the operating system ABI.';
      if (n >= 19 && n <= 29) return `${name[0] === 'w' ? `32-bit w${n} view of x${n}; writes clear the upper 32 bits. ` : '64-bit general-purpose register. '}Register ${register} is callee-saved; x29 is conventionally the frame pointer.`;
      return `${name[0] === 'w' ? `32-bit w${n} view of x${n}; writes clear the upper 32 bits. ` : '64-bit general-purpose register. '}Register ${register} is caller-saved temporary.`;
    }
    const vector = /^([vbsdqhz])(\d+)$/.exec(name);
    if (vector) {
      const [, kind, number] = vector;
      const n = Number(number);
      const view = { v: 'SIMD/floating-point', b: '8-bit SIMD/floating-point', h: '16-bit SIMD/floating-point', s: '32-bit SIMD/floating-point', d: '64-bit SIMD/floating-point', q: '128-bit SIMD/floating-point', z: 'scalable vector' }[kind];
      if (kind === 'z') return `Scalable vector register ${register}. z registers overlap the corresponding v registers and hold vectors whose size depends on the active SVE vector length.`;
      if (n <= 7) return `${view} register ${register}. The b/h/s/d/q/v names are views of the same SIMD register. Used for floating-point/vector arguments and results; caller-saved.`;
      if (n <= 15) return `${view} register ${register}. The b/h/s/d/q/v names are views of the same SIMD register. Callee-saved for its low 64 bits; wider values are caller-saved.`;
      return `${view} register ${register}. The b/h/s/d/q/v names are views of the same SIMD register; caller-saved.`;
    }
    if (/^p\d+$/.test(name)) {
      const n = Number(name.slice(1));
      return `Scalable vector predicate register ${register}. Controls which vector lanes participate in SVE operations.${n <= 3 ? ' p0-p3 can carry predicate arguments and results.' : ' Preservation across calls depends on whether the function uses scalable vector arguments.'}`;
    }
    if (name === 'nzcv') return 'Condition flags register: N (negative), Z (zero), C (carry), and V (overflow).';
    if (name === 'fpcr') return 'Floating-point control register. Controls floating-point behavior such as rounding and exception handling.';
    if (name === 'fpsr') return 'Floating-point status register. Holds cumulative floating-point exception status.';
    if (name === 'ffr') return 'First-fault register used by SVE first-fault load operations.';
  }
  if (arch === 's390x') {
    const gpr = /^r(\d+)$/.exec(name);
    if (gpr) {
      const n = Number(gpr[1]);
      if (n === 15) return 'General-purpose register r15. Stack pointer; preserved across calls. The stack grows toward lower addresses.';
      if (n === 14) return 'General-purpose register r14. Holds the return address; caller-saved.';
      if (n === 12) return 'General-purpose register r12. Commonly holds the global offset table (GOT) pointer in position-independent code; callee-saved.';
      if (n === 13) return 'General-purpose register r13. Commonly used as a literal-pool pointer; callee-saved.';
      if (n === 2) return 'General-purpose register r2. First integer argument and integer return value; caller-saved.';
      if (n >= 3 && n <= 5) return `General-purpose register r${n}. Integer argument ${n - 1}; caller-saved.`;
      if (n === 6) return 'General-purpose register r6. Fifth integer argument register; callee-saved.';
      if (n >= 7 && n <= 11) return `General-purpose register r${n}. Local-variable register; callee-saved.`;
      if (n <= 1) return `General-purpose register r${n}. Volatile scratch register; interface code may alter it.`;
      return `General-purpose register r${n}.`;
    }
    const fpr = /^f(\d+)$/.exec(name);
    if (fpr) {
      const n = Number(fpr[1]);
      if ([0, 2, 4, 6].includes(n)) return `Floating-point register f${n}. Used for floating-point arguments and return values; caller-saved.`;
      if (n >= 8) return `Floating-point register f${n}. Callee-saved.`;
      return `Floating-point register f${n}. Volatile floating-point register.`;
    }
    if (/^v\d+$/.test(name)) return `Vector register ${register}. Holds packed vector data.`;
    if (/^a\d+$/.test(name)) return `Access register ${register}. Controls address-space access for storage references.`;
    if (/^c\d+$/.test(name)) return `Control register ${register}. Controls processor state and system facilities.`;
    if (name === 'pswm' || name === 'pswa') return 'Program status word field. Holds processor control state and the instruction address.';
    if (name === 'psw') return 'Program status word. Holds the current instruction address and processor state, including condition code and execution mode.';
  }
  return `${arch} register.`;
}

function operandTokenHelp(token, operands, arch) {
  const normalized = token.replace(/^%/, '').toLowerCase();
  const register = operands.flatMap((operand) => operand.kind === 'register' ? [operand.name] : operand.kind === 'memory' ? [operand.base, operand.index].filter(Boolean) : []).find((name) => name.toLowerCase() === normalized);
  if (register) return registerHelp(register, arch);
  const numeric = token.replace(/^[#$]/, '');
  if (/^[+-]?(?:0x[\da-f]+|\d+)$/i.test(numeric)) {
    const value = /^[+-]?0x/i.test(numeric) ? (numeric[0] === '-' ? -1 : 1) * Number.parseInt(numeric.replace(/^[+-]?0x/i, ''), 16) : Number(numeric);
    const immediate = operands.find((operand) => operand.kind === 'immediate' && Number(operand.value) === value);
    if (immediate) return `Immediate value ${value} (${value < 0 ? '-0x' + (-value).toString(16) : '0x' + value.toString(16)}).`;
    const displacement = operands.find((operand) => operand.kind === 'memory' && Number(operand.displacement) === value);
    if (displacement) return `Memory address displacement ${value}.`;
  }
  return null;
}

function highlightedInstruction(text, operands, arch) {
  const names = operands.flatMap((operand) => operand.kind === 'register' ? [operand.name] : operand.kind === 'memory' ? [operand.base, operand.index].filter(Boolean) : []);
  const alternatives = names.sort((a, b) => b.length - a.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const pattern = alternatives ? new RegExp(`(?<![a-zA-Z0-9_])%?(?:${alternatives})(?![a-zA-Z0-9_])|(?<![a-zA-Z0-9_])(?:[$#])?[+-]?(?:0x[\\da-fA-F]+|\\d+)(?![a-zA-Z0-9_])`, 'gi') : /(?<![a-zA-Z0-9_])(?:[$#])?[+-]?(?:0x[\da-fA-F]+|\d+)(?![a-zA-Z0-9_])/g;
  const children = [];
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const token = match[0];
    const title = operandTokenHelp(token, operands, arch);
    if (!title) continue;
    if (start > offset) children.push(text.slice(offset, start));
    children.push(h('span', { class: 'operand-help', title }, token));
    offset = start + token.length;
  }
  if (!children.length) return text;
  if (offset < text.length) children.push(text.slice(offset));
  return children;
}

function instructionCell(text, decoded, typedOperands = [], trap = null) {
  const split = text.indexOf(' ');
  if (!decoded) {
    const title = trap && state.arch === 's390x'
      ? `Cranelift trap (${trap}). Capstone leaves this invalid encoding undecoded; executing it raises an operation exception.`
      : trap
        ? `Trap instruction (${trap}). Capstone does not decode this encoding; executing it raises an architecture exception.`
        : undefined;
    return h('td', { class: 'insn', title }, text);
  }
  const mnemonicEnd = split < 0 ? text.length : split;
  const mnemonic = text.slice(0, mnemonicEnd).toLowerCase();
  const operands = split < 0 ? '' : text.slice(split).trim();
  const riscvHelp = state.arch === 'riscv64' ? riscvInstructionHelp[mnemonic] : null;
  const isaDbArch = state.arch === 'x86_64' ? 'x86' : state.arch === 'aarch64' ? 'arm' : state.arch === 's390x' ? 's390x' : null;
  const isaDb = isaDbArch === 'x86' ? x86InstructionHelp.instructions : isaDbArch === 'arm' ? armInstructionHelp.instructions : isaDbArch === 's390x' ? s390xInstructionHelp.instructions : null;
  const attGeneralRegisterMove = isaDbArch === 'x86' && state.syntax === 'att' && /^mov[bwlq]$/.test(mnemonic)
    && typedOperands.length > 0 && typedOperands.every((operand) => operand.kind === 'register' && /^(?:r|e)?(?:ax|bx|cx|dx|si|di|sp|bp|[0-9]+)[dwb]?$/i.test(operand.name));
  const x86BaseMnemonic = attGeneralRegisterMove
    ? 'mov'
    : isaDbArch === 'x86' && state.syntax === 'att' && !isaDb?.[mnemonic]
      ? mnemonic.replace(/[bwlq]$/, (suffix) => isaDb?.[mnemonic.slice(0, -1)] ? '' : suffix)
      : mnemonic;
  const instructionRecord = selectInstructionRecord(isaDb?.[x86BaseMnemonic], operands, isaDbArch, state.syntax);
  const help = riscvHelp
    ? `${riscvHelp.long_name}. ${describeRiscvOperands(riscvHelp.description, riscvHelp.assembly, operands)}${riscvHelp.extensions.length ? ` (RISC-V ${riscvHelp.extensions.join(' or ')} extension.)` : ''}`
    : instructionRecord
      ? isaDbArch === 'x86'
        ? `${instructionRecord.name}. ${describeX86Operands(instructionRecord, operands, state.syntax)}`
        : isaDbArch === 'arm'
          ? `${instructionRecord.name}. ${describeArmOperands(instructionRecord, operands)}`
          : describeS390Operands(instructionRecord, operands)
      : instructionHelp[mnemonic] ?? `Decoded instruction “${mnemonic}” with operands ${operands}. No detailed description is available yet.`;
  const operandNodes = split < 0 ? [] : highlightedInstruction(text.slice(split), typedOperands, state.arch);
  return h('td', { class: 'insn', title: help }, h('span', { class: 'mn' }, text.slice(0, mnemonicEnd)), ...operandNodes);
}

function listingRow(line) {
  const note = line.note ?? (line.trap ? `; trap: ${line.trap}` : '');
  return h('tr', { class: `${line.decoded ? '' : 'raw'}${line.trap ? ' trap' : ''}`.trim() },
    h('td', { class: 'off' }, line.offset.toString(16).padStart(4, '0')),
    h('td', { class: 'bytes' }, Array.from(line.bytes, (b) => b.toString(16).padStart(2, '0')).join(' ')),
    instructionCell(line.text, line.decoded, line.operands, line.trap),
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
    const request = { arch: state.arch, clif: editor.getValue(), flags: flagArguments(), disasmFlags: disassemblerFlags() };
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
