import process from "node:process";

import { parseArgs, run } from "./core.mjs";

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    await run(args);
    return 0;
  } catch (error) {
    const exitCode = typeof error?.exitCode === "number" ? error.exitCode : 1;
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = exitCode;
    return exitCode;
  }
}
