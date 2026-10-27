// Only the isolated canary fixture subprocess uses this Node ESM resolver.
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve as pathResolve, extname } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function resolve(specifier, context, nextResolve) {
  const relative = specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : specifier.startsWith('open-sse/') ? specifier : null;
  if (relative) return nextResolve(pathToFileURL(pathResolve(root, extname(relative) ? relative : `${relative}.js`)).href, context);
  return nextResolve(specifier, context);
}
