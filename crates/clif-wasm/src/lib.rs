mod compile;

use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_large_number_types_as_bigints(false))
        .map_err(|e| JsError::new(&e.to_string()))
}

#[wasm_bindgen]
pub fn compile(clif: &str, triple: &str, flags: Vec<String>) -> Result<JsValue, JsError> {
    to_js(&compile::compile(clif, triple, &flags))
}

#[wasm_bindgen]
pub fn flag_schema(triple: &str) -> Result<JsValue, JsError> {
    to_js(&compile::flag_schema(triple).map_err(|e| JsError::new(&e))?)
}

#[wasm_bindgen]
pub fn triples() -> Vec<String> {
    compile::TRIPLES.iter().map(|t| t.to_string()).collect()
}
