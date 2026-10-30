export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.TELE_PROXY_ENABLED === "1") {
      const { initializeTeleProxy } = await import("@/lib/teleProxy.js");
      await initializeTeleProxy();
    }
    if (process.env.TELE_PROXY_ENABLED !== "1" && process.env.TELE_PROXY_CANARY !== "1") {
      const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
      initConsoleLogCapture();
    }

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    if (process.env.TELE_PROXY_CANARY !== "1") {
      const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
      startModelCatalogSync();
    }
  }
}
