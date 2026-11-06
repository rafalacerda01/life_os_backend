"use strict";
// Historical/unproven cohorts remain CLOSED. A ledger/envelope/UID is never
// a substitute for the independent trusted-origin resolver.
const control = require("./_deletion_control.cjs");

const REASON = "AUTHORITATIVE_GENERATION_OWNERSHIP_UNAVAILABLE";
const KEYS = ["version", "projectId", "databaseId", "uid", "state", "reason"];

function refused(code = "ACCOUNT_CLEANUP_REVIEW_REQUIRED") {
  const error = new Error("Account deletion requires authoritative ownership review.");
  error.code = code;
  error.retryable = true;
  return error;
}

function snapshot(value) {
  if (!value || typeof value.exists !== "boolean" ||
      typeof value.data !== "function") throw refused("ACCOUNT_DELETION_BLOCKED");
  const data = value.data();
  if (value.exists ? data === undefined || data === null : data !== undefined) {
    throw refused("ACCOUNT_DELETION_BLOCKED");
  }
  return {exists: value.exists, data};
}

/**
 * Persist refusal only. This API has no grant, resolver injection or activation
 * flag. The extra decision is NOT a proof or cleanup capability. All controls
 * already present (including partial, contradictory or COMPLETE) stay intact.
 */
async function refuseUnprovenAdmission(db, input, origin, sourceEventId = null) {
  const binding = control.validateBinding(input);
  if (db?.projectId !== binding.projectId || db?.databaseId !== binding.databaseId ||
      typeof db.doc !== "function" || typeof db.runTransaction !== "function") {
    throw refused("ACCOUNT_DELETION_BLOCKED");
  }
  if (!["PRE_AUTH", "AUTH_EVENT"].includes(origin) ||
      (origin === "AUTH_EVENT" && (typeof sourceEventId !== "string" || !sourceEventId))) throw refused();
  const base = "account_deletion_guards/" + binding.uid;
  const refs = {reservation: db.doc("retired_auth_identities/" + binding.uid),
    guard: db.doc(base), operation: db.doc(base + "/control/operation"),
    decision: db.doc(base + "/control/admission_review")};
  const decision = {...binding, version: 1, state: "REVIEW_REQUIRED", reason: REASON};
  try {
    await db.runTransaction(async tx => {
      const reservation = snapshot(await tx.get(refs.reservation));
      const guard = snapshot(await tx.get(refs.guard));
      const original = snapshot(await tx.get(refs.operation));
      const previous = snapshot(await tx.get(refs.decision));
      if (previous.exists) {
        const d = previous.data;
        if (!d || Object.keys(d).length !== KEYS.length ||
            !KEYS.every(k => Object.hasOwn(d, k) && d[k] === decision[k])) {
          throw refused("ACCOUNT_DELETION_BLOCKED");
        }
      }
      // Review cannot repair/adopt a partial operation or replace a manifest.
      // No new R5 barrier for an unproven request. An existing operation,
      // reservation or guard still denies writers and is never removed here.
      void reservation; void guard; void original;
      if (!previous.exists) tx.create(refs.decision, decision);
    });
  } catch (_) {
    // Failed/unknown storage cannot grant admission. A committed refusal is
    // reconciled read-only on repetition; no Auth dispatch or scope recapture.
    throw refused("ACCOUNT_DELETION_BLOCKED");
  }
  throw refused();
}

module.exports = {refuseUnprovenAdmission};
