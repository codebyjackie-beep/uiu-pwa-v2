/** Workers/wrangler bundles `.wasm` imports as a WebAssembly.Module at deploy time. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

/** wrangler.toml `[[rules]] type = "Data"` bundles `.ttf` imports as a raw ArrayBuffer. */
declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}
