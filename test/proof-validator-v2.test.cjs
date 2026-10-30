"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../api/account/_proof_validator_v2.cjs");
const {validateEvidenceV2: validate} = api;

const BINDING = Object.freeze({projectId: "demo-life-os-p1",
  databaseId: "(default)", tenantId: null, uid: "synthetic-owner"});
const ROOT = "users/" + BINDING.uid;
const OP = "account_deletion_guards/" + BINDING.uid + "/control/operation";

function source(id, kind, producer, facts) {
  return {id, kind, producer, binding: {...BINDING}, facts};
}

function claim(id, kind, scope, sourceIds, resourcePath = null) {
  return {id, kind, scope, sourceIds, resourcePath};
}

function fixture() {
  return {version: 2, binding: {...BINDING}, sources: [
    source("auth", "AUTH_OBSERVATION", "FIREBASE_AUTH", {present: true}),
    source("uid", "UID_RELATION", "UID_WRITER",
        {resourcePath: ROOT, uid: BINDING.uid}),
    source("op", "R5_OPERATION", "R5_CONTROLLER",
        {deletionId: "synthetic-operation", state: "IN_PROGRESS", operationPath: OP}),
    source("resource", "RESOURCE_RELATION", "RESOURCE_WRITER", {
      resourcePath: ROOT, uid: BINDING.uid, deletionId: "synthetic-operation",
      updateTime: {seconds: 100, nanoseconds: 20},
    }),
  ], claims: [
    claim("identity", "AUTH_GENERATION", "IDENTITY_GENERATION", ["auth"]),
    claim("uid-link", "UID_RELATION", "UID_ASSOCIATION", ["uid"], ROOT),
    claim("operation", "R5_OPERATION", "OPERATION_ASSOCIATION", ["op"], OP),
    claim("operation-resource", "RESOURCE_OWNERSHIP", "OPERATION_ASSOCIATION",
        ["op", "resource"], ROOT),
    claim("generation-resource", "RESOURCE_OWNERSHIP", "GENERATION_OWNERSHIP",
        ["resource"], ROOT),
  ]};
}

function closed(result) {
  assert.equal(result.mode, "CLOSED");
  assert.equal(result.authority, "NONE");
  assert.equal(result.identityProven, false);
  assert.equal(result.cleanupAuthorized, false);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.claims));
  assert.ok(Object.isFrozen(result.reasons));
  for (const item of result.claims) {
    assert.equal(item.basis, "ENVELOPE_CONSISTENCY_ONLY");
    assert.equal(item.identityProven, false);
    assert.equal(item.cleanupAuthorized, false);
    assert.ok(Object.isFrozen(item));
  }
}

function evaluate(envelope, expected = BINDING) {
  const result = validate(envelope, expected);
  closed(result);
  return result;
}

function refused(envelope, reason, expected = BINDING) {
  const result = evaluate(envelope, expected);
  assert.equal(result.structurallyValid, false);
  assert.deepEqual(result.reasons, [reason]);
  assert.deepEqual(result.claims, []);
}

function byId(result, id) {
  return result.claims.find((item) => item.id === id);
}

test("valid structure has no authority or identity proof", () => {
  const result = evaluate(fixture());
  assert.equal(result.structurallyValid, true);
  assert.deepEqual(result.reasons, ["AUTHORITATIVE_RESOLVER_UNAVAILABLE",
    "CLOSED_NO_CLEANUP_AUTHORITY"]);
  assert.equal(byId(result, "identity").classification, "UNPROVEN");
  assert.equal(byId(result, "identity").reason, "AUTHORITATIVE_RESOLVER_UNAVAILABLE");
});

test("UID, R5 operation and operation resource are only declared-model relations", () => {
  const result = evaluate(fixture());
  for (const id of ["uid-link", "operation", "operation-resource"]) {
    assert.equal(byId(result, id).classification, "PROVEN");
  }
  assert.equal(byId(result, "operation-resource").scope, "OPERATION_ASSOCIATION");
  assert.equal(byId(result, "operation-resource").reason,
      "DECLARED_OPERATION_RESOURCE_ONLY");
  assert.equal(byId(result, "generation-resource").classification, "CONDITIONAL");
  assert.equal(byId(result, "generation-resource").reason, "IDENTITY_NOT_PROVEN");
});

for (const basis of ["TIMESTAMP", "EMAIL", "BOOLEAN", "MARKER", "ABSENCE"]) {
  test(basis + " cannot establish Auth generation", () => {
    const e = fixture();
    e.sources.push(source("hint", "GENERATION_HINT", "AUTH_METADATA", {basis}));
    e.claims[0].sourceIds.push("hint");
    const result = evaluate(e);
    assert.equal(result.structurallyValid, true);
    assert.equal(byId(result, "identity").classification, "UNPROVEN");
    assert.equal(byId(result, "identity").reason, "INSUFFICIENT_GENERATION_EVIDENCE");
    assert.equal(byId(result, "generation-resource").classification, "CONDITIONAL");
  });
}

for (const state of ["IN_PROGRESS", "REVIEW_REQUIRED", "COMPLETE"]) {
  test(state + " R5 declaration never authorizes cleanup or proves generation", () => {
    const e = fixture();
    e.sources[2].facts.state = state;
    const result = evaluate(e);
    assert.equal(result.structurallyValid, true);
    assert.equal(byId(result, "identity").classification, "UNPROVEN");
    assert.equal(byId(result, "operation").classification, "PROVEN");
  });
}

for (const [field, value, reason] of [
  ["projectId", "demo-other", "PROJECT_MISMATCH"],
  ["databaseId", "other-db", "DATABASE_MISMATCH"],
  ["tenantId", "other-tenant", "TENANT_MISMATCH"],
  ["uid", "other-user", "UID_MISMATCH"],
]) {
  for (const location of ["envelope", "source"]) {
    test(location + " " + field + " divergence is refused", () => {
      const e = fixture();
      (location === "envelope" ? e.binding : e.sources[0].binding)[field] = value;
      refused(e, reason);
    });
  }
}

test("non-default expected tenant is unsupported even if declarations agree", () => {
  const e = fixture();
  e.binding.tenantId = "tenant-a";
  refused(e, "UNSUPPORTED_TENANT", {...BINDING, tenantId: "tenant-a"});
});

test("unknown producer cannot impersonate an authoritative resolver", () => {
  const e = fixture();
  e.sources[0].producer = "AUTHORITATIVE_RESOLVER";
  refused(e, "UNKNOWN_PRODUCER");
});

test("producer recognized for another source type is refused", () => {
  const e = fixture();
  e.sources[2].producer = "FIREBASE_AUTH";
  refused(e, "UNKNOWN_PRODUCER");
});

test("unknown evidence origin is refused", () => {
  const e = fixture();
  e.sources[0].kind = "GENERATION_CERTIFICATE";
  refused(e, "UNKNOWN_SOURCE_KIND");
});

test("contradictory Auth observations invalidate the whole envelope", () => {
  const e = fixture();
  e.sources.push(source("absent", "AUTH_OBSERVATION", "FIREBASE_AUTH", {present: false}));
  refused(e, "CONTRADICTORY_AUTH_OBSERVATIONS");
});

for (const field of ["deletionId", "state"]) {
  test("contradictory R5 " + field + " is refused", () => {
    const e = fixture();
    const other = structuredClone(e.sources[2]);
    other.id = "conflicting-operation";
    other.facts[field] = field === "state" ? "COMPLETE" : "other-operation";
    e.sources.push(other);
    refused(e, "CONTRADICTORY_R5_OPERATIONS");
  });
}

test("contradictory resource versions cannot be rebased silently", () => {
  const e = fixture();
  const other = structuredClone(e.sources[3]);
  other.id = "conflicting-resource";
  other.facts.updateTime.nanoseconds++;
  e.sources.push(other);
  refused(e, "CONTRADICTORY_RESOURCE_RELATIONS");
});

test("resource assigned to another operation is refused", () => {
  const e = fixture();
  e.sources[3].facts.deletionId = "other-operation";
  refused(e, "CONTRADICTORY_OPERATION_ASSOCIATION");
});

test("UID relationship cannot redirect a private path to B", () => {
  const e = fixture();
  e.sources[1].facts.resourcePath = "users/independent-b";
  refused(e, "RESOURCE_UID_MISMATCH");
});

test("resource UID field cannot disagree with the binding", () => {
  const e = fixture();
  e.sources[3].facts.uid = "independent-b";
  refused(e, "RESOURCE_UID_MISMATCH");
});

test("claim cannot borrow evidence from another resource path", () => {
  const e = fixture();
  e.claims[4].resourcePath = ROOT + "/notes/other";
  refused(e, "RESOURCE_PATH_MISMATCH");
});

test("an operation source alone does not prove a resource relation", () => {
  const e = fixture();
  e.claims[4].sourceIds = ["op"];
  const result = evaluate(e);
  assert.equal(byId(result, "generation-resource").classification, "UNPROVEN");
  assert.equal(byId(result, "generation-resource").reason, "RESOURCE_RELATION_MISSING");
});

test("resource with no operation binding remains unproven in operation scope", () => {
  const e = fixture();
  e.sources[3].facts.deletionId = null;
  const result = evaluate(e);
  assert.equal(byId(result, "operation-resource").classification, "UNPROVEN");
  assert.equal(byId(result, "operation-resource").reason,
      "OPERATION_ASSOCIATION_NOT_ESTABLISHED");
});

for (const bad of [null, false, 100, "2026-10-29", {}, []]) {
  test("non-envelope input " + JSON.stringify(bad) + " is refused", () => {
    refused(bad, "INVALID_ENVELOPE");
  });
}

const mutations = [
  ["version string", (e) => { e.version = "2"; }, "UNSUPPORTED_VERSION"],
  ["future version", (e) => { e.version = 3; }, "UNSUPPORTED_VERSION"],
  ["forged authority", (e) => { e.authority = "VERIFIED"; }, "INVALID_ENVELOPE"],
  ["activation flag", (e) => { e.enabled = true; }, "INVALID_ENVELOPE"],
  ["source attestation boolean", (e) => { e.sources[0].verified = true; }, "INVALID_SOURCE"],
  ["source fact timestamp", (e) => { e.sources[0].facts.createdAt = 100; }, "INVALID_AUTH_OBSERVATION"],
  ["truthy Auth presence", (e) => { e.sources[0].facts.present = "true"; }, "INVALID_AUTH_OBSERVATION"],
  ["unknown reference", (e) => { e.claims[0].sourceIds = ["missing"]; }, "SOURCE_NOT_FOUND"],
  ["duplicate reference", (e) => { e.claims[0].sourceIds = ["auth", "auth"]; }, "INVALID_SOURCE_REFERENCES"],
  ["empty references", (e) => { e.claims[0].sourceIds = []; }, "INVALID_SOURCE_REFERENCES"],
  ["duplicate source", (e) => { e.sources.push(structuredClone(e.sources[0])); }, "DUPLICATE_SOURCE_ID"],
  ["duplicate claim", (e) => { e.claims.push(structuredClone(e.claims[0])); }, "DUPLICATE_CLAIM_ID"],
  ["scope promotion", (e) => { e.claims[2].scope = "IDENTITY_GENERATION"; }, "INVALID_CLAIM_SCOPE"],
  ["unknown claim", (e) => { e.claims[0].kind = "DELETE_AUTH"; }, "UNKNOWN_CLAIM_KIND"],
  ["invalid path", (e) => { e.sources[3].facts.resourcePath = ROOT + "/notes"; }, "INVALID_RESOURCE_PATH"],
  ["path traversal", (e) => { e.sources[3].facts.resourcePath = "users/../notes/item"; }, "INVALID_RESOURCE_PATH"],
  ["unsafe version", (e) => { e.sources[3].facts.updateTime.seconds = 2 ** 53; }, "INVALID_RESOURCE_VERSION"],
  ["fractional nanos", (e) => { e.sources[3].facts.updateTime.nanoseconds = 0.5; }, "INVALID_RESOURCE_VERSION"],
  ["out of range nanos", (e) => { e.sources[3].facts.updateTime.nanoseconds = 1e9; }, "INVALID_RESOURCE_VERSION"],
  ["unbounded sources", (e) => { e.sources = Array(65).fill(e.sources[0]); }, "INVALID_SOURCES"],
  ["sparse array", (e) => { delete e.sources[0]; }, "INVALID_SOURCES"],
  ["array metadata", (e) => { e.sources.extra = true; }, "INVALID_SOURCES"],
];

for (const [name, change, reason] of mutations) {
  test(name + " is refused deterministically", () => {
    const e = fixture();
    change(e);
    refused(e, reason);
    assert.deepEqual(validate(e, BINDING), validate(e, BINDING));
  });
}

test("getter properties are rejected without executing callbacks", () => {
  const e = fixture();
  let calls = 0;
  Object.defineProperty(e, "version", {enumerable: true,
    get() { calls++; throw Error("must not run"); }});
  refused(e, "INVALID_ENVELOPE");
  assert.equal(calls, 0);
});

test("source kind cannot execute coercion code", () => {
  const e = fixture();
  let calls = 0;
  e.sources[0].kind = {toString() { calls++; return "AUTH_OBSERVATION"; }};
  refused(e, "UNKNOWN_SOURCE_KIND");
  assert.equal(calls, 0);
});

test("callbacks, SDK objects and extra resolver arguments cannot enable authority", () => {
  let calls = 0;
  const e = fixture();
  e.resolver = () => { calls++; };
  refused(e, "INVALID_ENVELOPE");
  const result = validate(fixture(), BINDING, () => { calls++; });
  closed(result);
  assert.deepEqual(result.reasons, ["UNSUPPORTED_ARGUMENTS"]);
  assert.equal(calls, 0);
  assert.deepEqual(Object.keys(api), ["validateEvidenceV2"]);
  assert.ok(Object.isFrozen(api));
});

test("empty evidence is structurally allowed but proves no claim or authority", () => {
  const result = evaluate({version: 2, binding: {...BINDING}, sources: [], claims: []});
  assert.equal(result.structurallyValid, true);
  assert.deepEqual(result.claims, []);
});

test("input is unchanged and ordering of valid declarations is immaterial", () => {
  const e = fixture();
  const before = structuredClone(e);
  const result = evaluate(e);
  assert.deepEqual(e, before);
  e.sources.reverse();
  e.claims.reverse();
  for (const c of e.claims) c.sourceIds.reverse();
  assert.deepEqual(evaluate(e), result);
});

test("all combinations in a bounded synthetic corpus remain CLOSED", () => {
  for (const present of [true, false]) {
    for (const state of ["IN_PROGRESS", "REVIEW_REQUIRED", "COMPLETE"]) {
      for (const deletionId of [null, "synthetic-operation", "other-operation"]) {
        const e = fixture();
        e.sources[0].facts.present = present;
        e.sources[2].facts.state = state;
        e.sources[3].facts.deletionId = deletionId;
        const result = evaluate(e);
        assert.ok(result.claims.every((c) =>
          c.scope !== "IDENTITY_GENERATION" || c.classification === "UNPROVEN"));
      }
    }
  }
});

test("plain null-prototype JSON records are supported without trusting their origin", () => {
  const e = Object.assign(Object.create(null), fixture());
  assert.equal(evaluate(e).structurallyValid, true);
});
