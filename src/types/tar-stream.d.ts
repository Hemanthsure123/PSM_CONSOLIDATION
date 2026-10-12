// Minimal typings for tar-stream v3 (the package ships none). Only the
// extract-as-async-iterator API used by src/lib/github-repo.ts is declared.
declare module "tar-stream" {
  import type { Readable, Writable } from "node:stream";

  export interface Headers {
    name: string;
    size?: number;
    type?:
      | "file"
      | "link"
      | "symlink"
      | "directory"
      | "block-device"
      | "character-device"
      | "fifo"
      | "contiguous-file"
      | "pax-header"
      | "pax-global-header"
      | "gnu-long-link-path"
      | "gnu-long-path"
      | null;
  }

  export interface Entry extends Readable {
    header: Headers;
  }

  export interface Extract extends Writable, AsyncIterable<Entry> {}

  export function extract(opts?: Record<string, unknown>): Extract;
}
