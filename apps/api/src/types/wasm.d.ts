/** Workers/wrangler bundles `.wasm` imports as a WebAssembly.Module at deploy time. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
