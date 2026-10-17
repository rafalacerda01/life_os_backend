"use strict";

// R12 test protocol only. No production adapter or identity policy is implemented.
const RUNTIME = "BACKEND";
const RELEASE_SHA256 = "fe095417e3406a5949937e1775df18924363cd91e8af9dafb4d87fce8118b310";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {createHash} = require("node:crypto");
const Module = require("node:module");
const VERSION = "R10-FIX1";
const OUTPUT_KEYS = ["status", "reservation", "guard", "guardContext", "operation",
  "v1Context", "auth", "provenance", "terminalProof", "requiredEvidence",
  "destructiveAuthority", "admissionAuthority"];
const SAFETY = Object.freeze({destructiveAuthority: false, admissionAuthority: false,
  provenance: "UNPROVEN", terminalProof: "NOT_PERFORMED"});
const lf = (text) => text.replace(/\r\n/g, "\n");
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
function exact(value, keys, code) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), code);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), code);
}
function extractReader(text) {
  const source = lf(text);
  function section(start, end) {
    const a = source.indexOf(start); const b = source.indexOf(end, a + start.length);
    assert.ok(a >= 0 && b > a && source.indexOf(start, a + start.length) === -1, "SOURCE_LAYOUT");
    return source.slice(a, b).trimEnd();
  }
  return ["\"use strict\";", "",
    "// R12 test-only exact extraction. Canonical: functions/retired_identity_contract_v2.js",
    "// No synthetic operation factory, SDK, IO or production adapter is included.",
    section("const UUID =", "const CODES ="),
    section("function exact(", "function safeUid("),
    section("function recordStructure(", "function recordValue("),
    section("// Read-only normalized snapshots.", "function createSyntheticRetirementContractV2("),
    "module.exports = {classifyRetiredIdentitySnapshots};", ""].join("\n");
}
function outputSchema(value) {
  exact(value, OUTPUT_KEYS, "OUTPUT_SCHEMA");
  for (const [key, expected] of Object.entries(SAFETY)) assert.equal(value[key], expected, "SAFETY_FIELD");
  for (const key of OUTPUT_KEYS.filter((key) => !["requiredEvidence", "destructiveAuthority", "admissionAuthority"].includes(key))) {
    assert.equal(typeof value[key], "string", "OUTPUT_SCHEMA");
  }
  assert.ok(Array.isArray(value.requiredEvidence) && value.requiredEvidence.every((v) => typeof v === "string"), "OUTPUT_SCHEMA");
}
function verifyArtifacts({manifestText, vectorsText, readerSource, canonicalSource}) {
  const manifest = JSON.parse(manifestText); const vectors = JSON.parse(vectorsText);
  exact(manifest, ["format", "formatVersion", "contractVersion", "hashEncoding", "canonical",
    "readerSha256", "vectorsSha256", "outputKeys", "safety"], "MANIFEST_SCHEMA");
  assert.equal(manifest.format, "lifeos-retired-identity-conformance", "FORMAT_UNSUPPORTED");
  assert.equal(manifest.formatVersion, 1, "VERSION_UNSUPPORTED");
  assert.equal(manifest.contractVersion, VERSION, "VERSION_UNSUPPORTED");
  assert.equal(manifest.hashEncoding, "UTF-8/LF", "HASH_ENCODING");
  exact(manifest.canonical, ["path", "commit", "sha256"], "MANIFEST_SCHEMA");
  assert.equal(manifest.canonical.path, "functions/retired_identity_contract_v2.js", "CANONICAL_PATH");
  assert.match(manifest.canonical.commit, /^[a-f0-9]{40}$/, "MANIFEST_SCHEMA");
  assert.deepEqual(manifest.outputKeys, OUTPUT_KEYS, "OUTPUT_SCHEMA");
  assert.deepEqual(manifest.safety, SAFETY, "SAFETY_FIELD");
  exact(vectors, ["formatVersion", "contractVersion", "cases"], "VECTOR_SCHEMA");
  assert.equal(vectors.formatVersion, 1, "VERSION_UNSUPPORTED");
  assert.equal(vectors.contractVersion, VERSION, "VERSION_UNSUPPORTED");
  assert.ok(Array.isArray(vectors.cases) && vectors.cases.length > 0, "VECTOR_SCHEMA");
  const ids = new Set();
  for (const vector of vectors.cases) {
    exact(vector, ["id", "input", "decorations", "expected"], "VECTOR_SCHEMA");
    assert.match(vector.id, /^[a-z0-9-]+$/, "VECTOR_SCHEMA");
    assert.equal(ids.has(vector.id), false, "DUPLICATE_VECTOR"); ids.add(vector.id);
    assert.ok(Array.isArray(vector.decorations), "VECTOR_SCHEMA");
    for (const decoration of vector.decorations) {
      exact(decoration, ["path", "type"], "DECORATION_SCHEMA");
      assert.ok(["reservation.createTime", "guard.data.startedAt", "guard.data.retainUntil"]
          .includes(decoration.path) && decoration.type === "UNNORMALIZED_TIMESTAMP", "DECORATION_SCHEMA");
    }
    outputSchema(vector.expected);
  }
  assert.equal(sha256(lf(readerSource)), manifest.readerSha256, "READER_HASH_MISMATCH");
  assert.equal(sha256(lf(vectorsText)), manifest.vectorsSha256, "VECTORS_HASH_MISMATCH");
  if (canonicalSource !== undefined) {
    assert.equal(sha256(lf(canonicalSource)), manifest.canonical.sha256, "CANONICAL_HASH_MISMATCH");
    assert.equal(extractReader(canonicalSource), lf(readerSource), "EXTRACTION_MISMATCH");
  }
  assert.equal(sha256(lf(manifestText)), RELEASE_SHA256, "RELEASE_HASH_MISMATCH");
  return {manifest, vectors};
}
function materialize(vector) {
  const input = structuredClone(vector.input); let calls = 0;
  class UnnormalizedTimestamp {
    constructor(value) {this.seconds = value.seconds; this.nanoseconds = value.nanoseconds;}
    toMillis() {calls++; throw new Error("synthetic-private@example.invalid");}
    toDate() {calls++; throw new Error("synthetic-private@example.invalid");}
    toJSON() {calls++; throw new Error("synthetic-private@example.invalid");}
  }
  for (const decoration of vector.decorations) {
    const parts = decoration.path.split("."); const key = parts.pop();
    const parent = parts.reduce((value, part) => value[part], input);
    parent[key] = new UnnormalizedTimestamp(parent[key]);
  }
  function freeze(value) {
    if (value && typeof value === "object") {
      for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        if (Object.hasOwn(descriptor, "value")) freeze(descriptor.value);
      }
      Object.freeze(value);
    }
    return value;
  }
  return {input: freeze(input), calls: () => calls};
}
function assertClassification(actual, expected) {
  outputSchema(actual);
  assert.deepEqual(actual, expected, "FULL_RESULT_MISMATCH");
  assert.ok(Object.isFrozen(actual), "RESULT_NOT_FROZEN");
  assert.ok(Object.isFrozen(actual.requiredEvidence), "EVIDENCE_NOT_FROZEN");
  assert.throws(() => {actual.status = "PERMITTED";}, TypeError);
  assert.throws(() => {actual.requiredEvidence.push("PERMITTED");}, TypeError);
  for (const secret of ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "synthetic-private@example.invalid", "synthetic-owner", "demo-life-os-r12"]) {
    assert.equal(JSON.stringify(actual).includes(secret), false, "OUTPUT_NOT_SANITIZED");
  }
}

const read = (name) => fs.readFileSync(path.join(__dirname, `retired-identity-conformance.${name}.json`), "utf8");
const manifestText = read("manifest"); const vectorsText = read("vectors");
let canonicalSource; let readerSource; let classify;
if (RUNTIME === "FUNCTIONS") {
  // This path is within this repository; the backend never enters this branch.
  canonicalSource = fs.readFileSync(path.resolve(__dirname, "../retired_identity_contract_v2.js"), "utf8");
  readerSource = extractReader(canonicalSource);
} else {
  assert.equal(RUNTIME, "BACKEND", "RUNTIME_UNSUPPORTED");
  const reference = JSON.parse(read("reference"));
  exact(reference, ["formatVersion", "contractVersion", "source"], "REFERENCE_SCHEMA");
  assert.equal(reference.formatVersion, 1, "VERSION_UNSUPPORTED");
  assert.equal(reference.contractVersion, VERSION, "VERSION_UNSUPPORTED");
  assert.equal(typeof reference.source, "string", "REFERENCE_SCHEMA");
  readerSource = reference.source;
}
const artifacts = {manifestText, vectorsText, readerSource, canonicalSource};
const {vectors} = verifyArtifacts(artifacts);
if (RUNTIME === "FUNCTIONS") {
  classify = require("../retired_identity_contract_v2.js").classifyRetiredIdentitySnapshots;
} else {
  // Compile only a hash-verified local fixture; no application or outside module.
  const fixture = new Module(path.join(__dirname, "retired-identity-classifier-reference.cjs"));
  fixture.filename = fixture.id;
  fixture.require = () => {throw new Error("REFERENCE_IMPORT_FORBIDDEN");};
  fixture._compile(readerSource, fixture.filename);
  classify = fixture.exports.classifyRetiredIdentitySnapshots;
}
test("R12 release, vector hash and reference provenance match", () => {
  assert.equal(verifyArtifacts(artifacts).vectors.cases.length, vectors.cases.length);
});
for (const vector of vectors.cases) {
  test(`R12 full-result parity: ${vector.id}`, () => {
    const fixture = materialize(vector);
    assertClassification(classify(fixture.input), vector.expected);
    assert.equal(fixture.calls(), 0, "SDK_METHOD_CALLED");
  });
}

for (const [name, mutate, expected] of [
  ["manifest version", (m) => {m.formatVersion++;}, /VERSION_UNSUPPORTED/],
  ["contract version", (m) => {m.contractVersion = "future";}, /VERSION_UNSUPPORTED/],
  ["extra manifest field", (m) => {m.enabled = true;}, /MANIFEST_SCHEMA/],
  ["reader hash", (m) => {m.readerSha256 = "0".repeat(64);}, /READER_HASH_MISMATCH/],
  ["vector hash", (m) => {m.vectorsSha256 = "0".repeat(64);}, /VECTORS_HASH_MISMATCH/],
  ["new output key", (m) => {m.outputKeys.push("authorization");}, /OUTPUT_SCHEMA/],
  ["promoted authority", (m) => {m.safety.destructiveAuthority = true;}, /SAFETY_FIELD/],
  ["provenance relabel", (m) => {m.safety.provenance = "PROVEN";}, /SAFETY_FIELD/],
]) {
  test(`R12 refuses divergent ${name}`, () => {
    const manifest = JSON.parse(manifestText); mutate(manifest);
    assert.throws(() => verifyArtifacts({...artifacts, manifestText: JSON.stringify(manifest)}), expected);
  });
}
function manifestWithCommit(commit) {
  const original = JSON.stringify(JSON.parse(manifestText).canonical.commit);
  assert.equal(manifestText.split(original).length, 2, "UNIQUE_COMMIT_TOKEN_REQUIRED");
  return manifestText.replace(original, JSON.stringify(commit));
}
test("R12 release provenance control preserves exact original text", () => {
  const unchanged = manifestWithCommit(JSON.parse(manifestText).canonical.commit);
  assert.equal(unchanged, manifestText);
  assert.doesNotThrow(() => verifyArtifacts({...artifacts, manifestText: unchanged}));
});
test("R12 refuses divergent release provenance without formatting changes", () => {
  const original = JSON.parse(manifestText);
  const commit = "0".repeat(40);
  assert.notEqual(original.canonical.commit, commit);
  const changed = manifestWithCommit(commit);
  assert.equal(changed.replace(JSON.stringify(commit), JSON.stringify(original.canonical.commit)), manifestText);
  assert.deepEqual(JSON.parse(changed), {...original, canonical: {...original.canonical, commit}});
  assert.throws(() => verifyArtifacts({...artifacts, manifestText: changed}), /RELEASE_HASH_MISMATCH/);
});
for (const [name, mutate, expected] of [
  ["vector version", (v) => {v.formatVersion++;}, /VERSION_UNSUPPORTED/],
  ["extra vector field", (v) => {v.cases[0].authority = true;}, /VECTOR_SCHEMA/],
  ["extra expected output", (v) => {v.cases[0].expected.permitted = true;}, /OUTPUT_SCHEMA/],
  ["duplicate vector", (v) => {v.cases.push(v.cases[0]);}, /DUPLICATE_VECTOR/],
]) {
  test(`R12 refuses ${name}`, () => {
    const value = JSON.parse(vectorsText); mutate(value);
    assert.throws(() => verifyArtifacts({...artifacts, vectorsText: JSON.stringify(value)}), expected);
  });
}
test("R12 refuses a changed reference body without executing it", () => {
  assert.throws(() => verifyArtifacts({...artifacts, readerSource: readerSource + "\n// changed"}), /READER_HASH_MISMATCH/);
});
test("R12 rejects a new actual output field even if status matches", () => {
  const expected = vectors.cases[0].expected;
  assert.throws(() => assertClassification({...expected, permission: true}, expected), /OUTPUT_SCHEMA/);
  const changed = {...expected, requiredEvidence: [...expected.requiredEvidence, "EXTRA"]};
  assert.throws(() => assertClassification(changed, expected), /FULL_RESULT_MISMATCH/);
});
test("R12 rejects mutable responses even when their values match", () => {
  const expected = vectors.cases[0].expected;
  assert.throws(() => assertClassification(structuredClone(expected), expected), /RESULT_NOT_FROZEN/);
});
test("R12 pure reference imports no SDK, files, network or synthetic operation factory", () => {
  assert.doesNotMatch(readerSource, /\brequire\s*\(|\bimport\s|\bprocess\b|\bconsole\b|\bfetch\s*\(/);
  assert.doesNotMatch(readerSource, /createSyntheticRetirementContractV2|\.runTransaction\(|\.deleteUser\(|\.set\(|\.create\(/);
  let effects = 0; const box = {module: {exports: {}}, require() {effects++; throw new Error("NO_IMPORTS");}};
  new vm.Script(readerSource).runInNewContext(box, {timeout: 1000});
  assert.deepEqual(Object.keys(box.module.exports), ["classifyRetiredIdentitySnapshots"]);
  assert.equal(effects, 0);
});
if (RUNTIME === "FUNCTIONS") {
  test("R12 canonical source changes require review, not automatic regeneration", () => {
    assert.throws(() => verifyArtifacts({...artifacts, canonicalSource: canonicalSource + "\n// drift"}), /CANONICAL_HASH_MISMATCH/);
  });
}
