import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { sha256Hex } from '../../substrate';

/** 256 KiB: longer than any draft a reader would sit through, and a bound on one prompt's payload. */
export const MAX_DRAFT_BYTES = 256 * 1024;

export interface AudienceDraft {
  /**
   * The path exactly as the caller wrote it, so the record cites the file the way a human would.
   * The hash, never the path, is what identifies the content the readers were shown.
   */
  readonly path: string;
  readonly sha256: string;
  readonly text: string;
}

/**
 * The hash is over the bytes on disk, so it is the file's own SHA-256 — what `sha256sum` prints —
 * and any change at all, a reworded sentence or a line ending rewritten by a Windows checkout, is
 * a different draft, a different hash and therefore a different session.
 */
export async function readDraft(path: string, cwd: string): Promise<AudienceDraft> {
  const given = path.trim();
  if (given.length === 0) throw new Error('--draft needs a path');
  const absolute = isAbsolute(given) ? resolve(given) : resolve(cwd, given);
  const stats = await stat(absolute).catch(() => null);
  if (stats === null) throw new Error(`No draft found at ${given}`);
  if (!stats.isFile()) throw new Error(`The draft at ${given} is not a file`);
  if (stats.size > MAX_DRAFT_BYTES) {
    throw new Error(
      `The draft at ${given} is ${stats.size} bytes; the limit is ${MAX_DRAFT_BYTES} bytes`,
    );
  }
  const bytes = new Uint8Array(await readFile(absolute));
  const text = new TextDecoder().decode(bytes);
  if (text.trim().length === 0) throw new Error(`The draft at ${given} is empty`);
  return { path: given, sha256: sha256Hex(bytes), text };
}
