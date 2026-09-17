/**
 * Content-addressed blob storage for evidence payloads too large to inline.
 *
 * Evidence bytes are write-once, read-many, and addressed by their own SHA-256, so there
 * is no update path. There *is* now a delete path, and adding it required being precise
 * about what it means.
 *
 * **Why deletion is part of the contract.** The MVP specification requires a retention
 * manifest covering live ledger payloads, blobs, claims, embeddings, full-text indexes and
 * cache state. A job cannot report complete live-store erasure while the bytes it
 * detached are still on disk, and the missing-blocks assessment correctly calls that a
 * P0: "the manifest never counts a detached reference as a deleted blob object."
 *
 * **Why it is deletion by object, not by reference.** A content-addressed store
 * deduplicates: two events with identical payloads share one object. So clearing an
 * event's `payload_ref` removes a *reference*, and the object may still be live for
 * another event. Deleting on the first reference would silently break a second tenant's
 * or a second event's evidence, which is a data-loss bug wearing an erasure costume. The
 * caller therefore asks "is this object still referenced by any live row?" and the store
 * is only asked to delete objects that are not.
 *
 * **Why it reports what happened.** `delete` returns whether the object is *verified
 * absent* afterwards, not whether a delete was issued. An erasure job that reports success
 * because it called a delete is exactly the self-graded claim this project refuses, and
 * `sweep` exists so the residual scan can ask the physical backend directly rather than
 * trusting its own earlier call.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalize } from "./canonical.ts";

export interface BlobStore {
  /** Store bytes under their content hash. Returns the content-addressed ref. */
  put(bytes: Buffer): Promise<string>;
  /** Fetch bytes by ref. Returns null when the blob is absent. */
  get(ref: string): Promise<Buffer | null>;
  exists(ref: string): Promise<boolean>;
  /**
   * Remove the object at `ref`, and report whether it is *verified absent* afterwards.
   *
   * Returns `true` when the object no longer exists — including when it never did, since
   * "absent" is the postcondition and an already-absent object satisfies it. Returns
   * `false` when the object survives, which is the answer an erasure job must not round
   * up. A store that cannot delete at all throws `BlobDeletionUnsupportedError` rather
   * than returning `false`, so an append-only deployment is a configuration error rather
   * than a silently failing erasure.
   */
  delete(ref: string): Promise<boolean>;
  /**
   * Enumerate the refs this store physically holds, for a residual scan.
   *
   * The scan must interrogate the backend rather than re-read the ledger's own references:
   * asking the database whether it still points at a blob tells you about the database,
   * not about the disk.
   */
  sweep(): Promise<readonly string[]>;
  readonly kind: string;
  /** False for a store that cannot physically remove objects, such as an archive bucket. */
  readonly supportsDeletion: boolean;
}

/** Raised when a deletion is requested from a store that cannot perform one. */
export class BlobDeletionUnsupportedError extends Error {
  constructor(kind: string) {
    super(
      `the ${kind} blob store does not support deletion. A retention job cannot report a ` +
        `verified erase against it: configure a store that can delete, or declare the ` +
        `store as archive-only and accept that the manifest will report it as retained.`,
    );
    this.name = "BlobDeletionUnsupportedError";
  }
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

  readonly supportsDeletion = true;

  /**
   * Unlink the object, then verify it is gone by re-reading the path.
   *
   * The verification is the point: a delete that succeeded from the filesystem's point of
   * view and left the bytes reachable through another path is the failure mode an erasure
   * job has to detect, and re-`stat`ing the canonical path is what detects it.
   */
  async delete(ref: string): Promise<boolean> {
    const digestHex = refToDigest(ref);
    if (!digestHex) return true;
    try {
      await unlink(this.pathFor(digestHex));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await stat(this.pathFor(digestHex));
      return false;
    } catch {
      return true;
    }
  }

  /** Every object the store physically holds, as content-addressed refs. */
  async sweep(): Promise<readonly string[]> {
    const refs: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (/^[0-9a-f]{64}$/.test(entry.name)) {
          refs.push(contentAddressedRef(entry.name));
        }
      }
    };
    await walk(this.root);
    return refs.sort();
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

  readonly supportsDeletion = true;

  async delete(ref: string): Promise<boolean> {
    const digestHex = refToDigest(ref);
    if (!digestHex) return true;
    this.blobs.delete(digestHex);
    return !this.blobs.has(digestHex);
  }

  async sweep(): Promise<readonly string[]> {
    return [...this.blobs.keys()].map(contentAddressedRef).sort();
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
