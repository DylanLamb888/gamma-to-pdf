import process from "node:process";
import { spawn } from "node:child_process";

const MINIMUM_NODE_MAJOR = 20;
const POPPLER_COMMANDS = ["pdfinfo", "pdffonts", "pdftotext", "pdftoppm"];

function parseNodeMajor(version) {
  return Number.parseInt(String(version || "").replace(/^v/, "").split(".")[0], 10);
}

function getInstallHints() {
  if (process.platform === "darwin") {
    return {
      poppler: "brew install poppler",
      tesseract: "brew install tesseract",
    };
  }

  return {
    poppler: "sudo apt-get update && sudo apt-get install -y poppler-utils",
    tesseract: "sudo apt-get install -y tesseract-ocr",
  };
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
    });
  });
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${command}`], {
      stdio: "ignore",
      shell: false,
    });

    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function main() {
  const nodeMajor = parseNodeMajor(process.version);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    console.error(`Node.js ${MINIMUM_NODE_MAJOR}+ is required. Current: ${process.version}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Using Node.js ${process.version}`);
  console.log("");
  console.log("Installing JavaScript dependencies with npm ci...");
  await runProcess("npm", ["ci"]);

  console.log("");
  console.log("Installing Playwright Chromium...");
  await runProcess("npx", ["playwright", "install", "chromium"]);

  const installHints = getInstallHints();
  const missingPoppler = [];
  for (const command of POPPLER_COMMANDS) {
    if (!(await commandExists(command))) {
      missingPoppler.push(command);
    }
  }

  const hasTesseract = await commandExists("tesseract");

  console.log("");
  console.log("Setup summary:");
  console.log("- npm dependencies installed");
  console.log("- Playwright Chromium installed");

  if (missingPoppler.length > 0) {
    console.log(`- Poppler missing (${missingPoppler.join(", ")}): ${installHints.poppler}`);
  } else {
    console.log("- Poppler tools available");
  }

  if (!hasTesseract) {
    console.log(`- Tesseract missing: ${installHints.tesseract}`);
  } else {
    console.log("- Tesseract available");
  }

  console.log("");
  console.log("Next steps:");
  console.log("- Run `npm run doctor`");
  console.log("- Run `npm run export -- '<gamma-doc-url>' --chat-ready --qa`");
}

await main();
