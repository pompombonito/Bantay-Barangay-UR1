// Patches Vite's Windows safe-realpath so its startup `exec("net use")` child
// spawn cannot crash builds in sandboxed environments (EPERM spawn EPERM).
// Runs on postinstall; safe to run repeatedly.
const fs = require("node:fs");
const path = require("node:path");

const target = path.join(__dirname, "..", "node_modules", "vite", "dist", "node", "chunks", "node.js");

const file = fs.existsSync(target) ? target : null;
if (!file) {
  console.log("[fix-vite-sandbox] vite not installed yet; skipping.");
  process.exit(0);
}

let source = fs.readFileSync(file, "utf8");
if (source.includes("sandbox blocks child spawn")) {
  console.log("[fix-vite-sandbox] already patched.");
  process.exit(0);
}

const needle = 'exec("net use", (error, stdout) => {';
const index = source.indexOf(needle);
if (index === -1) {
  console.log("[fix-vite-sandbox] expected Vite code not found; skipping without changes.");
  process.exit(0);
}

const close = source.indexOf("});", index);
if (close === -1) {
  console.log("[fix-vite-sandbox] could not find exec block end; skipping without changes.");
  process.exit(0);
}

source =
  source.slice(0, index) +
  "try { " +
  source.slice(index, close + 3) +
  "\n\t\t\t} catch { /* sandbox blocks child spawn */ }" +
  source.slice(close + 3);

fs.writeFileSync(file, source);
console.log("[fix-vite-sandbox] patched:", path.relative(process.cwd(), file));
