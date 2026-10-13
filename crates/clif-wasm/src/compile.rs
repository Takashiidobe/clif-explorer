use std::collections::HashMap;
use std::str::FromStr;

use cranelift_codegen::Context;
use cranelift_codegen::control::ControlPlane;
use cranelift_codegen::isa::{self, CallConv, OwnedTargetIsa};
use cranelift_codegen::settings::{self, Configurable, SetError, SettingKind};
use cranelift_reader::{ParseOptions, parse_test};
use serde::Serialize;
use target_lexicon::{Architecture, Triple};

#[derive(Serialize)]
pub struct CompileOutput {
    pub functions: Vec<FunctionOutput>,
    pub errors: Vec<String>,
}

#[derive(Serialize)]
pub struct FunctionOutput {
    pub name: String,
    pub params: Vec<String>,
    pub returns: Vec<String>,
    pub call_conv: String,
    pub signature: String,
    #[serde(with = "serde_bytes")]
    pub code: Vec<u8>,
    pub vcode: Option<String>,
    pub relocs: Vec<RelocOutput>,
    pub traps: Vec<TrapOutput>,
}

#[derive(Serialize)]
pub struct RelocOutput {
    pub offset: u32,
    pub kind: String,
    pub target: String,
    pub addend: i64,
}

#[derive(Serialize)]
pub struct TrapOutput {
    pub offset: u32,
    pub code: String,
}

#[derive(Serialize)]
pub struct FlagInfo {
    pub name: String,
    pub description: String,
    pub kind: &'static str,
    pub values: Vec<String>,
    pub default: Option<String>,
    pub shared: bool,
}

fn kind_name(kind: SettingKind) -> &'static str {
    match kind {
        SettingKind::Enum => "enum",
        SettingKind::Num => "num",
        SettingKind::Bool => "bool",
        SettingKind::Preset => "preset",
    }
}

fn parse_triple(triple: &str) -> Result<Triple, String> {
    Triple::from_str(triple).map_err(|e| format!("invalid triple {triple:?}: {e}"))
}

fn apply_flag(
    shared: &mut settings::Builder,
    isa: &mut isa::Builder,
    flag: &str,
) -> Result<(), String> {
    let flag = flag.trim();
    let (name, value) = match flag.split_once('=') {
        Some((n, v)) => (n.trim(), Some(v.trim())),
        None => (flag, None),
    };
    let set = |b: &mut dyn Configurable| match value {
        Some(v) => b.set(name, v),
        None => b.enable(name),
    };
    match set(shared) {
        Err(SetError::BadName(_)) => {}
        other => return other.map_err(|e| format!("flag {flag:?}: {e}")),
    }
    set(isa).map_err(|e| format!("flag {flag:?}: {e}"))
}

fn build_isa(triple: &Triple, flags: &[String]) -> Result<OwnedTargetIsa, String> {
    let mut shared = settings::builder();
    for flag in ["enable_llvm_abi_extensions", "enable_multi_ret_implicit_sret"] {
        shared.enable(flag).map_err(|e| e.to_string())?;
    }
    let mut isa_builder =
        isa::lookup(triple.clone()).map_err(|e| format!("unsupported target {triple}: {e}"))?;
    if matches!(triple.architecture, Architecture::Riscv64(_)) {
        isa_builder.enable("has_v").map_err(|e| e.to_string())?;
    }
    for flag in flags.iter().filter(|f| !f.trim().is_empty()) {
        apply_flag(&mut shared, &mut isa_builder, flag)?;
    }
    isa_builder
        .finish(settings::Flags::new(shared))
        .map_err(|e| format!("{e}"))
}

pub fn compile(clif: &str, triple: &str, flags: &[String]) -> CompileOutput {
    match try_compile(clif, triple, flags) {
        Ok(functions) => CompileOutput { functions, errors: vec![] },
        Err(errors) => CompileOutput { functions: vec![], errors },
    }
}

fn try_compile(
    clif: &str,
    triple: &str,
    flags: &[String],
) -> Result<Vec<FunctionOutput>, Vec<String>> {
    let triple = parse_triple(triple).map_err(|e| vec![e])?;
    let isa = build_isa(&triple, flags).map_err(|e| vec![e])?;
    let options = ParseOptions {
        default_calling_convention: CallConv::triple_default(&triple),
        ..ParseOptions::default()
    };
    let file = parse_test(clif, options).map_err(|e| vec![e.to_string()])?;

    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (func, _) in file.functions {
        let name = func.name.to_string();
        if triple.architecture == Architecture::X86_64
            && !isa.flags().enable_llvm_abi_extensions()
            && func.signature.call_conv != CallConv::Tail
            && func.signature.params.iter().chain(&func.signature.returns)
                .any(|p| p.value_type == cranelift_codegen::ir::types::I128)
        {
            errors.push(format!("{name}: i128 signatures on x86-64 require enable_llvm_abi_extensions=true"));
            continue;
        }
        if matches!(triple.architecture, Architecture::Riscv64(_))
            && isa.isa_flags().iter().any(|flag| flag.name == "has_v" && flag.value_string() == "false")
            && func.dfg.values().any(|value| func.dfg.value_type(value).is_vector())
        {
            errors.push(format!("{name}: vector operations on riscv64 require has_v=true"));
            continue;
        }
        let params = func.signature.params.iter().map(|p| p.value_type.to_string()).collect();
        let returns = func.signature.returns.iter().map(|p| p.value_type.to_string()).collect();
        let call_conv = func.signature.call_conv.to_string();
        let signature = func.signature.to_string();
        let mut ctx = Context::for_function(func);
        ctx.set_disasm(true);
        match ctx.compile(&*isa, &mut ControlPlane::default()) {
            Ok(code) => out.push(FunctionOutput {
                name,
                params,
                returns,
                call_conv,
                signature,
                code: code.buffer.data().to_vec(),
                vcode: code.vcode.clone(),
                relocs: code
                    .buffer
                    .relocs()
                    .iter()
                    .map(|r| RelocOutput {
                        offset: r.offset,
                        kind: r.kind.to_string(),
                        target: r.target.display(None),
                        addend: r.addend,
                    })
                    .collect(),
                traps: code
                    .buffer
                    .traps()
                    .iter()
                    .map(|t| TrapOutput { offset: t.offset, code: t.code.to_string() })
                    .collect(),
            }),
            Err(e) => errors.push(format!(
                "{name}: {}",
                cranelift_codegen::print_errors::pretty_error(e.func, e.inner)
            )),
        }
    }
    if errors.is_empty() { Ok(out) } else { Err(errors) }
}

pub fn flag_schema(triple: &str) -> Result<Vec<FlagInfo>, String> {
    let triple = parse_triple(triple)?;
    let shared = settings::builder();
    let isa_builder =
        isa::lookup(triple.clone()).map_err(|e| format!("unsupported target {triple}: {e}"))?;
    let default_isa = build_isa(&triple, &[])?;
    let defaults: HashMap<&str, String> = default_isa
        .flags()
        .iter()
        .chain(default_isa.isa_flags())
        .map(|v| (v.name, v.value_string()))
        .collect();
    let info = |s: settings::Setting, shared: bool| FlagInfo {
        name: s.name.to_string(),
        description: s.description.to_string(),
        kind: kind_name(s.kind),
        values: s.values.unwrap_or(&[]).iter().map(|v| v.to_string()).collect(),
        default: defaults.get(s.name).cloned(),
        shared,
    };
    Ok(shared
        .iter()
        .map(|s| info(s, true))
        .chain(isa_builder.iter().map(|s| info(s, false)))
        .collect())
}

pub const TRIPLES: [&str; 4] = [
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
    "riscv64gc-unknown-linux-gnu",
    "s390x-unknown-linux-gnu",
];

#[cfg(test)]
mod tests {
    use super::*;

    const ADD: &str = "function %add(i64, i64) -> i64 {\nblock0(v0: i64, v1: i64):\n    v2 = iadd v0, v1\n    return v2\n}\n";

    #[test]
    fn compiles_on_all_targets() {
        for triple in TRIPLES {
            let out = compile(ADD, triple, &[]);
            assert!(out.errors.is_empty(), "{triple}: {:?}", out.errors);
            assert_eq!(out.functions.len(), 1);
            assert!(!out.functions[0].code.is_empty(), "{triple}");
            assert!(out.functions[0].vcode.is_some());
            assert_eq!(out.functions[0].params, ["i64", "i64"]);
            assert_eq!(out.functions[0].returns, ["i64"]);
        }
    }

    #[test]
    fn call_relocs_are_ones_the_runner_applies() {
        const SUPPORTED: [&str; 7] =
            ["CallPCRel4", "PCRel4", "Abs8", "Call", "RiscvCallPlt", "PLTRel32Dbl", "PCRel32Dbl"];
        let calls = include_str!("../../../web/frontend/examples/calls.clif");
        for triple in TRIPLES {
            let out = compile(calls, triple, &["unwind_info=false".to_string()]);
            assert!(out.errors.is_empty(), "{triple}: {:?}", out.errors);
            for reloc in out.functions.iter().flat_map(|f| &f.relocs) {
                assert!(SUPPORTED.contains(&reloc.kind.as_str()), "{triple}: {}", reloc.kind);
            }
        }
    }

    #[test]
    fn flags_route_to_shared_and_isa() {
        let flags = ["opt_level=speed".to_string(), "has_avx2".to_string()];
        let out = compile(ADD, TRIPLES[0], &flags);
        assert!(out.errors.is_empty(), "{:?}", out.errors);
    }

    #[test]
    fn bad_flag_and_bad_clif_are_errors() {
        let out = compile(ADD, TRIPLES[0], &["nope=1".to_string()]);
        assert_eq!(out.errors.len(), 1);
        let out = compile("function %f( {", TRIPLES[1], &[]);
        assert_eq!(out.errors.len(), 1);
    }

    #[test]
    fn schema_has_shared_and_isa_flags() {
        let schema = flag_schema(TRIPLES[0]).unwrap();
        assert!(schema.iter().any(|f| f.name == "opt_level" && f.shared));
        assert!(schema.iter().any(|f| f.name == "has_avx2" && !f.shared));
        let default = |name: &str| schema.iter().find(|f| f.name == name).unwrap().default.clone();
        assert_eq!(default("opt_level").as_deref(), Some("none"));
        assert_eq!(default("unwind_info").as_deref(), Some("true"));
        assert_eq!(default("has_avx2"), Some("false".to_string()));
    }
}
