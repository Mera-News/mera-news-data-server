// Lets Node run the repository's shared TypeScript files as they are. Their
// relative imports carry no extension, their packages are installed in this
// folder rather than at the repository root, and some use TypeScript that Node
// cannot strip (parameter properties, decorators), so those are compiled on load.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const localParent = pathToFileURL(fileURLToPath(new URL('package.json', root))).href;
const { transformSync } = createRequire(import.meta.url)('esbuild');

const outside = (url) => url.startsWith('file:') && !fileURLToPath(url).startsWith(rootPath);
// The full server's own alias for its shared library, as the bundle maps it.
const SHARED_ALIAS = '@mera/shared/';
const sharedRoot = new URL('../libs/mera-shared/src/', root);

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(SHARED_ALIAS)) {
      return next(new URL(`${specifier.slice(SHARED_ALIAS.length)}.ts`, sharedRoot).href, context);
    }
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && !/\.[cm]?[jt]s$|\.json$/.test(specifier) && context.parentURL?.startsWith('file:')) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        const url = new URL(candidate, context.parentURL);
        const path = fileURLToPath(url);
        if (existsSync(path) && statSync(path).isFile()) return next(url.href, context);
      }
    }
    try {
      return next(specifier, context);
    } catch (error) {
      const bare = !relative && !specifier.startsWith('/') && !specifier.includes(':');
      if (!bare || !context.parentURL || !outside(context.parentURL)) throw error;
      return next(specifier, { ...context, parentURL: localParent });
    }
  },
  load(url, context, next) {
    if (url.endsWith('.gql')) {
      return { format: 'module', source: `export default ${JSON.stringify(readFileSync(fileURLToPath(url), 'utf8'))};`, shortCircuit: true };
    }
    if (url.endsWith('.ts') && outside(url)) {
      const path = fileURLToPath(url);
      const { code } = transformSync(readFileSync(path, 'utf8'), {
        loader: 'ts',
        format: 'esm',
        sourcefile: path,
        tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
      });
      return { format: 'module', source: code, shortCircuit: true };
    }
    return next(url, context);
  },
});
