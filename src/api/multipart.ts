import multipart, { type MultipartFile } from "@fastify/multipart";
import type { FastifyRequest } from "fastify";
import type { PinUpload } from "../pin/pinner.js";
import type { App } from "./deps.js";
import { ApiError, badRequest } from "./errors.js";
import { throughPinner } from "./pin-failure.js";

/**
 * How the upload door takes bytes: `multipart/form-data`, **fields first, file
 * last**.
 *
 * `POST /v1/files` is the one door that reads a form. The write doors take JSON
 * and carry their payload base64-inline or by the cid of an upload made here, so
 * the one thing this machinery is for is the upload that is too large to hold in
 * memory at all: `purpose` arrives as a field, the bytes as the one file part,
 * and they go straight into a {@link PinUpload} without this process ever
 * holding more than a part.
 *
 * The order is the whole point. The door reads its fields, decides from them
 * whether it wants the bytes, and only then reads the file part. A file part
 * that arrives before a field the door needs is a `400`: the clients are this
 * network's own, and the rule costs them nothing.
 *
 * **A route's `bodyLimit` is inert here.** `@fastify/multipart` registers a raw
 * parser, and Fastify applies `bodyLimit` only to parsers that buffer. The
 * bounds are the parser's own limits: `fileSize`, which is the node's blob
 * ceiling, and the field limits below. A field the parser truncated arrives
 * flagged rather than errored, and {@link readFields} refuses it.
 */

/** The most a non-file field may weigh, and how many there may be. */
export const FIELD_LIMITS = { fields: 24, fieldSize: 4 * 1024, fieldNameSize: 128 } as const;

/**
 * Register the multipart parser in a scope of its own, so it reaches only the
 * routes `register` declares: a parser registered at the root would quietly
 * accept a multipart body on every door.
 */
export function multipartScope(
  app: App,
  fileSize: number,
  register: (scope: App) => void,
): void {
  app.register(async (scope) => {
    await scope.register(multipart, { limits: { ...FIELD_LIMITS, files: 1, fileSize } });
    register(scope);
  });
}

/** The fields ahead of the file part, and the file part itself if there was one. */
export interface FormHead {
  fields: Record<string, string>;
  /** The file part the fields stopped at, or `null` when the body carried none. */
  file: MultipartFile | null;
}

/**
 * Read every field ahead of the first file part, and stop there.
 *
 * The file part is handed back **unread**: the caller decides, from the fields,
 * whether it wants the bytes at all, and then either {@link streamFile}s them or
 * {@link discardFile}s them. One of the two must happen — a file part nobody
 * reads stalls the body, and a response written over an unread body is a
 * connection the client sees reset rather than answered.
 */
export async function readFields(request: FastifyRequest): Promise<FormHead> {
  const fields: Record<string, string> = {};
  for await (const part of request.parts()) {
    if (part.type === "file") return { fields, file: part };
    if (part.valueTruncated) {
      throw badRequest(`${part.fieldname} is longer than this door reads`, part.fieldname);
    }
    fields[part.fieldname] = String(part.value);
  }
  return { fields, file: null };
}

/**
 * Stream the file part into `sink`, and report how many bytes went through.
 *
 * `onChunk` sees every chunk before the sink does — the files door counts a
 * batch's lines and commits to a container as it passes. Anything that throws,
 * the parser's own ceiling
 * included, aborts the sink first: an upload that is neither finished nor
 * aborted is billed storage no listing shows.
 *
 * A store failure while a part is going out is answered the way one at the
 * completion is — `503 pinner_unavailable`, retryable — because it is the
 * same failure: nothing the caller sent is wrong. Only the sink's writes are
 * mapped that way, at their source; what the parser or `onChunk` throws keeps
 * its own answer.
 */
export async function streamFile(
  request: FastifyRequest,
  file: MultipartFile,
  sink: PinUpload,
  onChunk?: (chunk: Buffer) => void,
): Promise<number> {
  let bytes = 0;
  try {
    for await (const chunk of file.file) {
      const buffer = chunk as Buffer;
      bytes += buffer.length;
      onChunk?.(buffer);
      await throughPinner(request, () => sink.write(buffer));
    }
    if (file.file.truncated) throw Object.assign(new Error("file too large"), { code: "FST_REQ_FILE_TOO_LARGE" });
  } catch (error) {
    await sink.abort();
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
      throw new ApiError(
        413,
        "invalid_request",
        `${file.fieldname} is past this node's ceiling`,
        file.fieldname,
        "file_too_large",
      );
    }
    throw error;
  }
  return bytes;
}

/** Read the file part to its end and keep none of it: the door refused before the bytes. */
export async function discardFile(file: MultipartFile | null): Promise<void> {
  if (file === null) return;
  try {
    for await (const chunk of file.file) void chunk;
  } catch {
    // The refusal already decided the answer; how the discarded body ended is
    // not part of it.
  }
}
