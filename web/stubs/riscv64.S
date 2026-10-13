.equ UART, 0x10000000
.equ STACK_TOP, 0x80800000
.equ ARGS, 0x80000100

.globl _start
_start:
  la t0, trap
  csrw mtvec, t0
  li t0, 0x6600
  csrs mstatus, t0
  li sp, STACK_TOP
  li t6, ARGS
  ld t5, 0(t6)
  ld a0, 8(t6)
  ld a1, 16(t6)
  la ra, done
  jr t5

done:
  mv s1, a0
  ld s2, 0(s1)
  addi s1, s1, 64
  li s0, UART
  li a0, 'R'
  sb a0, 0(s0)
  mv a0, s2
  call put64
  beqz s2, 1f
.Lresult_bytes:
  lbu a0, 0(s1)
  sb a0, 0(s0)
  addi s1, s1, 1
  addi s2, s2, -1
  bnez s2, .Lresult_bytes
  j 1f

trap:
  csrr s1, mepc
  csrr s2, mcause
  li a0, 'T'

report:
  li s0, UART
  sb a0, 0(s0)
  mv a0, s1
  call put64
  mv a0, s2
  call put64
1: j 1b

put64:
  li t0, 8
2:
  sb a0, 0(s0)
  srli a0, a0, 8
  addi t0, t0, -1
  bnez t0, 2b
  ret
