#include <capstone/capstone.h>
#include <emscripten.h>
#include <stdio.h>
#include <stdint.h>
#include <inttypes.h>

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
  if (cs_option(handle, CS_OPT_DETAIL, CS_OPT_ON) != CS_ERR_OK) {
    cs_close(&handle);
    return 0;
  }
  return (int)handle;
}

EMSCRIPTEN_KEEPALIVE void dis_close(int handle) {
  csh h = (csh)handle;
  cs_close(&h);
}

static void append_operand(char *out, int capacity, int *used, const char *kind, const char *name, int64_t value, int size, int access) {
  if (*used >= capacity) return;
  int n;
  if (name) n = snprintf(out + *used, capacity - *used, "%s{\"kind\":\"%s\",\"name\":\"%s\",\"size\":%d,\"access\":%d}", *used > 1 ? "," : "", kind, name, size, access);
  else n = snprintf(out + *used, capacity - *used, "%s{\"kind\":\"%s\",\"value\":\"%" PRId64 "\",\"size\":%d,\"access\":%d}", *used > 1 ? "," : "", kind, value, size, access);
  if (n > 0) *used += n < capacity - *used ? n : capacity - *used;
}

static void append_memory(char *out, int capacity, int *used, csh handle, unsigned int base, unsigned int index, int scale, int64_t disp, int size, int access) {
  if (*used >= capacity) return;
  const char *base_name = base ? cs_reg_name(handle, base) : "";
  const char *index_name = index ? cs_reg_name(handle, index) : "";
  int n = snprintf(out + *used, capacity - *used,
    "%s{\"kind\":\"memory\",\"base\":\"%s\",\"index\":\"%s\",\"scale\":%d,\"displacement\":\"%" PRId64 "\",\"size\":%d,\"access\":%d}",
    *used > 1 ? "," : "", base_name ? base_name : "", index_name ? index_name : "", scale, disp, size, access);
  if (n > 0) *used += n < capacity - *used ? n : capacity - *used;
}

static void append_details(csh handle, int target, const cs_insn *insn, char *out, int capacity) {
  int used = snprintf(out, capacity, "[");
  if (!insn->detail) { snprintf(out, capacity, "[]"); return; }
  if (target == 0) {
    cs_x86 *x = (cs_x86 *)&insn->detail->x86;
    for (int i = 0; i < x->op_count; i++) {
      cs_x86_op *op = &x->operands[i];
      if (op->type == X86_OP_REG) append_operand(out, capacity, &used, "register", cs_reg_name(handle, op->reg), 0, op->size, op->access);
      else if (op->type == X86_OP_IMM) append_operand(out, capacity, &used, "immediate", NULL, op->imm, op->size, op->access);
      else if (op->type == X86_OP_MEM) append_memory(out, capacity, &used, handle, op->mem.base, op->mem.index, op->mem.scale, op->mem.disp, op->size, op->access);
    }
  } else if (target == 1) {
    cs_aarch64 *a = (cs_aarch64 *)&insn->detail->aarch64;
    for (int i = 0; i < a->op_count; i++) {
      cs_aarch64_op *op = &a->operands[i];
      if (op->type == AARCH64_OP_REG || op->type == AARCH64_OP_REG_MRS || op->type == AARCH64_OP_REG_MSR) append_operand(out, capacity, &used, "register", cs_reg_name(handle, op->reg), 0, 0, op->access);
      else if (op->type == AARCH64_OP_IMM || op->type == AARCH64_OP_CIMM || op->type == AARCH64_OP_SYSIMM) append_operand(out, capacity, &used, "immediate", NULL, op->imm, 0, op->access);
      else if (op->type == AARCH64_OP_MEM || op->type == AARCH64_OP_MEM_IMM || op->type == AARCH64_OP_MEM_REG) append_memory(out, capacity, &used, handle, op->mem.base, op->mem.index, 1, op->mem.disp, 0, op->access);
      else append_operand(out, capacity, &used, "special", NULL, op->type, 0, op->access);
    }
  } else if (target == 2) {
    cs_riscv *r = (cs_riscv *)&insn->detail->riscv;
    for (int i = 0; i < r->op_count; i++) {
      cs_riscv_op *op = &r->operands[i];
      if (op->type == RISCV_OP_REG) append_operand(out, capacity, &used, "register", cs_reg_name(handle, op->reg), 0, 0, op->access);
      else if (op->type == RISCV_OP_IMM) append_operand(out, capacity, &used, "immediate", NULL, op->imm, 0, op->access);
      else if (op->type == RISCV_OP_MEM) append_memory(out, capacity, &used, handle, op->mem.base, 0, 1, op->mem.disp, 0, op->access);
      else if (op->type == RISCV_OP_CSR) append_operand(out, capacity, &used, "register", cs_reg_name(handle, op->csr), 0, 0, op->access);
    }
  } else {
    cs_systemz *z = (cs_systemz *)&insn->detail->systemz;
    for (int i = 0; i < z->op_count; i++) {
      cs_systemz_op *op = &z->operands[i];
      if (op->type == SYSTEMZ_OP_REG) append_operand(out, capacity, &used, "register", cs_reg_name(handle, op->reg), 0, 0, op->access);
      else if (op->type == SYSTEMZ_OP_IMM) append_operand(out, capacity, &used, "immediate", NULL, op->imm, 0, op->access);
      else if (op->type == SYSTEMZ_OP_MEM) append_memory(out, capacity, &used, handle, op->mem.base, op->mem.index, 1, op->mem.disp, 0, op->access);
    }
  }
  if (used < capacity) snprintf(out + used, capacity - used, "]");
}

EMSCRIPTEN_KEEPALIVE int dis_one(int handle, int target, const uint8_t *code, int length, uint32_t address, char *text, int capacity, char *details, int details_capacity) {
  cs_insn *insn = cs_malloc((csh)handle);
  const uint8_t *cursor = code;
  size_t left = length;
  uint64_t at = address;
  int size = 0;
  if (insn && cs_disasm_iter((csh)handle, &cursor, &left, &at, insn)) {
    size = insn->size;
    snprintf(text, capacity, "%s %s", insn->mnemonic, insn->op_str);
    append_details((csh)handle, target, insn, details, details_capacity);
  }
  if (insn) cs_free(insn, 1);
  return size;
}
