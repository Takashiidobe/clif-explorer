.equ UART, 0x09000000
.equ STACK_TOP, 0x40800000
.equ ARGS, 0x40080100

.globl _start
_start:
  adr x0, vectors
  msr vbar_el1, x0
  mov x0, #(3 << 20)
  msr cpacr_el1, x0
  isb
  mov x0, #STACK_TOP
  mov sp, x0
  ldr x9, =ARGS
  ldr x16, [x9]
  ldp x0, x1, [x9, #8]
  adr x30, done
  br x16

done:
  mov x19, x0
  ldr x20, [x19]
  add x19, x19, #64
  mov x21, #UART
  mov w0, #'R'
  strb w0, [x21]
  mov x0, x20
  bl put64
  cbz x20, 1f
.Lresult_bytes:
  ldrb w0, [x19], #1
  strb w0, [x21]
  subs x20, x20, #1
  b.ne .Lresult_bytes
  b 1f

trap:
  mrs x19, elr_el1
  mrs x20, esr_el1
  mov w0, #'T'

report:
  mov x21, #UART
  strb w0, [x21]
  mov x0, x19
  bl put64
  mov x0, x20
  bl put64
1: b 1b

put64:
  mov w1, #8
2:
  strb w0, [x21]
  lsr x0, x0, #8
  subs w1, w1, #1
  b.ne 2b
  ret

.balign 2048
vectors:
  .rept 4
  .balign 128
  b trap
  .endr
  .balign 128
  b trap
