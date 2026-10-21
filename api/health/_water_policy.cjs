"use strict";
// Opening this policy requires independent P1/IAM and writer-fence evidence.
// Neither environment variables nor HTTP payloads select a cohort.
const WATER_COHORT = Object.freeze({
  version: 1, id: "android-initial", projectId: "life-os-27b92",
  policy: "NEW_ACCOUNT_V2_ONLY", state: "CLOSED", cutoverMillis: null,
  administrativePolicyVerified: false, writerFencesVerified: false,
});
/**
 * @param {Object} value Server-owned policy.
 * @param {string} projectId Effective Firestore project.
 * @return {Object} Approved immutable policy.
 */
function requireOpenCohort(value, projectId) {
  if (!value || value.version !== 1 || value.policy !== "NEW_ACCOUNT_V2_ONLY" ||
      value.state !== "OPEN" || value.projectId !== projectId ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(value.id) ||
      !Number.isSafeInteger(value.cutoverMillis) || value.cutoverMillis <= 0 ||
      value.administrativePolicyVerified !== true ||
      value.writerFencesVerified !== true) {
    const error = new Error("Coorte de hidratação indisponível.");
    error.code = "WATER_COHORT_CLOSED";
    throw error;
  }
  return Object.freeze({...value});
}
module.exports = {WATER_COHORT, requireOpenCohort};
