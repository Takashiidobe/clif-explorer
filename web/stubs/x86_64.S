.equ ROM, 0xffff0000
.equ ARGS, 0x100000
.equ STACK_TOP, 0x800000
.equ PML4, 0x2000
.equ PDPT, 0x3000
.equ PD_LOW, 0x4000
.equ PD_HIGH, 0x5000
.equ IDT, 0x6000

base:
.code32
prot32:
  movw $0x10, %ax
  movw %ax, %ds
  movw %ax, %es
  movw %ax, %ss

  xorl %eax, %eax
  movl $PML4, %edi
  movl $(0x6000 / 4), %ecx
  rep stosl

  movl $(PDPT | 3), PML4
  movl $(PD_LOW | 3), PDPT
  movl $(PD_HIGH | 3), PDPT + 24

  movl $PD_LOW, %edi
  movl $0x83, %eax
  movl $512, %ecx
1:
  movl %eax, (%edi)
  addl $0x200000, %eax
  addl $8, %edi
  loop 1b

  movl $PD_HIGH, %edi
  movl $0xc0000083, %eax
  movl $512, %ecx
2:
  movl %eax, (%edi)
  addl $0x200000, %eax
  addl $8, %edi
  loop 2b

  movl $PML4, %eax
  movl %eax, %cr3
  movl %cr4, %eax
  orl $0x40620, %eax
  movl %eax, %cr4
  movl $0xc0000080, %ecx
  rdmsr
  orl $0x100, %eax
  wrmsr
  movl %cr0, %eax
  andl $0xfffffffb, %eax
  orl $0x80000002, %eax
  movl %eax, %cr0
  ljmpl $0x18, $(ROM + (long64 - base))

.code64
long64:
  xorl %ecx, %ecx
  movl $0xd, %eax
  cpuid
  andl $0xe7, %eax
  xorl %ecx, %ecx
  xorl %edx, %edx
  xsetbv
  movw $0x10, %ax
  movw %ax, %ds
  movw %ax, %es
  movw %ax, %ss
  movq $STACK_TOP, %rsp

  movq $IDT, %rdi
  movl $(ROM + (vec_stubs - base)), %esi
  movl $32, %ecx
3:
  movq %rsi, %rax
  movw %ax, (%rdi)
  movw $0x18, 2(%rdi)
  movw $0x8e00, 4(%rdi)
  shrq $16, %rax
  movw %ax, 6(%rdi)
  shrq $16, %rax
  movl %eax, 8(%rdi)
  movl $0, 12(%rdi)
  addq $16, %rdi
  addq $16, %rsi
  loop 3b
  movl $(ROM + (idt_desc - base)), %eax
  lidt (%rax)

  movq $ARGS, %rbx
  movq 0(%rbx), %rax
  movq 8(%rbx), %rdi
  movq 16(%rbx), %rsi
  leaq done(%rip), %r10
  pushq %r10
  jmpq *%rax

done:
  movq %rax, %r12
  movq (%r12), %r13
  addq $64, %r12
  movw $0x3f8, %dx
  movb $'R', %al
  outb %al, %dx
  movq %r13, %rax
  call put64
  movq %r13, %rcx
  jrcxz 4f
.Lresult_bytes:
  movb (%r12), %al
  outb %al, %dx
  incq %r12
  loop .Lresult_bytes
  jmp 4f

trap:
  movq 16(%rsp), %r12
  movq 0(%rsp), %r13
  movb $'T', %al

report:
  movw $0x3f8, %dx
  outb %al, %dx
  movq %r12, %rax
  call put64
  movq %r13, %rax
  call put64
4:
  hlt
  jmp 4b

put64:
  movl $8, %ecx
5:
  outb %al, %dx
  shrq $8, %rax
  loop 5b
  ret

.balign 16
vec_stubs:
.macro vec n, errcode
  .balign 16
  .if \errcode == 0
  pushq $0
  .endif
  pushq $\n
  jmp trap
.endm
.altmacro
.irp n, 0,1,2,3,4,5,6,7
  vec \n, 0
.endr
vec 8, 1
vec 9, 0
vec 10, 1
vec 11, 1
vec 12, 1
vec 13, 1
vec 14, 1
vec 15, 0
vec 16, 0
vec 17, 1
vec 18, 0
vec 19, 0
vec 20, 0
vec 21, 1
vec 22, 0
vec 23, 0
vec 24, 0
vec 25, 0
vec 26, 0
vec 27, 0
vec 28, 0
vec 29, 1
vec 30, 1
vec 31, 0

.balign 8
gdt:
  .quad 0
  .quad 0x00cf9a000000ffff
  .quad 0x00cf92000000ffff
  .quad 0x00af9a000000ffff
gdt_desc:
  .word gdt_desc - gdt - 1
  .long ROM + (gdt - base)
idt_desc:
  .word 32 * 16 - 1
  .quad IDT

.org 0xff80
.code16
start16:
  cli
  cld
  lgdtl %cs:(gdt_desc - base)
  movl %cr0, %eax
  orl $1, %eax
  movl %eax, %cr0
  ljmpl $0x08, $(ROM + (prot32 - base))


.org 0xfff0
  .code16
  jmp start16
.balign 16
