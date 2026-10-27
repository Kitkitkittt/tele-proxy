import { assertNativePolicySupported, bindDispatchContext, dispatchGeneration } from "../../services/dispatchContext.js";

const CONVERSATION_REQUEST = /^https:\/\/chatgpt\.com\/(?:backend-api\/)?f\/conversation(?:\?|$)/;

/** Gate only the generation POST; prepare, uploads, auth, polls, and downloads bypass this route. */
export async function dispatchChatGptBrowserGeneration(page, signal, submit) {
  const details = { transport: "browser-chatgpt", policySupported: false, ...(signal ? { signal } : {}) };
  assertNativePolicySupported(details);
  let dispatchError;
  const handler = bindDispatchContext(async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    try {
      return await dispatchGeneration(details, () => route.continue());
    } catch (error) {
      dispatchError = error;
      await route.abort("failed").catch(() => {});
    }
  });
  await page.route(CONVERSATION_REQUEST, handler);
  try {
    const result = await submit();
    if (dispatchError) throw dispatchError;
    return result;
  } catch (error) {
    throw dispatchError || error;
  } finally {
    await page.unroute(CONVERSATION_REQUEST, handler);
  }
}
