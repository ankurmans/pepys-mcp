// Transport-agnostic entry point (imported by the Next app's remote OAuth MCP server as
// `pepys-mcp/core`). The stdio CLI has its own entry in index.ts. Everything here is pure: the
// tool/resource/prompt registrars + the injectable I/O factory, no process/env/stdio side effects.
export { registerTools } from "./tools.js";
export { registerResources } from "./resources.js";
export { registerPrompts } from "./prompts.js";
export {
  makeApiIo,
  makeEnvIo,
  PepysApiError,
  type Io,
  type Segment,
  type Transcription,
} from "./client.js";
