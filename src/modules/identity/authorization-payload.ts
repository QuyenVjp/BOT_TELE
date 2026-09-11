import { createHash } from "node:crypto";

export type AuthorizationJsonValue =
  | null
  | boolean
  | number
  | string
  | AuthorizationJsonValue[]
  | { [key: string]: AuthorizationJsonValue };

function canonicalJson(value: AuthorizationJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("authorization payload contains non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

export interface AuthorizationBindingInput {
  actionKey: string;
  resourceType: string;
  resourceId: string;
  resourceVersion: string;
  data: AuthorizationJsonValue;
}

export function canonicalAuthorizationPayload(input: AuthorizationBindingInput): string {
  return canonicalJson({
    actionKey: input.actionKey,
    data: input.data,
    resourceId: input.resourceId,
    resourceType: input.resourceType,
    resourceVersion: input.resourceVersion,
  });
}

export function hashAuthorizationPayload(input: AuthorizationBindingInput): string {
  return createHash("sha256").update(canonicalAuthorizationPayload(input), "utf8").digest("hex");
}
