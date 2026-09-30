/**
 * prepare 钩子：`npm install` 之后把「跑起来所需的两件事」补齐。
 *
 * 1. **安装后端依赖**（npm --prefix server install → server/node_modules/better-sqlite3）
 * 2. **构建前端**（vite build → web/dist）
 *
 * 为什么需要它：面板类部署（Pterodactyl / Wispbyte 等）**没有 shell**，
 * 用户改不了启动命令、也没法手动执行 `npm run build` 或 `npm --prefix server install`；
 * 面板只会在启动前跑一次根目录的 `npm install`。把这两步挂在 prepare 上，
 * 就能让「git 拉代码 + npm install」直接产出可运行的服务。
 *
 * 三条刻意的容错（都是为了不制造「装不上 → 起不来」的死循环）：
 *   - 后端依赖装失败（离线等）→ 警告后继续，不影响前端构建与安装本身；
 *   - vite 不在（`--omit=dev`）→ 跳过构建并说明原因；
 *   - 构建失败 → 警告后继续，服务端启动时还会再警告一次「前端产物不存在」。
 *
 * 本地开发无感：vite 与 better-sqlite3 都已就绪时，两步都是秒级。
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const serverDir = path.join(root, "server");
const require = createRequire(import.meta.url);

function hasVite() {
  try {
    require.resolve("vite", { paths: [root] });
    return true;
  } catch {
    return false;
  }
}

function hasDist() {
  return fs.existsSync(path.join(root, "web", "dist", "index.html"));
}

/* ── 1) 后端依赖（面板只会跑根目录的 npm install，这里替它补上） ───────── */
if (fs.existsSync(path.join(serverDir, "package.json"))) {
  console.log("[prepare] 安装后端依赖 → server/node_modules");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: serverDir,
    stdio: "inherit",
    // Windows 上 npm.cmd 需要 shell 才能解析（参数是写死的，不存在注入面）
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.warn(`[prepare] 后端依赖安装失败（退出码 ${r.status}）——服务端可能起不来（缺 better-sqlite3）`);
  }
  ensureBetterSqlite3Binding();
}

/**
 * 确认 better-sqlite3 的原生二进制就位；缺失就自己跑一遍它的安装脚本。
 *
 * 为什么需要这一步：**npm 12 默认不执行依赖的安装脚本**（供应链加固）。
 * better-sqlite3 的二进制不是随包发布的，而是靠它的 install 脚本
 * （`prebuild-install || node-gyp rebuild --release`）在安装时下载/编译出来；
 * 脚本被拦下时 npm 只打一行 warn，包照样"装好了"，直到运行时才炸：
 *
 *   Error: Could not locate the bindings file. Tried:
 *    → …/better-sqlite3/build/Release/better_sqlite3.node …
 *
 * 面板（Pterodactyl/Wispbyte）没有 shell，用户既不能 `npm install-scripts approve`，
 * 也改不了启动命令，所以这里替他把这件事做完：
 *   1. 优先 `prebuild-install`：直接下载对应平台/Node ABI 的预编译包（秒级，无需编译器）；
 *   2. 失败再 `node-gyp rebuild --release`：现场编译（需要 python3 / make / g++，慢）。
 * 仓库根的 .npmrc 里也显式放行了该脚本（npm 认这项时连这一步都不需要）。
 */
function ensureBetterSqlite3Binding() {
  const pkgDir = path.join(serverDir, "node_modules", "better-sqlite3");
  const binding = path.join(pkgDir, "build", "Release", "better_sqlite3.node");
  if (!fs.existsSync(pkgDir) || fs.existsSync(binding)) return;

  console.warn("[prepare] better-sqlite3 缺原生二进制（多半是安装脚本被 npm 拦下了），正在补装…");

  const prebuildBin = path.join(serverDir, "node_modules", "prebuild-install", "bin.js");
  if (fs.existsSync(prebuildBin)) {
    console.log("[prepare] 方式 1：prebuild-install（下载预编译二进制）");
    spawnSync(process.execPath, [prebuildBin, "--path", pkgDir, "--verbose"], {
      cwd: pkgDir,
      stdio: "inherit",
    });
    if (fs.existsSync(binding)) {
      console.log("[prepare] better-sqlite3 二进制已就位");
      return;
    }
  }

  console.log("[prepare] 方式 2：node-gyp rebuild（现场编译，需要 python3 / make / g++）");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  spawnSync(npm, ["exec", "--", "node-gyp", "rebuild", "--release"], {
    cwd: pkgDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (fs.existsSync(binding)) {
    console.log("[prepare] better-sqlite3 二进制已就位（本地编译）");
  } else {
    console.warn("[prepare] 仍缺少 better-sqlite3 二进制 —— 服务端启动会报 Could not locate the bindings file");
    console.warn("[prepare] 处理建议：把本机 server/node_modules 打包上传，或让面板管理员放行安装脚本");
  }
}

/* ── 2) 前端构建 ───────────────────────────────────────────────── */
if (!hasVite()) {
  console.log("[prepare] 未安装 vite（可能用了 --omit=dev），跳过前端构建");
  if (!hasDist()) {
    console.log("[prepare] 提示：当前没有 web/dist，页面会打不开。"
      + "面板部署请改成完整安装（不要 --omit=dev），或在本地构建后把 web/dist 一起上传");
  }
  process.exit(0);
}

const built = spawnSync(process.execPath, [
  path.join(root, "node_modules", "vite", "bin", "vite.js"),
  "build",
  "--config", path.join(root, "web", "vite.config.js"),
], { cwd: root, stdio: "inherit" });

if (built.status !== 0) {
  console.warn(`[prepare] 前端构建失败（退出码 ${built.status}）——安装继续，但页面可能打不开`);
  console.warn("[prepare] 本地可手动排查：npm run build");
  process.exit(0);
}
console.log("[prepare] 前端已构建 → web/dist");
