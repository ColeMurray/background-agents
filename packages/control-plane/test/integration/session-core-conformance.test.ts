import { beforeEach } from "vitest";
import { runInSessionDO } from "./session-do-access";
import {
  registerSessionCoreConformanceSuite,
  type SqlStorageFactory,
} from "../conformance/session-core-conformance";
import { cleanD1Tables } from "./cleanup";
import { initSession, waitForSandboxStatus } from "./helpers";

const durableObjectStorageFactory: SqlStorageFactory = async (run) => {
  const { stub } = await initSession();
  // Initialization schedules a warm spawn in the background; in tests it
  // fails, and its lifecycle writes would race the sandbox repository case.
  // Enter the object only once that work has settled.
  await waitForSandboxStatus(stub, "failed");
  return runInSessionDO(stub, (instance, state) =>
    run({
      sql: state.storage.sql,
      transactionSync: (closure) => state.storage.transactionSync(closure),
    })
  );
};

beforeEach(cleanD1Tables);

registerSessionCoreConformanceSuite(durableObjectStorageFactory);
