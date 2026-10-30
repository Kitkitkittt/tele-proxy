import { AsyncLocalStorage } from "node:async_hooks";

const dispatchStorage = globalThis[Symbol.for("tele-proxy.dispatchStorage")] ||= new AsyncLocalStorage();

export function getDispatchContext() {
  return dispatchStorage.getStore()?.context ?? null;
}

/** Preserve request metadata for browser protocol callbacks created outside Node's async chain. */
export function bindDispatchContext(callback) {
  const store = dispatchStorage.getStore();
  return (...args) => dispatchStorage.run(store, () => callback(...args));
}

/** Preserve native routes without inventing attempts where no trustworthy wire boundary exists. */
export function reportUnsupportedDispatch(details) {
  const store = dispatchStorage.getStore();
  if (!store?.context) return;
  // Observability must not prevent inference, including an unavailable reporting sink.
  try {
    const result = store.context.markDispatchUnsupported?.({ ...store.details, ...details });
    result?.catch?.(() => {});
  } catch { }
}

/** Run one logical request. execute(details, send) must invoke send once and return its result. */
export function withDispatchContext(context, callback) {
  if (context != null && typeof context.execute !== "function") {
    throw new TypeError("Dispatch context requires execute(details, send)");
  }
  return dispatchStorage.run({ context, details: {}, generation: false, physical: false }, callback);
}

/** Attach selected executor metadata without treating auth/bootstrap/poll traffic as generation. */
export function withDispatchMetadata(details, callback) {
  const store = dispatchStorage.getStore();
  if (!store?.context) return callback();
  return dispatchStorage.run({ ...store, details: { ...store.details, ...details } }, callback);
}

/** Mark only a generation transport call; its physical retries are counted by proxyFetch.
 * Use this around a send that goes through the patched global `fetch`. Wrapping the
 * send in `dispatchGeneration` instead marks the callback physical, which suppresses
 * proxyFetch's own hook and hides a proxy→direct fallback or TLS retry from the ledger.
 */
export function withGenerationDispatch(details, callback) {
  const store = dispatchStorage.getStore();
  if (!store?.context) return callback();
  const merged = { ...store.details, ...details };
  assertNativePolicySupported(merged);
  return dispatchStorage.run({ ...store, details: merged, generation: true }, callback);
}

/** Fail closed when an adapter cannot represent the required policy on the wire. */
export function assertNativePolicySupported(details = {}) {
  const context = dispatchStorage.getStore()?.context;
  if (!context) return;
  if (context.requiredPolicy === true && details.policySupported === false) {
    const error = new Error("Required policy is not supported by this provider transport");
    error.name = "RequiredPolicyError";
    error.code = "REQUIRED_POLICY_UNSUPPORTED";
    error.status = 422;
    throw error;
  }
  if (details.policySupported === false) context.markPolicyUnsupported?.(details);
  context.assertPolicySupported?.(details);
}

/** Wrap one physical inference send. Nested direct-fetch adapters cannot count it twice.
 * Results may be Response, { response }, or native results; native usage remains unknown
 * unless the integration observes a decoded Response later. Never buffer streams here.
 */
export function dispatchGeneration(details, callback) {
  const store = dispatchStorage.getStore();
  if (!store?.context || store.physical) return callback();
  const merged = { ...store.details, ...details };
  merged.signal ??= store.details?.signal ?? store.context.signal;
  assertNativePolicySupported(merged);
  merged.signal?.throwIfAborted?.();
  const quiet = { ...store, generation: false };
  return dispatchStorage.run(quiet, () => store.context.execute(merged, () =>
    dispatchStorage.run({ ...quiet, physical: true }, callback)
  ));
}

/** Low-level fetch hook: unrelated network operations are never inferred from URL or method. */
export function dispatchPhysicalFetch(details, callback) {
  const store = dispatchStorage.getStore();
  if (!store?.generation || store.physical) return callback();
  return dispatchGeneration(details, callback);
}
