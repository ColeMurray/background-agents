# Shared Package Interfaces

`@open-inspect/shared` exposes concept-named interfaces so consumers can declare the specific shared
capability they use. The package root remains a compatibility facade while consumers migrate.

## Ownership rules

1. Name an interface after one stable domain concept.
2. Keep a schema, its inferred type, and the functions that enforce its invariants together.
3. Use the `session/*` family for independently changing session protocols.
4. Do not introduce generic `types`, `utils`, or `contract(s)` interfaces.
5. A shallow interface is acceptable when an existing cohesive module already owns the concept. Do
   not invent a domain name solely to relocate an orphan helper.
6. Implementation modules import their concrete owner modules directly. They never import the
   package root or a composite public interface.

The authoritative list of supported import paths is the `exports` map in `package.json`. Composite
interfaces live in their domain directories; cohesive source modules are exported directly. Adding
or changing an interface requires building the package and compiling a representative consumer
against the resulting export map.
