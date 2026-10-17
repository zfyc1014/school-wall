"use strict";

/**
 * 通用套件包装器：把「子进程在退出阶段被原生断言打断」的情况与「套件真的失败」区分开。
 *
 * 背景：Windows + better-sqlite3 在进程退出阶段偶发
 *   Assertion failed: (env) != nullptr   → SIGABRT(134)
 * 这跟套件本身的结果无关（结论早就打印完了），但如果直接拿子进程退出码，npm test 会随机失败。
 * 所以：子进程输出写到临时文件（同步、abort 也保得住），
 * 只要输出里能看到成功标记，就按成功算。
 *
 * 用法：node scripts/run-suite.js scripts/upgrade-test.js
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const target = process.argv[2];
if (!target) {
  console.error("用法：node scripts/run-suite.js <脚本路径>");
  process.exit(2);
}

const logFile = path.join(os.tmpdir(), "wall-suite-" + process.pid + ".log");
const fd = fs.openSync(logFile, "w");
const child = spawnSync(process.execPath, [path.resolve(target)], {
  cwd: path.dirname(path.resolve(target)),
  env: process.env,
  stdio: ["ignore", fd, fd]
});
fs.closeSync(fd);

let out = "";
try { out = fs.readFileSync(logFile, "utf8"); } catch { /* ignore */ }
try { fs.unlinkSync(logFile); } catch { /* ignore */ }
process.stdout.write(out);

const aborted = child.status === 134 || child.signal === "SIGABRT";
const ok = child.status === 0 || (aborted && /=== 通过 (\d+) \/ 失败 0 ===/.test(out));
if (child.status === 0) process.exit(0);
if (ok) {
  console.log("[suite] 注：子进程退出阶段触发了 better-sqlite3 原生断言（SIGABRT），"
    + "但结论已通过，按成功处理。");
  process.exit(0);
}
process.exit(child.status === null ? 1 : child.status);
