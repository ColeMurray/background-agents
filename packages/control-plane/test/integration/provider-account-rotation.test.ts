import { beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { sqlDatabase } from "./helpers";
import { cleanD1Tables } from "./cleanup";
import { rotationStorageContract } from "../provider-account-rotation-contract";
beforeEach(cleanD1Tables);
rotationStorageContract(() => sqlDatabase(env.DB));
