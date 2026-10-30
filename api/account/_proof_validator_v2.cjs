"use strict";

// Pure CLOSED model validator. Labels describe declarations, never SDK reads,
// verified producers, generation proof, admission or a cleanup capability.
// No resolver/activation hook exists. Production must not import this module.
const BINDING_KEYS = ["projectId", "databaseId", "tenantId", "uid"];
const PRODUCERS = Object.freeze({
  AUTH_OBSERVATION: ["FIREBASE_AUTH"],
  UID_RELATION: ["UID_WRITER"],
  R5_OPERATION: ["R5_CONTROLLER"],
  RESOURCE_RELATION: ["RESOURCE_WRITER"],
  GENERATION_HINT: ["AUTH_METADATA", "BIRTH_LEDGER", "R5_CONTROLLER"],
});
const SCOPES = Object.freeze({
  AUTH_GENERATION: ["IDENTITY_GENERATION"],
  UID_RELATION: ["UID_ASSOCIATION"],
  R5_OPERATION: ["OPERATION_ASSOCIATION"],
  RESOURCE_OWNERSHIP: ["OPERATION_ASSOCIATION", "GENERATION_OWNERSHIP"],
});

class Refusal extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function refuse(code) {
  throw new Refusal(code);
}

// Inspect data properties without invoking getters or accepting extra keys.
function record(value, keys, code) {
  if (!value || typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    refuse(code);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const own = Reflect.ownKeys(descriptors);
  if (own.length !== keys.length || own.some((key) =>
    typeof key !== "string" || !keys.includes(key))) refuse(code);
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")) refuse(code);
    result[key] = descriptor.value;
  }
  return result;
}

function list(value, maximum, code) {
  if (!Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) refuse(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const size = descriptors.length.value;
  if (size > maximum || Reflect.ownKeys(descriptors).length !== size + 1) {
    refuse(code);
  }
  const result = [];
  for (let i = 0; i < size; i++) {
    const item = descriptors[i];
    if (!item || !item.enumerable || !Object.hasOwn(item, "value")) refuse(code);
    result.push(item.value);
  }
  return result;
}

function text(value, maximum = 128) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximum && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function segment(value) {
  return text(value) && !value.includes("/") &&
    ![".", ".."].includes(value) && !/^__.*__$/.test(value);
}

function binding(value) {
  const result = record(value, BINDING_KEYS, "INVALID_BINDING");
  if (!text(result.projectId, 63) || !/^[a-z][a-z0-9-]+$/.test(result.projectId) ||
      !(result.databaseId === "(default)" ||
        (text(result.databaseId, 63) &&
          /^[a-z][a-z0-9-]+$/.test(result.databaseId))) ||
      !segment(result.uid) ||
      !(result.tenantId === null || segment(result.tenantId))) {
    refuse("INVALID_BINDING");
  }
  return result;
}

function matchBinding(value, expected) {
  const actual = binding(value);
  for (const [key, reason] of [
    ["projectId", "PROJECT_MISMATCH"], ["databaseId", "DATABASE_MISMATCH"],
    ["tenantId", "TENANT_MISMATCH"], ["uid", "UID_MISMATCH"],
  ]) {
    if (actual[key] !== expected[key]) refuse(reason);
  }
}

function path(value, expected) {
  if (!text(value, 1024)) refuse("INVALID_RESOURCE_PATH");
  const parts = value.split("/");
  if (parts.length % 2 !== 0 || !parts.every(segment)) {
    refuse("INVALID_RESOURCE_PATH");
  }
  // A declaration cannot redirect a private/control namespace to another UID.
  if (["users", "account_deletion_guards", "retired_auth_identities",
    "account_birth_decisions"].includes(parts[0]) && parts[1] !== expected.uid) {
    refuse("RESOURCE_UID_MISMATCH");
  }
  return value;
}

function version(value) {
  const v = record(value, ["seconds", "nanoseconds"], "INVALID_RESOURCE_VERSION");
  if (!Number.isSafeInteger(v.seconds) || v.seconds < 0 ||
      !Number.isInteger(v.nanoseconds) || v.nanoseconds < 0 ||
      v.nanoseconds >= 1000000000) refuse("INVALID_RESOURCE_VERSION");
  return v;
}

function source(value, expected) {
  const s = record(value, ["id", "kind", "producer", "binding", "facts"],
      "INVALID_SOURCE");
  if (!segment(s.id)) refuse("INVALID_SOURCE_ID");
  if (typeof s.kind !== "string" || !Object.hasOwn(PRODUCERS, s.kind)) refuse("UNKNOWN_SOURCE_KIND");
  if (!PRODUCERS[s.kind].includes(s.producer)) refuse("UNKNOWN_PRODUCER");
  matchBinding(s.binding, expected);
  let facts;
  if (s.kind === "AUTH_OBSERVATION") {
    facts = record(s.facts, ["present"], "INVALID_AUTH_OBSERVATION");
    if (typeof facts.present !== "boolean") refuse("INVALID_AUTH_OBSERVATION");
  } else if (s.kind === "GENERATION_HINT") {
    facts = record(s.facts, ["basis"], "INVALID_GENERATION_HINT");
    if (!["TIMESTAMP", "EMAIL", "BOOLEAN", "MARKER", "ABSENCE"]
        .includes(facts.basis)) refuse("INVALID_GENERATION_HINT");
  } else if (s.kind === "R5_OPERATION") {
    facts = record(s.facts, ["deletionId", "state", "operationPath"],
        "INVALID_R5_OPERATION");
    if (!segment(facts.deletionId) ||
        !["IN_PROGRESS", "REVIEW_REQUIRED", "COMPLETE"].includes(facts.state) ||
        facts.operationPath !==
          "account_deletion_guards/" + expected.uid + "/control/operation") {
      refuse("INVALID_R5_OPERATION");
    }
  } else {
    const keys = s.kind === "UID_RELATION" ? ["resourcePath", "uid"] :
      ["resourcePath", "uid", "deletionId", "updateTime"];
    facts = record(s.facts, keys, "INVALID_RESOURCE_RELATION");
    path(facts.resourcePath, expected);
    if (facts.uid !== expected.uid) refuse("RESOURCE_UID_MISMATCH");
    if (s.kind === "RESOURCE_RELATION") {
      if (!(facts.deletionId === null || segment(facts.deletionId))) {
        refuse("INVALID_RESOURCE_RELATION");
      }
      facts.updateTime = version(facts.updateTime);
    }
  }
  return {id: s.id, kind: s.kind, facts};
}

function contradictions(sources) {
  const auth = sources.filter((s) => s.kind === "AUTH_OBSERVATION");
  if (new Set(auth.map((s) => s.facts.present)).size > 1) {
    refuse("CONTRADICTORY_AUTH_OBSERVATIONS");
  }
  const operations = sources.filter((s) => s.kind === "R5_OPERATION");
  if (new Set(operations.map((s) =>
    s.facts.deletionId + ":" + s.facts.state)).size > 1) {
    refuse("CONTRADICTORY_R5_OPERATIONS");
  }
  const resources = new Map();
  for (const s of sources.filter((item) => item.kind === "RESOURCE_RELATION")) {
    const f = s.facts;
    const signature = JSON.stringify([f.uid, f.deletionId,
      f.updateTime.seconds, f.updateTime.nanoseconds]);
    if (resources.has(f.resourcePath) &&
        resources.get(f.resourcePath) !== signature) {
      refuse("CONTRADICTORY_RESOURCE_RELATIONS");
    }
    resources.set(f.resourcePath, signature);
    if (f.deletionId !== null && operations.length &&
        f.deletionId !== operations[0].facts.deletionId) {
      refuse("CONTRADICTORY_OPERATION_ASSOCIATION");
    }
  }
}

function claim(value, expected, sources) {
  const c = record(value, ["id", "kind", "scope", "sourceIds", "resourcePath"],
      "INVALID_CLAIM");
  if (!segment(c.id)) refuse("INVALID_CLAIM_ID");
  if (typeof c.kind !== "string" || !Object.hasOwn(SCOPES, c.kind)) refuse("UNKNOWN_CLAIM_KIND");
  if (!SCOPES[c.kind].includes(c.scope)) refuse("INVALID_CLAIM_SCOPE");
  if (c.kind === "AUTH_GENERATION") {
    if (c.resourcePath !== null) refuse("INVALID_RESOURCE_PATH");
  } else {
    path(c.resourcePath, expected);
  }
  const ids = list(c.sourceIds, 16, "INVALID_SOURCE_REFERENCES");
  if (ids.length === 0 || ids.some((id) => !segment(id)) ||
      new Set(ids).size !== ids.length) refuse("INVALID_SOURCE_REFERENCES");
  const selected = ids.map((id) => {
    if (!sources.has(id)) refuse("SOURCE_NOT_FOUND");
    return sources.get(id);
  });
  const relations = selected.filter((s) =>
    ["UID_RELATION", "RESOURCE_RELATION"].includes(s.kind));
  if (relations.some((s) => s.facts.resourcePath !== c.resourcePath)) {
    refuse("RESOURCE_PATH_MISMATCH");
  }
  const operations = selected.filter((s) => s.kind === "R5_OPERATION");
  let classification = "UNPROVEN";
  let reason;
  if (c.kind === "AUTH_GENERATION") {
    reason = selected.some((s) => s.kind === "GENERATION_HINT") ?
      "INSUFFICIENT_GENERATION_EVIDENCE" : "AUTHORITATIVE_RESOLVER_UNAVAILABLE";
  } else if (c.kind === "UID_RELATION") {
    classification = relations.length ? "PROVEN" : "UNPROVEN";
    reason = relations.length ? "DECLARED_UID_RELATION_ONLY" : "UID_RELATION_MISSING";
  } else if (c.kind === "R5_OPERATION") {
    if (operations.some((s) => s.facts.operationPath !== c.resourcePath)) {
      refuse("RESOURCE_PATH_MISMATCH");
    }
    classification = operations.length ? "PROVEN" : "UNPROVEN";
    reason = operations.length ? "DECLARED_R5_OPERATION_ONLY" : "R5_OPERATION_MISSING";
  } else {
    const resource = relations.find((s) => s.kind === "RESOURCE_RELATION");
    if (!resource) {
      reason = "RESOURCE_RELATION_MISSING";
    } else if (c.scope === "GENERATION_OWNERSHIP") {
      classification = "CONDITIONAL";
      reason = "IDENTITY_NOT_PROVEN";
    } else if (operations.length && resource.facts.deletionId !== null &&
        resource.facts.deletionId === operations[0].facts.deletionId) {
      classification = "PROVEN";
      reason = "DECLARED_OPERATION_RESOURCE_ONLY";
    } else {
      reason = "OPERATION_ASSOCIATION_NOT_ESTABLISHED";
    }
  }
  return Object.freeze({id: c.id, kind: c.kind, scope: c.scope,
    basis: "ENVELOPE_CONSISTENCY_ONLY", classification, reason,
    identityProven: false, cleanupAuthorized: false});
}

function result(valid, reasons, claims = []) {
  return Object.freeze({version: 2, mode: "CLOSED", structurallyValid: valid,
    authority: "NONE", identityProven: false, cleanupAuthorized: false,
    reasons: Object.freeze(reasons), claims: Object.freeze(claims)});
}

/**
 * Validate an in-memory V2 envelope against an explicit expected binding.
 * Expected binding and producer names are declarations, not trust anchors.
 * Only plain JSON data is supported; no callbacks, SDK snapshots or IO.
 * PROVEN always means consistency of the declared model in the stated scope.
 * No accepted envelope proves Auth generation or grants cleanup authority.
 * @param {*} envelope Untrusted plain data.
 * @param {*} expectedBinding Explicit comparison context (default tenant only).
 * @return {Object} Frozen CLOSED assessment with deterministic reason codes.
 */
function validateEvidenceV2(envelope, expectedBinding) {
  try {
    if (arguments.length !== 2) refuse("UNSUPPORTED_ARGUMENTS");
    const expected = binding(expectedBinding);
    if (expected.tenantId !== null) refuse("UNSUPPORTED_TENANT");
    const e = record(envelope, ["version", "binding", "sources", "claims"],
        "INVALID_ENVELOPE");
    if (e.version !== 2) refuse("UNSUPPORTED_VERSION");
    matchBinding(e.binding, expected);
    const raw = list(e.sources, 64, "INVALID_SOURCES");
    const sources = new Map();
    for (const value of raw) {
      const s = source(value, expected);
      if (sources.has(s.id)) refuse("DUPLICATE_SOURCE_ID");
      sources.set(s.id, s);
    }
    contradictions([...sources.values()]);
    const claims = list(e.claims, 64, "INVALID_CLAIMS")
        .map((value) => claim(value, expected, sources));
    if (new Set(claims.map((c) => c.id)).size !== claims.length) {
      refuse("DUPLICATE_CLAIM_ID");
    }
    claims.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    return result(true, ["AUTHORITATIVE_RESOLVER_UNAVAILABLE",
      "CLOSED_NO_CLEANUP_AUTHORITY"], claims);
  } catch (error) {
    return result(false, [error instanceof Refusal ?
      error.code : "INVALID_ENVELOPE"]);
  }
}

module.exports = Object.freeze({validateEvidenceV2});
