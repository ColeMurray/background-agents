// workerd (V8) provides Error.captureStackTrace at runtime, but
// @cloudflare/workers-types no longer declares it. Declare just this optional
// API rather than adding @types/node to the production type surface. The
// runtime enables `nodejs_compat` for audited dependencies, while keeping
// node:*/process/Buffer untyped here makes accidental application-level Node
// usage a typecheck error (see tsconfig.json).
interface ErrorConstructor {
  captureStackTrace?(
    targetObject: object,
    constructorOpt?: abstract new (...args: never[]) => unknown
  ): void;
}
