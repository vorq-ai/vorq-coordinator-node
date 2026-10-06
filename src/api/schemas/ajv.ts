import type { Ajv, ErrorObject } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FastifySchemaCompiler } from "fastify";
import { ApiError, type ErrorType } from "../errors.js";

/**
 * JSON Schema 2020-12, the dialect of the OpenAPI 3.1 document these schemas
 * publish, so what is validated and what is documented are read the same way.
 *
 * The validator configuration, shared by every route schema and by the batch
 * worker's line check — a batch line is a `POST /v1/jobs` body, so it is refused
 * by the same schema, the same formats and the same error shape.
 *
 * `removeAdditional` is off everywhere: a field this node does not read is left
 * alone, never silently dropped. `verbose` puts `parentSchema` on each error,
 * which is where the `x-vorq-error` metadata below is read from.
 */
const OPTIONS = {
  removeAdditional: false,
  useDefaults: true,
  discriminator: true,
  allErrors: false,
  verbose: true,
} as const;

const DIGITS = /^\d+$/;

/**
 * Canonical padded base64: the alphabet, at most two `=`, and a length that is a
 * multiple of 4. A format rather than a `pattern` because the one-regex spelling
 * of the length rule is a repeated group, and V8 overflows its stack running that
 * over a 15 MB container.
 */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * How a schema failure is answered, when the default is not the contract.
 *
 * `message` is appended to the parameter name (`job_id must be …`). `code`,
 * `status` and `type` replace the defaults (`null`, 400, `invalid_request`) for a
 * refusal whose code a client branches on. Applied to a value that fails its
 * schema — never to a missing field, which is always a plain `… is required`.
 */
export interface VorqError {
  message?: string;
  code?: string;
  status?: number;
  type?: ErrorType;
}

export const VORQ_ERROR = "x-vorq-error";

/** Registers the formats and the metadata keyword. Fastify calls it as an ajv plugin. */
export function vorqAjv(ajv: Ajv): Ajv {
  ajv.addFormat("base64", {
    type: "string",
    validate: (value: string) => value.length % 4 === 0 && BASE64.test(value),
  });
  ajv.addKeyword({ keyword: VORQ_ERROR, schemaType: "object" });
  return ajv;
}

/**
 * Bodies are never coerced: a signed body reaches the handler as the values that
 * were signed, and `"12"` for a `uint32` is refused rather than read as `12`.
 */
export const bodyAjv = vorqAjv(new Ajv2020({ ...OPTIONS, coerceTypes: false }));

/**
 * Path and query parameters are strings by construction, so an `integer`
 * parameter is read from its digits — and only from digits. ajv's own coercion
 * would take `1e3`, ` 12` and `0x10`; a repeated parameter arrives as an array and
 * fails its type, because a repeated parameter is a client bug, not a list.
 */
function urlValidator(schema: Record<string, unknown>) {
  const validate = bodyAjv.compile(schema);
  const properties = (schema.properties ?? {}) as Record<string, { type?: unknown }>;
  const integers = Object.keys(properties).filter((name) => properties[name]?.type === "integer");
  return (data: Record<string, unknown>) => {
    for (const name of integers) {
      const raw = data[name];
      if (typeof raw === "string" && DIGITS.test(raw)) data[name] = Number(raw);
    }
    return validate(data) ? { value: data } : { error: validate.errors ?? [] };
  };
}

export const compileSchema: FastifySchemaCompiler<Record<string, unknown>> = ({ schema, httpPart }) =>
  httpPart === "querystring" || httpPart === "params" ? urlValidator(schema) : bodyAjv.compile(schema);

type Schema = Record<string, unknown> | undefined;

const unescape = (segment: string): string => segment.replace(/~1/g, "/").replace(/~0/g, "~");

/** `["snapshot", "quotes", "3", "rate_in"]` → `snapshot.quotes[3].rate_in`. */
function paramOf(segments: string[], root: string): string {
  if (segments.length === 0) return root;
  return segments
    .map((segment, i) => (/^\d+$/.test(segment) ? `[${segment}]` : i === 0 ? segment : `.${segment}`))
    .join("");
}

/** The literal values a discriminated union accepts for its tag, in order. */
function tagValues(union: Schema, tag: string): string[] {
  const branches = (union?.oneOf ?? []) as Schema[];
  return branches.map((branch) => {
    const property = (branch?.properties as Record<string, Schema> | undefined)?.[tag];
    return String(property?.const ?? property?.enum);
  });
}

/**
 * The first schema failure, as the envelope every other refusal uses.
 *
 * `param` names the field the caller sent, as a path — `snapshot.quotes[3].rate_in`
 * — and `root` when the failure is the value as a whole (`body`, or `line` for a
 * batch line).
 */
export function validationFailure(errors: readonly ErrorObject[], root: string): ApiError {
  const error = errors[0];
  if (error === undefined) return new ApiError(400, "invalid_request", `${root} is invalid`, root);

  const segments = error.instancePath.split("/").slice(1).map(unescape);
  const parent = error.parentSchema as Schema;

  // `dependentRequired` is a `required` that only applies once another field is
  // present: the missing one is named the same way.
  if (error.keyword === "required" || error.keyword === "dependentRequired") {
    const param = paramOf([...segments, String(error.params.missingProperty)], root);
    return new ApiError(400, "invalid_request", `${param} is required`, param);
  }

  let message = error.message ?? "is invalid";
  if (error.keyword === "discriminator") {
    const tag = String(error.params.tag);
    segments.push(tag);
    message = `must be one of ${tagValues(parent, tag).join(", ")}`;
  } else if (error.keyword === "enum") {
    message = `must be one of ${(error.params.allowedValues as unknown[]).join(", ")}`;
  } else if (error.keyword === "const") {
    message = `must be ${String(error.params.allowedValue)}`;
  }

  const meta = (parent?.[VORQ_ERROR] ?? {}) as VorqError;
  const param = paramOf(segments, root);
  return new ApiError(
    meta.status ?? 400,
    meta.type ?? "invalid_request",
    `${param} ${meta.message ?? message}`,
    param,
    meta.code ?? null,
  );
}
