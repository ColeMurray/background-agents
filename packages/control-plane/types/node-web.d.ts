/**
 * Web-standard names the application uses as types and Node implements at
 * runtime, but that @types/node does not declare globally. Only the Node
 * host's program (tsconfig.node.json) loads this file; the workerd programs
 * take these names from workers-types.
 */

type CryptoKey = import("node:crypto").webcrypto.CryptoKey;
type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
type RequestInfo = NonNullable<ConstructorParameters<typeof Request>[0]>;
