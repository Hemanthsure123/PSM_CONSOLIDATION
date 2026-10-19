/**
 * Lets scripts import server modules outside Next.js: Next aliases the
 * "server-only" marker package internally, so plain Node can't resolve it.
 * Import this FIRST; it resolves "server-only" to this (empty) module.
 */
import Module from "node:module";

const loader = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string };
const resolve = loader._resolveFilename;
loader._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === "server-only") return __filename;
  return resolve.call(this, request, ...rest);
};

export {};
