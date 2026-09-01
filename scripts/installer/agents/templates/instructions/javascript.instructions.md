---
name: "JavaScript Rules"
description: "Use when writing or reviewing JavaScript or JSX. Covers modules, immutable bindings, validation, asynchronous failures, state, and documentation."
applyTo: "**/*.{js,mjs,cjs,jsx}"
---

# JavaScript Rules

## Naming And Bindings

- **File and folder names:** MUST use `kebab-case`.
- **Classes and React components:** MUST use `PascalCase`.
- **Variables and functions:** MUST use `camelCase`.
- **Unused parameters:** MUST prefix intentionally unused parameters with `_`. MUST NOT use the underscore prefix for any other purpose.
- **Const only:** MUST use `const` for every variable declaration. MUST NOT use `let` or `var`.
  - ✓ `const users = records.map(toUser);`
  - ✗ `let users = records.map(toUser);`

## Modules

- **Module system:** MUST preserve the module system established by the project. MUST NOT mix ESM and CommonJS syntax in the same file.
- **CommonJS strict mode:** CommonJS files MUST begin with a top-level `"use strict"` directive. ESM files and browser module scripts MUST NOT add it solely for strictness.
  - ✓ `"use strict"; const load = require("./load.cjs");`
  - ✗ `import { load } from "./load.js"; const config = require("./config.cjs");`
- **ESM and CommonJS globals:** ESM files MUST NOT use `require`, `exports`, `module.exports`, `__filename`, or `__dirname`.
- **Node built-ins:** Node.js ESM files MUST import built-in modules with the `node:` prefix.
  - ✓ `import { readFile } from "node:fs/promises";`
  - ✗ `import { readFile } from "fs/promises";`
- **Node relative imports:** Node.js ESM files MUST include the file extension in every relative import specifier.
  - ✓ `import { parseConfig } from "./parse-config.js";`
  - ✗ `import { parseConfig } from "./parse-config";`

## Values And State

- **Strict equality:** MUST use `===` and `!==`. MUST NOT use `==` or `!=`.
  - ✓ `if (status === "ready") start();`
  - ✗ `if (status == "ready") start();`
- **External input:** MUST validate every externally sourced value before relying on its type, container shape, required own properties, or numeric range. MUST use `Array.isArray()`, `Number.isFinite()`, and `Number.isSafeInteger()` when they apply.
  - ✓ `if (!Array.isArray(value)) throw new TypeError("Expected an array.");`
  - ✗ `return value.map(parseItem);`
- **Type assertions:** MUST NOT use a JSDoc type assertion to make an untyped or externally sourced value appear valid. Runtime validation MUST establish the returned shape; when normalization is needed, MUST return a newly constructed validated value.
  - ✓ `return { names, records };`
  - ✗ `return /** @type {{ names: string[], records: object[] }} */ (value);`
- **Untrusted keys:** MUST use `Object.hasOwn()` when validating keys on untrusted objects. MUST NOT call an object's `hasOwnProperty()` method.
  - ✓ `if (Object.hasOwn(config, "port")) connect(config.port);`
  - ✗ `if (config.hasOwnProperty("port")) connect(config.port);`
- **Global state:** MUST NOT read undeclared globals or assign native/read-only globals.
- **Caller-owned data:** MUST NOT reassign a parameter or write, delete, or update a property reachable from a parameter. MUST return a new value instead. Locally created objects, arrays, `Map` instances, and `Set` instances are exempt.
  - ✓ `const withUser = (users, user) => [...users, user];`
  - ✗ `const addUser = (users, user) => { users.push(user); return users; };`

## External Effects

- **Explicit external effects:** A function that reads or writes the filesystem, network, process, or process-wide configuration MUST declare every such effect, its target, and its failure behavior in JSDoc. It MUST receive each target explicitly. Functions without a declared external-effect contract MUST NOT perform external effects. External-effect functions MUST NOT mutate their parameters.
  - ✓ `/** Writes content to destPath. @throws If the destination cannot be written. */`
  - ✗ `const save = (path, content) => writeFileSync(path, content);`

## Asynchronous Work And Errors

- **Promise handling:** Every Promise MUST be returned, awaited, or given an explicit rejection handler. MUST NOT use an `async` function as a `new Promise()` executor.
  - ✓ `const config = await readConfig();`
  - ✗ `new Promise(async (resolve) => resolve(await readConfig()));`
- **Recognized failures:** A `catch` block MUST handle only failures it recognizes and MUST rethrow every other failure.
  - ✓ `catch (error) { if (error.code === "ENOENT") return null; throw error; }`
  - ✗ `catch { return null; }`
- **Error translation:** Code that translates an error MUST preserve its original value with `new Error(message, { cause })`.
  - ✓ `throw new Error("Could not load config.", { cause: error });`
  - ✗ `throw new Error("Could not load config.");`
- **Resource cleanup:** Acquired resources MUST be released on every exit path with `try`/`finally`, or with `using`/`await using` when the target runtime supports them.
  - ✓ `try { return await handle.readFile(); } finally { await handle.close(); }`
  - ✗ `return await handle.readFile();`

## File Structure And Documentation

- **Examples:** MUST use generic names and contexts. MUST NOT reference the current repository, its files, paths, modules, products, or domain terminology.
- **Single responsibility:** Each file MUST have one responsibility.
- **Declaration order:** MUST declare dependencies before dependents. Within a related group, callees MUST appear before callers.
- **Public contracts:** Every exported function, class, and non-literal value MUST have JSDoc that describes its contract, inputs, result, and relevant failures. JSDoc MUST match the implemented behavior.
  - ✓ `/** Loads and validates the project configuration. @returns {Promise<object>} The validated configuration. */`
  - ✗ `/** Loads config. */`
- **Comments:** Comments MUST document a non-obvious invariant, constraint, or reason. MUST NOT paraphrase code, record edit history, or be the only enforcement of a runtime contract.
  - ✓ `// The lock is written last so an interrupted install is never recorded as complete.`
  - ✗ `// Write the lock file.`
