/**
 * Content-addressed blob storage for evidence payloads too large to inline.
 *
 * The interface is small on purpose. Evidence bytes are write-once, read-many,
 * and addressed by their own SHA-256, so there is no update path and no delete
 * path here: retention erasure mutates the ledger row, and blob reclamation is a
 * separate operator task that must never be able to make a live span dangle.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalize } from "./canonical.ts";

export interface BlobStore {
  /** Store bytes under their content hash. Returns the content-addressed ref. */
  put(bytes: Buffer): Promise<string>;
  /** Fetch bytes by ref. Returns null when the blob is absent. */
  get(ref: string): Promise<Buffer | null>;
  exists(ref: string): Promise<boolean>;
  readonly kind: string;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256Bytes(bytes: Buffer | string): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function contentAddressedRef(digestHex: string): string {
  return `blob://sha256/${digestHex}`;
}

export function refToDigest(ref: string): string | null {
  const match = /^blob:\/\/sha256\/([0-9a-f]{64})$/.exec(ref);
  return match?.[1] ?? null;
}

/**
 * Filesystem blob store, sharded by digest prefix.
 *
 * This is the default in development and in CI. It is not a toy: it is
 * content-addressed, immutable and rebuildable, and it keeps the local
 * development loop free of an object-store dependency.
 */
export class FilesystemBlobStore implements BlobStore {
  readonly kind = "filesystem";
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathFor(digestHex: string): string {
    return join(this.root, digestHex.slice(0, 2), digestHex.slice(2, 4), digestHex);
  }

  async put(bytes: Buffer): Promise<string> {
    const digestHex = sha256Hex(bytes);
    const path = this.pathFor(digestHex);
    await mkdir(dirname(path), { recursive: true });
    try {
      // Exclusive write: content addressing means an existing file already has
      // the right bytes, so losing the race is success.
      await writeFile(path, bytes, { flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
    }
    return contentAddressedRef(digestHex);
  }

  async get(ref: string): Promise<Buffer | null> {
    const digestHex = refToDigest(ref);
    if (!digestHex) return null;
    try {
      const bytes = await readFile(this.pathFor(digestHex));
      // Verify on read. A blob store that returns bytes it cannot vouch for is
      // worse than one that returns nothing.
      if (sha256Hex(bytes) !== digestHex) {
        throw new Error(`blob ${ref} failed digest verification on read`);
      }
      return bytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async exists(ref: string): Promise<boolean> {
    return (await this.get(ref)) !== null;
  }
}

/** In-memory store for tests and for the borrow-checker style replay harness. */
export class MemoryBlobStore implements BlobStore {
  readonly kind = "memory";
  private readonly blobs = new Map<string, Buffer>();

  async put(bytes: Buffer): Promise<string> {
    const digestHex = sha256Hex(bytes);
    this.blobs.set(digestHex, Buffer.from(bytes));
    return contentAddressedRef(digestHex);
  }

  async get(ref: string): Promise<Buffer | null> {
    const digestHex = refToDigest(ref);
    if (!digestHex) return null;
    const found = this.blobs.get(digestHex);
    return found ? Buffer.from(found) : null;
  }

  async exists(ref: string): Promise<boolean> {
    const digestHex = refToDigest(ref);
    return digestHex !== null && this.blobs.has(digestHex);
  }
}

/** Canonical digest of a projection's rows, for replay equality. */
export function projectionDigest(rows: readonly unknown[]): { digest: string; rows: number } {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(canonicalize(row), "utf8");
    hash.update("\n");
  }
  return { digest: hash.digest("hex"), rows: rows.length };
}
