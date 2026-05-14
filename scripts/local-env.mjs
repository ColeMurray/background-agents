#!/usr/bin/env node
import { resolve } from "node:path";
import {
  getRequiredEnvKeys,
  readRootEnv,
  requireEnv,
  root,
  serializeEnv,
  serviceEnvKeys,
  writeEnv,
} from "./env-utils.mjs";

const env = readRootEnv();
const requiredEnvKeys = getRequiredEnvKeys(env);
requireEnv(env, [...requiredEnvKeys.web, ...requiredEnvKeys.controlPlane]);

writeEnv(resolve(root, "packages/web/.env.local"), serializeEnv(env, serviceEnvKeys.web));
writeEnv(
  resolve(root, "packages/control-plane/.dev.vars"),
  serializeEnv(env, serviceEnvKeys.controlPlane)
);

console.log("\nNext, sync Modal secrets from .env.local:");
console.log("  npm run dev:modal-secrets");
