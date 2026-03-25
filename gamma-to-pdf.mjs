#!/usr/bin/env node

export * from "./src/core.mjs";

import { fileURLToPath } from "node:url";

import { runCli } from "./src/cli.mjs";
import { isDirectExecution } from "./src/core.mjs";

if (isDirectExecution(fileURLToPath(import.meta.url))) {
  await runCli();
}
