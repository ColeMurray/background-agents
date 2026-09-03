import { runInSessionDO } from "./session-do-access";
import {
  registerSessionCoreConformanceSuite,
  type SqlStorageFactory,
} from "../conformance/session-core-conformance";
import { initSession } from "./helpers";

const durableObjectStorageFactory: SqlStorageFactory = async (run) => {
  const { stub } = await initSession();
  return runInSessionDO(stub, (instance, state) =>
    run({
      sql: state.storage.sql,
      transactionSync: (closure) => state.storage.transactionSync(closure),
    })
  );
};

registerSessionCoreConformanceSuite(durableObjectStorageFactory);
