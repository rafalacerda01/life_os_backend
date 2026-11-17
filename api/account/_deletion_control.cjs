"use strict";
/* eslint-disable require-jsdoc -- Internal contract primitives. */

const {createHash} = require("node:crypto");
const {Timestamp} = require("firebase-admin/firestore");
const trustedAccount = require("./_trusted_account.cjs");

const UUID = new RegExp("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-" +
    "[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
const HASH = /^[a-f0-9]{64}$/;
const RETENTION_MS = 65 * 60 * 1000;
const POLICY = "ACCOUNT_DELETE_SCOPE_V1";
const BINDING_KEYS = ["projectId", "databaseId", "uid"];
const CONTROL_KEYS = ["version", "projectId", "databaseId", "uid",
  "deletionId", "state", "origin", "sourceEventId", "scope", "completedAt"];
const SCOPE_KEYS = ["policyVersion", "privateRoot", "guardStartedAt",
  "billingAccountHash", "birthDecisionId", "birthDigest"];
const BIRTH_KEYS = ["version", "uid", "projectId", "tenantId",
  "authCreatedAt", "sourceType", "sourceEventId", "eventAt", "cohort",
  "decisionId", "originalIdentity", "recordedAt", "status"];

/** Sanitized failure: SDK messages, paths and identity never escape. */
class DeletionControlError extends Error {
  constructor(code) {
    super("Deletion control is unavailable or inconsistent.");
    this.name = "DeletionControlError";
    this.code = code;
    this.retryable = true;
  }
}
function fail(code) {
  throw new DeletionControlError(code);
}
function plain(value) {
  return value !== null && typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value, keys) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length) {
    return false;
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return keys.every((key) => Object.hasOwn(descriptors, key) &&
    Object.hasOwn(descriptors[key], "value"));
}
function text(value, max, empty = false) {
  return typeof value === "string" && value.length <= max &&
    (empty || value.length > 0) && value.trim() === value &&
    // Reject control characters in canonical identifiers.
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/.test(value);
}
function uid(value) {
  return text(value, 128) && Buffer.byteLength(value, "utf8") <= 128 &&
    !value.includes("/") && ![".", ".."].includes(value) &&
    !/^__.*__$/.test(value);
}
function isId(value) {
  return typeof value === "string" && UUID.test(value);
}
function isHash(value) {
  return typeof value === "string" && HASH.test(value);
}
function time(value) {
  return value instanceof Timestamp && Number.isInteger(value.seconds) &&
    value.seconds >= 0 && Number.isInteger(value.nanoseconds) &&
    value.nanoseconds >= 0 && value.nanoseconds < 1000000000;
}
function after(a, b) {
  return a.seconds > b.seconds ||
    (a.seconds === b.seconds && a.nanoseconds > b.nanoseconds);
}
function copy(value) {
  if (value instanceof Timestamp) {
    return new Timestamp(value.seconds, value.nanoseconds);
  }
  if (Array.isArray(value)) return value.map(copy);
  if (plain(value)) {
    const result = {};
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {value: copy(value[key]),
        enumerable: true, writable: true, configurable: true});
    }
    return result;
  }
  return value;
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function stable(value) {
  if (value instanceof Timestamp) {
    return ["Timestamp", value.seconds, value.nanoseconds];
  }
  if (Array.isArray(value)) return value.map(stable);
  if (plain(value)) {
    return Object.keys(value).sort().map((key) => [key, stable(value[key])]);
  }
  return value;
}
function same(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
function digest(value) {
  return createHash("sha256").update(JSON.stringify(stable(value)))
      .digest("hex");
}
function validateBinding(binding) {
  if (!exact(binding, BINDING_KEYS) ||
      typeof binding.projectId !== "string" ||
      !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(binding.projectId) ||
      binding.databaseId !== "(default)" || !uid(binding.uid)) {
    fail("INVALID_BINDING");
  }
  return freeze(copy(binding));
}
function version(value, supported) {
  if (!plain(value) || !Object.hasOwn(value, "version")) {
    fail("INVALID_FORMAT");
  }
  if (!supported.includes(value.version)) fail("UNSUPPORTED_FORMAT");
}
function validateReservation(value) {
  version(value, [1, 2]);
  const keys = value.version === 1 ?
    ["version", "state", "deletionId", "authCreatedAtMs"] :
    ["version", "state", "deletionId", "origin"];
  if (!exact(value, keys) || value.state !== "RESERVED" ||
      !isId(value.deletionId) ||
      (value.version === 1 && (!Number.isSafeInteger(value.authCreatedAtMs) ||
        value.authCreatedAtMs <= 0)) ||
      (value.version === 2 && !["PRE_AUTH", "AUTH_EVENT", "LEGACY_REVIEW"]
          .includes(value.origin))) fail("INVALID_FORMAT");
  return freeze(copy(value));
}
function validateGuard(value) {
  version(value, [1]);
  if (!exact(value, ["version", "state", "deletionId",
    "startedAt", "retainUntil"]) || !isId(value.deletionId) ||
      !time(value.startedAt) ||
      !((value.state === "IN_PROGRESS" && value.retainUntil === null) ||
        (value.state === "COMPLETE" && time(value.retainUntil) &&
          after(value.retainUntil, value.startedAt)))) fail("INVALID_FORMAT");
  return freeze(copy(value));
}
function validateBirth(value, binding) {
  validateBinding(binding);
  version(value, [1]);
  if (!exact(value, BIRTH_KEYS) || value.tenantId !== null ||
      value.sourceType !== "FIREBASE_AUTH_CREATE" ||
      value.status !== "RECORDED_COHORT_CLOSED" ||
      !isId(value.decisionId) || !text(value.sourceEventId, 512) ||
      !time(value.authCreatedAt) || !time(value.eventAt) ||
      !time(value.recordedAt) || after(value.authCreatedAt, value.eventAt) ||
      after(value.eventAt, value.recordedAt)) fail("INVALID_FORMAT");
  if (value.uid !== binding.uid || value.projectId !== binding.projectId) {
    fail("BINDING_CONFLICT");
  }
  const cohort = value.cohort;
  const identity = value.originalIdentity;
  if (!exact(cohort, ["version", "id", "policy", "state", "cutoverAt"]) ||
      cohort.version !== 1 || !uid(cohort.id) ||
      cohort.policy !== "NEW_ACCOUNT_V2_ONLY" || cohort.state !== "CLOSED" ||
      !time(cohort.cutoverAt) || after(cohort.cutoverAt, value.authCreatedAt) ||
      !exact(identity, ["uid", "email", "displayName", "photoUrl"]) ||
      identity.uid !== binding.uid || !text(identity.email, 320, true) ||
      !text(identity.displayName, 200) ||
      !(identity.photoUrl === null || text(identity.photoUrl, 2048, true))) {
    fail("INVALID_FORMAT");
  }
  return freeze(copy(value));
}
function validateControl(value, binding) {
  validateBinding(binding);
  version(value, [1]);
  if (!exact(value, CONTROL_KEYS) || !isId(value.deletionId) ||
      !["IN_PROGRESS", "COMPLETE", "REVIEW_REQUIRED"].includes(value.state) ||
      !["PRE_AUTH", "AUTH_EVENT", "LEGACY_REVIEW"].includes(value.origin) ||
      !(value.origin === "AUTH_EVENT" ?
        text(value.sourceEventId, 512) : value.sourceEventId === null)) {
    fail("INVALID_FORMAT");
  }
  for (const key of BINDING_KEYS) {
    if (value[key] !== binding[key]) fail("BINDING_CONFLICT");
  }
  if (value.state === "REVIEW_REQUIRED") {
    if (value.scope !== null || value.completedAt !== null) {
      fail("INVALID_FORMAT");
    }
  } else {
    const scope = value.scope;
    if (value.origin === "LEGACY_REVIEW" || !exact(scope, SCOPE_KEYS) ||
        scope.policyVersion !== POLICY || !time(scope.guardStartedAt) ||
        !((scope.birthDecisionId === null && scope.birthDigest === null) ||
          (isId(scope.birthDecisionId) && isHash(scope.birthDigest)))) {
      fail("INVALID_FORMAT");
    }
    if (scope.privateRoot !== "users/" + binding.uid ||
        scope.billingAccountHash !==
        createHash("sha256").update(binding.uid).digest("hex")) {
      fail("SCOPE_CONFLICT");
    }
    if (!(value.state === "IN_PROGRESS" ? value.completedAt === null :
      time(value.completedAt) &&
      !after(scope.guardStartedAt, value.completedAt))) fail("INVALID_FORMAT");
  }
  return freeze(copy(value));
}
function immutable(value) {
  return CONTROL_KEYS.filter((key) =>
    !["state", "completedAt"].includes(key)).map((key) => value[key]);
}
function outcome(status) {
  return Object.freeze({status, destructiveAuthority: false});
}
function unpack(read) {
  if (exact(read, ["state"]) && read.state === "ABSENT") return null;
  if (exact(read, ["state"]) && read.state === "UNAVAILABLE") {
    fail("READ_UNAVAILABLE");
  }
  if (!exact(read, ["state", "value"]) || read.state !== "PRESENT" ||
      read.value === undefined || read.value === null) fail("READ_AMBIGUOUS");
  return read.value;
}
// Pure classification grants no cleanup authority and mutates no input.
function classify(binding, reads, expected = null) {
  try {
    validateBinding(binding);
    if (!exact(reads, ["reservation", "guard", "birth", "operation"])) {
      fail("READ_AMBIGUOUS");
    }
    const r = unpack(reads.reservation);
    const g = unpack(reads.guard);
    const b = unpack(reads.birth);
    const o = unpack(reads.operation);
    if (r) validateReservation(r);
    if (g) validateGuard(g);
    if (b) validateBirth(b, binding);
    if (!o) {
      if (expected) return outcome("OPERATION_MISSING");
      if (g) return outcome("LEGACY_GUARD");
      if (r) return outcome("LEGACY_RESERVATION");
      return outcome("ABSENT");
    }
    validateControl(o, binding);
    if (expected) {
      validateControl(expected, binding);
      if (!same(immutable(o), immutable(expected))) {
        fail("OPERATION_CONFLICT");
      }
    }
    if (r && (r.version !== 2 || r.deletionId !== o.deletionId ||
        r.origin !== o.origin)) fail("OPERATION_CONFLICT");
    if (g && g.deletionId !== o.deletionId) fail("OPERATION_CONFLICT");
    if (o.state === "REVIEW_REQUIRED") return outcome("REVIEW_REQUIRED");
    if (g && !same(g.startedAt, o.scope.guardStartedAt)) {
      fail("SCOPE_CONFLICT");
    }
    if (b && (b.decisionId !== o.scope.birthDecisionId ||
        digest(b) !== o.scope.birthDigest)) fail("SCOPE_CONFLICT");
    if (o.state === "COMPLETE") {
      if (g && g.state !== "COMPLETE") fail("OPERATION_CONFLICT");
      return outcome("COMPLETE");
    }
    if (!g) return outcome("ACTIVE_GUARD_MISSING");
    if (!r) return outcome("ACTIVE_RESERVATION_MISSING");
    if (g.state !== "IN_PROGRESS") fail("OPERATION_CONFLICT");
    return outcome("IN_PROGRESS");
  } catch (error) {
    return outcome(error instanceof DeletionControlError ?
      error.code : "READ_AMBIGUOUS");
  }
}
function references(db, binding) {
  validateBinding(binding);
  if (!db || db.projectId !== binding.projectId ||
      db.databaseId !== binding.databaseId || typeof db.doc !== "function") {
    fail("STORE_BINDING_CONFLICT");
  }
  const result = {
    reservation: db.doc("retired_auth_identities/" + binding.uid),
    guard: db.doc("account_deletion_guards/" + binding.uid),
    birth: db.doc("account_birth_decisions/" + binding.uid),
    operation: db.doc("account_deletion_guards/" + binding.uid +
      "/control/operation"),
    privateRoot: db.doc("users/" + binding.uid),
  };
  return Object.freeze(result);
}
async function snapshotRead(tx, ref) {
  try {
    const snapshot = await tx.get(ref);
    if (!snapshot || typeof snapshot.exists !== "boolean" ||
        !snapshot.ref || snapshot.ref.path !== ref.path ||
        typeof snapshot.data !== "function") fail("READ_AMBIGUOUS");
    const value = snapshot.data();
    if (!snapshot.exists) {
      if (value !== undefined) fail("READ_AMBIGUOUS");
      return {state: "ABSENT"};
    }
    if (value === undefined || value === null) fail("READ_AMBIGUOUS");
    return {state: "PRESENT", value: copy(value)};
  } catch (error) {
    if (error instanceof DeletionControlError) throw error;
    fail("READ_UNAVAILABLE");
  }
}
/*
 * Trusted server factory ONLY. Ports must attest real boundaries in R6B.
 * No request/body input, ADC, Admin App,
     Auth deletion or data cleaner is wired.
 * Clock/UUID are pure local suppliers; no external IO belongs in a transaction.
 */
function createController(options) {
  if (!exact(options, ["db", "binding", "clock", "uuid", "ports"]) ||
      typeof options.clock !== "function" ||
      typeof options.uuid !== "function" || !plain(options.ports) ||
          !options.db ||
      typeof options.db.runTransaction !== "function") fail("INVALID_CONFIG");
  const binding = validateBinding(options.binding);
  const db = options.db;
  const clock = options.clock;
  const generateId = options.uuid;
  const refs = references(db, binding);
  const ports = Object.freeze(Object.assign({}, options.ports));
  const handles = new WeakMap();
  const cleanups = new WeakMap();
  let pending = null;
  function noArgs(args) {
    if (args.length) fail("UNEXPECTED_INPUT");
  }
  function now() {
    try {
      const value = clock();
      if (!time(value)) fail("INVALID_CLOCK");
      return new Timestamp(value.seconds, value.nanoseconds);
    } catch (_) {
      fail("INVALID_CLOCK");
    }
  }
  function nextId() {
    try {
      const value = generateId();
      if (!isId(value)) fail("INVALID_ID");
      return value;
    } catch (_) {
      fail("INVALID_ID");
    }
  }
  async function invoke(name, context) {
    if (typeof ports[name] !== "function") fail("BOUNDARY_UNAVAILABLE");
    try {
      return await ports[name](freeze(copy(context)));
    } catch (_) {
      fail("BOUNDARY_UNAVAILABLE");
    }
  }
  function attest(value, keys, context) {
    if (!exact(value, keys)) fail("BOUNDARY_REFUSED");
    for (const key of Object.keys(context)) {
      if (!same(value[key], context[key])) fail("BOUNDARY_REFUSED");
    }
  }
  async function authState() {
    if (typeof ports.getAuthUser !== "function") fail("AUTH_UNAVAILABLE");
    let user;
    try {
      user = await ports.getAuthUser(binding.uid);
    } catch (error) {
      if (error && error.code === "auth/user-not-found") return "ABSENT";
      fail("AUTH_UNAVAILABLE");
    }
    if (!user || user.uid !== binding.uid ||
        (user.tenantId !== undefined && user.tenantId !== null)) {
      fail("AUTH_AMBIGUOUS");
    }
    if (user.disabled === true) fail("AUTH_AMBIGUOUS");
    return "PRESENT";
  }
  async function read(tx) {
    const result = {};
    for (const key of ["operation", "guard", "reservation", "birth"]) {
      result[key] = await snapshotRead(tx, refs[key]);
    }
    return result;
  }
  async function inspect(...args) {
    noArgs(args);
    try {
      return await db.runTransaction(async (tx) => {
        const reads = await read(tx);
        return classify(binding, reads);
      });
    } catch (error) {
      if (error instanceof DeletionControlError) throw error;
      fail("READ_UNAVAILABLE");
    }
  }
  function handleFor(operation, status) {
    const handle = Object.freeze({kind: "ORIGINAL_OPERATION"});
    handles.set(handle, validateControl(operation, binding));
    return Object.freeze({status, destructiveAuthority: false, handle});
  }
  function requireHandle(map, handle) {
    if (!handle || !map.has(handle)) fail("INVALID_CAPABILITY");
    return map.get(handle);
  }
  function accepted(reads, evidence) {
    const state = classify(binding, reads);
    if (!["IN_PROGRESS", "COMPLETE",
      "REVIEW_REQUIRED"].includes(state.status)) {
      fail(state.status);
    }
    const operation = reads.operation.value;
    if (evidence.kind === "PRE_AUTH" && operation.origin !== "PRE_AUTH") {
      fail("BOUNDARY_REFUSED");
    }
    if (evidence.kind === "AUTH_EVENT") {
      if (evidence.association === "ORIGINAL_OPERATION" &&
          evidence.deletionId !== operation.deletionId) fail("EVENT_CONFLICT");
      if (evidence.association === "REVIEW") return outcome("REVIEW_REQUIRED");
      if (operation.origin === "AUTH_EVENT") {
        if (operation.sourceEventId !== evidence.eventId) {
          fail("EVENT_CONFLICT");
        }
      } else if (evidence.association !== "ORIGINAL_OPERATION" ||
          evidence.deletionId !== operation.deletionId) {
        fail("EVENT_CONFLICT");
      }
    }
    if (state.status === "REVIEW_REQUIRED") return state;
    return handleFor(operation, state.status === "COMPLETE" ?
      "COMPLETE" : "RESUMED");
  }
  async function reconcilePending() {
    let recovered;
    try {
      recovered = await db.runTransaction(async (tx) => {
        const reads = await read(tx);
        const state = classify(binding, reads, pending);
        if (!["IN_PROGRESS", "COMPLETE", "REVIEW_REQUIRED"]
            .includes(state.status)) fail("COMMIT_OUTCOME_UNKNOWN");
        return state.status === "IN_PROGRESS" ?
          handleFor(reads.operation.value, "ADMITTED_RECHECKED") : state;
      });
    } catch (_) {
      fail("COMMIT_OUTCOME_UNKNOWN");
    }
    pending = null;
    return recovered;
  }
  async function admission(evidence) {
    if (pending) return reconcilePending();
    let initial;
    try {
      initial = await db.runTransaction(read);
    } catch (_) {
      fail("READ_UNAVAILABLE");
    }
    const initialState = classify(binding, initial);
    if (initialState.status !== "ABSENT") return accepted(initial, evidence);
    if (evidence.association === "ORIGINAL_OPERATION") {
      fail("OPERATION_MISSING");
    }
    const requiredAuth = evidence.kind === "PRE_AUTH" ? "PRESENT" : "ABSENT";
    if (await authState() !== requiredAuth) fail("AUTH_STATE_CONFLICT");
    const startedAt = now();
    const deletionId = nextId();
    const review = evidence.association === "REVIEW";
    const birth = unpack(initial.birth);
    const scope = review ? null : {
      policyVersion: POLICY, privateRoot: "users/" + binding.uid,
      guardStartedAt: startedAt,
      billingAccountHash: createHash("sha256").update(binding.uid)
          .digest("hex"),
      birthDecisionId: birth ? birth.decisionId : null,
      birthDigest: birth ? digest(birth) : null,
    };
    const operation = validateControl(Object.assign({}, binding, {
      version: 1, deletionId, state: review ? "REVIEW_REQUIRED" : "IN_PROGRESS",
      origin: evidence.kind, sourceEventId: evidence.eventId || null,
      scope, completedAt: null,
    }), binding);
    try {
      return await db.runTransaction(async (tx) => {
        const reads = await read(tx);
        // Bind the private root read to the admission commit as required by R5.
        // Its presence or absence is not an authorization or generation proof.
        await snapshotRead(tx, refs.privateRoot);
        const state = classify(binding, reads);
        if (state.status !== "ABSENT") return accepted(reads, evidence);
        if (!same(reads.birth, initial.birth)) fail("SCOPE_CONFLICT");
        if (ports.admissionTransaction !== undefined) {
          if (typeof ports.admissionTransaction !== "function") {
            fail("BOUNDARY_REFUSED");
          }
          // Transaction-only server preflight. No Auth, network or mutations.
          try {
            await ports.admissionTransaction(
                Object.freeze({get: tx.get.bind(tx)}), freeze(copy(operation)));
          } catch (error) {
            if (error && error.code === "CIRCLE_ADMIN_ACTION_REQUIRED") {
              fail("CIRCLE_ADMIN_ACTION_REQUIRED");
            }
            if (error && error.code === "ACCOUNT_STATE_CONFLICT") fail("SCOPE_CONFLICT");
            fail("READ_UNAVAILABLE");
          }
        }
        let receipt;
        if (ports.admissionReceipt !== undefined) {
          if (review || operation.origin !== "PRE_AUTH" || typeof ports.admissionReceipt !== "function") {
            fail("BOUNDARY_REFUSED");
          }
          receipt = await ports.admissionReceipt(Object.freeze({get: tx.get.bind(tx)}), operation);
          if (!receipt || receipt.deletionId !== deletionId || receipt.uid !== binding.uid ||
              receipt.projectId !== binding.projectId || receipt.databaseId !== binding.databaseId) {
            fail("BOUNDARY_REFUSED");
          }
        }
        const reservation = {version: 2, state: "RESERVED", deletionId,
          origin: operation.origin};
        const guard = {version: 1, state: "IN_PROGRESS", deletionId,
          startedAt, retainUntil: null};
        tx.create(refs.reservation, reservation);
        if (!review) tx.create(refs.guard, guard);
        tx.create(refs.operation, operation);
        if (receipt) tx.create(refs.guard.collection("control").doc("receipt"), receipt);
        return review ? outcome("REVIEW_REQUIRED") :
          handleFor(operation, "ADMITTED");
      });
    } catch (error) {
      if (error instanceof DeletionControlError) throw error;
      pending = operation;
      return reconcilePending();
    }
  }
  async function admitBackend(...args) {
    noArgs(args);
    const subject = await invoke("getAuthenticatedSubject", binding);
    attest(subject, BINDING_KEYS, binding);
    return admission({kind: "PRE_AUTH"});
  }
  async function admitManagedEvent(...args) {
    noArgs(args);
    const event = await invoke("getManagedEvent", binding);
    attest(event, BINDING_KEYS.concat(["eventId", "association", "deletionId"]),
        binding);
    if (!text(event.eventId, 512) ||
        !["NEW_POLICY", "ORIGINAL_OPERATION", "REVIEW"]
            .includes(event.association) ||
        !(event.association === "ORIGINAL_OPERATION" ?
          isId(event.deletionId) : event.deletionId === null)) {
      fail("BOUNDARY_REFUSED");
    }
    return admission(Object.assign({}, event, {kind: "AUTH_EVENT"}));
  }
  async function resumeOriginal(...args) {
    noArgs(args);
    const subject = await invoke("getContinuation", binding);
    attest(subject, BINDING_KEYS.concat(["deletionId"]), binding);
    if (!isId(subject.deletionId)) fail("BOUNDARY_REFUSED");
    try {
      return await db.runTransaction(async (tx) => {
        const reads = await read(tx);
        const state = classify(binding, reads);
        if (!reads.operation.value ||
            reads.operation.value.deletionId !== subject.deletionId) {
          fail("OPERATION_CONFLICT");
        }
        if (state.status !== "IN_PROGRESS") {
          if (["COMPLETE", "REVIEW_REQUIRED"].includes(state.status)) {
            return state;
          }
          fail(state.status);
        }
        return handleFor(reads.operation.value, "RESUMED");
      });
    } catch (error) {
      if (error instanceof DeletionControlError) throw error;
      fail("READ_UNAVAILABLE");
    }
  }
  async function checkOperation(tx, operation) {
    const reads = await read(tx);
    const state = classify(binding, reads, operation);
    if (state.status !== "IN_PROGRESS") fail(state.status);
    return reads;
  }
  async function continueOperation(handle) {
    if (arguments.length !== 1) fail("UNEXPECTED_INPUT");
    const operation = requireHandle(handles, handle);
    try {
      return await db.runTransaction(async (tx) => {
        const reads = await read(tx);
        const state = classify(binding, reads, operation);
        if (state.status === "IN_PROGRESS") return outcome("IN_PROGRESS");
        if (["COMPLETE",
          "REVIEW_REQUIRED"].includes(state.status)) return state;
        fail(state.status);
      });
    } catch (error) {
      if (error instanceof DeletionControlError) throw error;
      fail("READ_UNAVAILABLE");
    }
  }
  async function authorizeCleanup(handle) {
    if (arguments.length !== 1) fail("UNEXPECTED_INPUT");
    const operation = requireHandle(handles, handle);
    const context = Object.assign({}, binding,
        {deletionId: operation.deletionId});
    const authorized = await invoke("authorizeCleanup", context);
    attest(authorized, BINDING_KEYS.concat(["deletionId"]), context);
    if (await authState() !== "ABSENT") fail("AUTH_STATE_CONFLICT");
    try {
      await db.runTransaction((tx) => checkOperation(tx, operation));
    } catch (error) {
      if (error instanceof DeletionControlError) throw error;
      fail("READ_UNAVAILABLE");
    }
    const cleanup = Object.freeze({kind: "ORIGINAL_CLEANUP_SCOPE"});
    cleanups.set(cleanup, operation);
    return cleanup;
  }
  async function assertCleanupTransaction(tx, cleanup) {
    if (arguments.length !== 2) fail("UNEXPECTED_INPUT");
    await checkOperation(tx, requireHandle(cleanups, cleanup));
    return outcome("CLEANUP_SCOPE_REVALIDATED");
  }
  function proof(value, context) {
    attest(value, Object.keys(context).concat(
        ["privateTreeEmpty", "externalResourcesEmpty"]), context);
    if (value.privateTreeEmpty !== true ||
        value.externalResourcesEmpty !== true) fail("TERMINAL_NOT_PROVEN");
  }
  async function terminalTransaction(tx, operation, removeOriginal = false) {
    const reads = await read(tx);
    const state = classify(binding, reads, operation);
    if (!["IN_PROGRESS", "COMPLETE"].includes(state.status)) {
      fail(state.status);
    }
    const root = await snapshotRead(tx, refs.privateRoot);
    if (root.state !== "ABSENT") fail("TERMINAL_RESIDUE");
    const originalBirthPresent = reads.birth.state === "PRESENT";
    // classify() has already validated the exact original decision/digest.
    // COMPLETE is always read-only, even if the original ledger reappears.
    if (originalBirthPresent &&
        (!removeOriginal || state.status === "COMPLETE" ||
         operation.scope.birthDecisionId === null)) {
      fail("BIRTH_REMOVAL_REQUIRED");
    }
    const context = Object.assign({}, binding,
        {deletionId: operation.deletionId, scope: copy(operation.scope)});
    if (typeof ports.terminalTransaction !== "function") {
      fail("TERMINAL_NOT_PROVEN");
    }
    // This injected port is transaction-only. It gets no mutation methods.
    // Backend adapters must execute the real terminal queries through it.
    const reader = Object.freeze({get: tx.get.bind(tx)});
    let evidence;
    try {
      evidence = await ports.terminalTransaction(reader, freeze(copy(context)));
    } catch (_) {
      fail("TERMINAL_NOT_PROVEN");
    }
    proof(evidence, context);
    return Object.assign({}, state, {originalBirthPresent});
  }
  async function finalizeInternal(cleanup, removeOriginal) {
    const operation = requireHandle(cleanups, cleanup);
    if (await authState() !== "ABSENT") fail("AUTH_STATE_CONFLICT");
    const context = Object.assign({}, binding,
        {deletionId: operation.deletionId, scope: copy(operation.scope)});
    proof(await invoke("terminalInventory", context), context);
    const completedAt = now();
    if (after(operation.scope.guardStartedAt, completedAt)) {
      fail("INVALID_CLOCK");
    }
    try {
      return await db.runTransaction(async (tx) => {
        const state = await terminalTransaction(tx, operation, removeOriginal);
        if (state.status === "COMPLETE") return outcome("COMPLETE_RECHECKED");
        if (state.originalBirthPresent) tx.delete(refs.birth);
        tx.update(refs.guard, {state: "COMPLETE",
          retainUntil: Timestamp.fromMillis(
              completedAt.toMillis() + RETENTION_MS)});
        tx.update(refs.operation, {state: "COMPLETE", completedAt});
        return outcome("COMPLETE");
      });
    } catch (error) {
      if (error instanceof DeletionControlError) throw error;
      // Resolve uncertain completion by a fresh read-only proof, never a write.
      try {
        return await db.runTransaction(async (tx) => {
          const state = await terminalTransaction(tx, operation);
          if (state.status !== "COMPLETE") fail("COMMIT_OUTCOME_UNKNOWN");
          return outcome("COMPLETE_RECHECKED");
        });
      } catch (_) {
        fail("COMMIT_OUTCOME_UNKNOWN");
      }
    }
  }
  function originalOperation(handle) {
    return requireHandle(handles, handle);
  }
  async function assertOperationTransaction(tx, handle) {
    await checkOperation(tx, requireHandle(handles, handle));
    return outcome("ORIGINAL_OPERATION_REVALIDATED");
  }
  async function verifyTerminal(handle) {
    const operation = requireHandle(handles, handle);
    if (await authState() !== "ABSENT") fail("AUTH_STATE_CONFLICT");
    const context = Object.assign({}, binding,
        {deletionId: operation.deletionId, scope: copy(operation.scope)});
    proof(await invoke("terminalInventory", context), context);
    try {
      return await db.runTransaction(async (tx) => {
        const state = await terminalTransaction(tx, operation);
        if (state.status !== "COMPLETE") fail("TERMINAL_NOT_PROVEN");
        return outcome("COMPLETE_RECHECKED");
      });
    } catch (error) {
      if (error instanceof DeletionControlError) throw error;
      fail("READ_UNAVAILABLE");
    }
  }
  async function finalize(cleanup) {
    if (arguments.length !== 1) fail("UNEXPECTED_INPUT");
    return finalizeInternal(cleanup, false);
  }
  async function finalizeWithOriginalLedger(cleanup) {
    if (arguments.length !== 1) fail("UNEXPECTED_INPUT");
    return finalizeInternal(cleanup, true);
  }
  return Object.freeze({inspect, admitBackend, admitManagedEvent,
    resumeOriginal, continueOperation, authorizeCleanup,
    assertCleanupTransaction, finalize, finalizeWithOriginalLedger,
    originalOperation, assertOperationTransaction, verifyTerminal});
}

// Normal writers get no cleanup handle, authority or state transition. Presence
// of ANY control is deny-only, including legacy/malformed/expired documents.
// Missing snapshots are read in the mutation transaction on every SDK retry.
async function assertNormalWriterTransaction(transaction, db, accountUid) {
  try {
    if (!uid(accountUid) || !db || typeof db.collection !== "function" ||
        !transaction || typeof transaction.get !== "function") {
      fail("ACCOUNT_DELETION_BLOCKED");
    }
    const guard = db.collection("account_deletion_guards").doc(accountUid);
    const retired = db.collection("retired_auth_identities").doc(accountUid);
    const operation = guard.collection("control").doc("operation");
    for (const ref of [guard, retired, operation]) {
      const snapshot = await transaction.get(ref);
      if (!snapshot || snapshot.exists !== false ||
          typeof snapshot.data !== "function" || snapshot.data() !== undefined) {
        fail("ACCOUNT_DELETION_BLOCKED");
      }
    }
    await trustedAccount.assertWriterTransaction(transaction, db, accountUid);
  } catch (_) {
    // Neither a read error nor an unknown snapshot is evidence of absence.
    fail("ACCOUNT_DELETION_BLOCKED");
  }
}
function withNormalWriterTransactions(db, accountUid) {
  if (!uid(accountUid) || !db || typeof db.collection !== "function" ||
      typeof db.runTransaction !== "function") fail("ACCOUNT_DELETION_BLOCKED");
  return Object.freeze({collection: db.collection.bind(db),
    runTransaction: (callback, ...options) => db.runTransaction(async transaction => {
      await assertNormalWriterTransaction(transaction, db, accountUid);
      return callback(transaction);
    }, ...options)});
}

module.exports = {DeletionControlError, references, validateBinding,
  assertNormalWriterTransaction, withNormalWriterTransactions,
  validateReservation, validateGuard, validateBirth, validateControl,
  classify, createController};
