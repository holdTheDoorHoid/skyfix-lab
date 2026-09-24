//! WASM adapter. OWNER: web agent. Thin: parse JSON in, call core, JSON out.
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn version() -> String {
    skyfix_core::VERSION.to_string()
}
