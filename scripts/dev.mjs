// dev.mjs -- 一条命令起开发环境：后端 + 前端 vite 同时跑。
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isWin = process.platform === "win32";

function run(label, cmd, args, cwd, color) {
  const child = spawn(cmd, args, { cwd, stdio: "inherit", shell: isWin });
  child.on("exit", (code) => {
    console.log(`\x1b[${color}m[${label}] exited ${code}\x1b[0m`);
    process.exitCode = code ?? 0;
  });
  return child;
}

const server = run("server", process.execPath, [join(root, "server", "server.mjs")], root, "36");
const web = run("web   ", "npm", ["--prefix", "web", "run", "dev"], root, "35");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    server.kill();
    web.kill();
    process.exit(0);
  });
}
