# Shared Package Subpaths

`@open-inspect/shared` exposes concept-named subpaths so consumers can declare the specific shared
interface they use. The package root remains a compatibility facade while consumers migrate.

## Ownership rules

1. Name a subpath after one stable domain concept.
2. Keep a schema, its inferred type, and the functions that enforce its invariants together.
3. Use the `session/*` family for independently changing session protocols.
4. Do not introduce generic `types`, `utils`, or `contract(s)` subpaths.
5. A shallow interface is acceptable when an existing cohesive module already owns the concept. Do
   not invent a domain name solely to relocate an orphan helper.
6. Implementation modules import their concrete owner modules directly. They never import the
   package root, a package subpath specifier, or a composite entry point under `src/subpaths`.

The authoritative list of supported paths is the `exports` map in `package.json`. Composite subpaths
use named re-exports under `src/subpaths`; cohesive source modules are exported directly. Adding or
changing a subpath requires building the package and compiling a representative consumer against the
resulting export map.
