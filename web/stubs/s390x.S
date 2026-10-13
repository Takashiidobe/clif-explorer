.equ STACK_TOP, 0x800000
.equ SCCB, 0x20000
.equ SCLP_WRITE_EVENT_DATA, 0x00760005

.text
.globl _start
_start:
  larl %r1, trap
  stg %r1, 0x1d8
  llihf %r2, 1
  oilh %r2, 0x8000
  stg %r2, 0x1d0

  llilf %r15, STACK_TOP - 160
  stctg %c0, %c0, 0(%r15)
  oi 5(%r15), 0x06
  lctlg %c0, %c0, 0(%r15)

  larl %r9, args
  lg %r1, 0(%r9)
  lg %r2, 8(%r9)
  lg %r3, 16(%r9)
  larl %r14, done
  br %r1

done:
  lgr %r10, %r2
  lg %r13, 0(%r10)
  aghi %r10, 64
  llilf %r2, SCCB
  lgr %r3, %r13
  aghi %r3, 23
  sth %r3, 0(%r2)
  aghi %r3, -8
  sth %r3, 8(%r2)
  mvi 10(%r2), 0x1a
  mvi 14(%r2), 'R'
  lgr %r12, %r13
  .set off, 15
  .rept 8
  stc %r12, off(%r2)
  srlg %r12, %r12, 8
  .set off, off + 1
  .endr
  la %r3, 23(%r2)
  ltgr %r13, %r13
  jz send
.Lresult_bytes:
  llgc %r0, 0(%r10)
  stc %r0, 0(%r3)
  aghi %r10, 1
  aghi %r3, 1
  brctg %r13, .Lresult_bytes
  j send

trap:
  lg %r12, 0x158
  llgf %r13, 0x8c
  lghi %r11, 'T'

report:
  llilf %r2, SCCB
  mvhhi 0(%r2), 31
  mvhhi 8(%r2), 23
  mvi 10(%r2), 0x1a
  stc %r11, 14(%r2)
  .set off, 15
  .rept 8
  stc %r12, off(%r2)
  srlg %r12, %r12, 8
  .set off, off + 1
  .endr
  .rept 8
  stc %r13, off(%r2)
  srlg %r13, %r13, 8
  .set off, off + 1
  .endr
send:
  llilf %r1, SCLP_WRITE_EVENT_DATA
  .insn rre, 0xb2200000, %r1, %r2
1: j 1b

.org 0x200
args:
