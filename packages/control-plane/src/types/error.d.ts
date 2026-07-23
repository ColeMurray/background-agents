// workerd (V8) provides Error.captureStackTrace at runtime, but
// @cloudflare/workers-types no longer declares it. Declare just this optional
// API rather than adding @types/node to the production type surface: this
// worker has no `nodejs_compat`, so keeping node:*/process/Buffer untyped makes
// accidental Node usage in worker code a typecheck error instead of a runtime
// failure (see tsconfig.json).
interface ErrorConstructor {
  captureStackTrace?(
    targetObject: object,
    constructorOpt?: abstract new (...args: never[]) => unknown
  ): void;
}
