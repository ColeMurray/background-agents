import { MIN_REBUILD_RUNTIME_VERSION } from "./rebuild-policy";

// A runtime the scheduler treats as current: at the rebuild floor, which is
// itself at or above the boot-compatibility floor.
export const COMPATIBLE_RUNTIME_VERSION = `v${MIN_REBUILD_RUNTIME_VERSION}-test-runtime`;
