#include <capstone/capstone.h>
#include <emscripten.h>
#include <stdio.h>
#include <stdint.h>

static const struct { cs_arch arch; cs_mode mode; } TARGETS[] = {
  { CS_ARCH_X86, CS_MODE_64 },
  { CS_ARCH_AARCH64, CS_MODE_ARM },
  { CS_ARCH_RISCV, CS_MODE_RISCV64 },
  { CS_ARCH_SYSTEMZ, CS_MODE_BIG_ENDIAN },
};

EMSCRIPTEN_KEEPALIVE int dis_open(int target, int option) {
  csh handle;
  if (target < 0 || target > 3) return 0;
  cs_mode mode = TARGETS[target].mode;
  if (target == 2) mode |= (cs_mode)option;
  if (cs_open(TARGETS[target].arch, mode, &handle) != CS_ERR_OK) return 0;
  if (target == 0 && cs_option(handle, CS_OPT_SYNTAX, option ? CS_OPT_SYNTAX_ATT : CS_OPT_SYNTAX_INTEL) != CS_ERR_OK) {
    cs_close(&handle);
    return 0;
  }
  return (int)handle;
}

EMSCRIPTEN_KEEPALIVE void dis_close(int handle) {
  csh h = (csh)handle;
  cs_close(&h);
}

EMSCRIPTEN_KEEPALIVE int dis_one(int handle, const uint8_t *code, int length, uint32_t address, char *text, int capacity) {
  cs_insn *insn = cs_malloc((csh)handle);
  const uint8_t *cursor = code;
  size_t left = length;
  uint64_t at = address;
  int size = 0;
  if (insn && cs_disasm_iter((csh)handle, &cursor, &left, &at, insn)) {
    size = insn->size;
    snprintf(text, capacity, "%s %s", insn->mnemonic, insn->op_str);
  }
  if (insn) cs_free(insn, 1);
  return size;
}
