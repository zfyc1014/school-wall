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
// Windows 上连续 spawn 十几个服务子进程后，端口回收会变慢，偶发连接被重置；重跑 2 次足够
const MAX_RETRIES = Number(process.env.SUITE_RETRIES || 2);

/**
 * 「环境抖动」而不是「用例失败」的特征。
 *
 * 这两个套件会各自 spawn 一个服务子进程；在 Windows 上偶发子进程启动瞬间连接被重置
 * （ECONNRESET / fetch failed），套件会直接崩掉 —— 但断言一条都没错。
 * 这种情况重跑一次几乎必然通过，所以只对**网络类崩溃**重试；
 * 只要输出里出现 ✗（断言失败），一律照常失败，绝不掩盖真实问题。
 */
const FLAKY = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|连接失败/;
const REAL_FAILURE = /✗/;
if (!target) {
  console.error("用法：node scripts/run-suite.js <脚本路径>");
  process.exit(2);
}

function runOnce(attempt) {
  const logFile = path.join(os.tmpdir(), "wall-suite-" + process.pid + "-" + attempt + ".log");
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
  const passed = child.status === 0 || (aborted && /=== 通过 (\d+) \/ 失败 0 ===/.test(out));
  return {
    status: child.status,
    passed,
    // 只有「没有断言失败 + 出现网络类崩溃特征」才算环境抖动
    flaky: !passed && !REAL_FAILURE.test(out) && FLAKY.test(out)
  };
}

let last = null;
for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
  if (attempt > 1) console.log("[suite] 环境抖动（网络类崩溃），重试第 " + (attempt - 1) + " 次…");
  last = runOnce(attempt);
  if (last.passed) {
    if (attempt > 1) console.log("[suite] 重试后通过。");
    if (last.status !== 0) {
      console.log("[suite] 注：子进程退出阶段触发了 better-sqlite3 原生断言（SIGABRT），"
        + "但结论已通过，按成功处理。");
    }
    process.exit(0);
  }
  if (!last.flaky) break;
}
process.exit(last && last.passed ? 0 : (last && last.status) || 1);
