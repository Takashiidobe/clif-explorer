CodeMirror.defineSimpleMode('clif', {
  start: [
    { regex: /;.*/, token: 'comment' },
    { regex: /\b(?:function|jump|brif|br_table|return|return_call|return_call_indirect|call|call_indirect|trap|trapz|trapnz)\b/, token: 'keyword' },
    { regex: /\b(?:ss|sig|fn|gv|const|dt|jt)\d+\b/, token: 'variable-3' },
    { regex: /\b(?:system_v|fast|cold|tail|windows_fastcall|apple_aarch64|probestack|winch|preserve_all)\b/, token: 'atom' },
    { regex: /(\bv\d+)(\s*=\s*)([a-z_][a-z0-9_]*(?:\.[a-z0-9]+)?)/, token: ['variable-2', null, 'keyword'] },
    { regex: /\bv\d+\b/, token: 'variable-2' },
    { regex: /\bblock\d+\b/, token: 'def' },
    { regex: /%[A-Za-z0-9_]+|\bu\d+:\d+\b/, token: 'string-2' },
    { regex: /\b[if]\d+(?:x\d+)?\b/, token: 'type' },
    { regex: /[-+]?0x[0-9a-fA-F_]+|[-+]?\d+(?:\.\d+)?/, token: 'number' },
  ],
  meta: { lineComment: ';' },
});
