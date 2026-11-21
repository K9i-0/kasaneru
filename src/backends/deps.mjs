// Where esbuild looks for packages a scene imports but does not have next to it (react, react-dom, three and the like):
// kasaneru's own dependencies. In a clone they are in kasaneru/node_modules. Installed from npm they are usually hoisted
// to the node_modules that contains kasaneru itself (npx and local installs), so look there as well.
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const parent = path.dirname(PACKAGE_DIR);
export const DEPENDENCY_PATHS = [path.join(PACKAGE_DIR, 'node_modules'), ...(path.basename(parent) === 'node_modules' ? [parent] : [])];
