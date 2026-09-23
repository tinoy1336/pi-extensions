/**
 * pi-sdk-shim.mjs — the rig's stand-in for `@earendil-works/pi-coding-agent`.
 *
 * pi bundles that module INSIDE its binary; the shipped package has no
 * importable dist, so a plain node process cannot resolve the specifier. The
 * extensions use from it:
 *   - `defineTool` (canon, a real value import) — build a tool definition;
 *   - `ExtensionAPI` (type-only, erased before the module runs).
 * So the shim only has to provide `defineTool`. It is identity: canon passes the
 * returned definition straight to `pi.registerTool`, which the harness no-ops.
 */
export const defineTool = (definition) => definition;
