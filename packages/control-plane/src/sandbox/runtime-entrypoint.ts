/**
 * Compatibility shim for images whose runtime still reads SANDBOX_VERSION.
 * The value comes from the installed image, never the worker's current manifest.
 * This contains no session data or secrets and is safe on provider-logged argv.
 */
export const IMAGE_RUNTIME_ENTRYPOINT = [
  "import importlib,importlib.util,os,runpy",
  'manifest=importlib.import_module("sandbox_runtime.runtime_manifest") if importlib.util.find_spec("sandbox_runtime.runtime_manifest") else None',
  'os.environ["SANDBOX_VERSION"]=getattr(manifest,"RUNTIME_VERSION","")',
  'runpy.run_module("sandbox_runtime.entrypoint",run_name="__main__")',
].join(";");
