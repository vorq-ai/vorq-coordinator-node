/**
 * One `multipart/form-data` body, assembled by hand.
 *
 * Written out rather than produced by a helper library on purpose: this is the
 * wire format every client of `POST /v1/files` sends — the one door that reads a
 * form — and a body built by the same code that parses it would agree with
 * itself however wrong both were (R32).
 */

export const BOUNDARY = "----vorqtestboundary";

export const FORM_CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

export interface Part {
  name: string;
  value: string | Buffer;
  /** Present on the file part and on nothing else. */
  filename?: string;
}

export function multipart(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.filename}"`;
    const type =
      part.filename === undefined ? "" : "content-type: application/octet-stream\r\n";
    chunks.push(
      Buffer.from(`--${BOUNDARY}\r\ncontent-disposition: ${disposition}\r\n${type}\r\n`, "utf8"),
      typeof part.value === "string" ? Buffer.from(part.value, "utf8") : part.value,
      Buffer.from("\r\n", "utf8"),
    );
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}

/**
 * The form a door reads: every field of `fields` as a string, in order, and
 * then `file` — or no file part at all when `file` is `null`.
 */
export function form(
  fields: Record<string, unknown>,
  file: { name: string; bytes: Buffer; filename?: string } | null,
): Buffer {
  const parts: Part[] = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => ({ name, value: String(value) }));
  if (file !== null) {
    parts.push({ name: file.name, value: file.bytes, filename: file.filename ?? file.name });
  }
  return multipart(parts);
}
