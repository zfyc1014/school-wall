"use strict";

/**
 * 网络层小工具：IP 规范化与「可信代理」判定。
 *
 * 存在的理由（这是一次真实审计出来的漏洞）：
 *   TRUST_PROXY=1 时直接相信 X-Forwarded-For 的**最左边**一项。
 *   但应用往往同时能被直连访问（本站面板部署就是：代理在转发的同时候，
 *   用户也能直接打 IP:端口）。此时攻击者只需每个请求换一个 XFF 值，
 *   就能让所有「按 IP 限流」形同虚设 —— 验证码轰炸、后台令牌爆破、
 *   举报刷单全部绕过；顺带还能伪造后台概览里的「IP 来源」。
 *   另外最左边那项本身就是客户端可伪造的：正规代理是**追加**在末尾的。
 *
 * 规则：
 *   1. 只有请求**直接来自可信代理**（默认私有/回环网段）时才看转发头；
 *   2. 取 XFF 的**最右**一跳（离我们最近的代理追加的那一项）；
 *   3. 取出来的值必须是合法 IP，否则回退到 socket 对端地址；
 *   4. IPv4-mapped（::ffff:1.2.3.4）、带端口、带 zone id 的写法统一规范化，
 *      避免同一个客户端因为写法不同绕开限流桶。
 */

const net = require("net");

/** 规范化 IP：去端口/方括号/zone，IPv4-mapped 还原为 IPv4，非法返回空串 */
function normalizeIp(raw) {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return "";
  // [::1]:1234 / 1.2.3.4:1234
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    if (end > 0) s = s.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(":"));
  }
  s = s.split("%")[0]; // zone id: fe80::1%eth0
  s = s.toLowerCase();
  if (s.startsWith("::ffff:") && net.isIP(s.slice(7)) === 4) s = s.slice(7);
  if (net.isIP(s) === 0) return "";
  return s;
}

/** IP → 字节 Buffer（v4 4 字节 / v6 16 字节） */
function ipToBytes(ip) {
  const family = net.isIP(ip);
  if (family === 4) return Buffer.from(ip.split(".").map((n) => Number(n)));
  if (family !== 6) return null;
  const [headRaw, tailRaw] = ip.split("::");
  const head = headRaw ? headRaw.split(":") : [];
  const tail = tailRaw === undefined ? [] : tailRaw ? tailRaw.split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  const groups = [
    ...head,
    ...(tailRaw === undefined ? [] : new Array(missing).fill("0")),
    ...tail
  ].map((g) => parseInt(g || "0", 16));
  if (groups.length !== 8 || groups.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  const out = Buffer.alloc(16);
  groups.forEach((n, i) => out.writeUInt16BE(n, i * 2));
  return out;
}

/** 解析 "10.0.0.0/8, 192.168.0.0/16, ::1/128, 1.2.3.4" 形式的列表 */
function parseCidrs(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [ipPart, prefixPart] = part.split("/");
      const ip = normalizeIp(ipPart);
      if (!ip) return null;
      const bytes = ipToBytes(ip);
      if (!bytes) return null;
      const family = bytes.length === 4 ? 4 : 6;
      const maxPrefix = family === 4 ? 32 : 128;
      const prefix = prefixPart === undefined ? maxPrefix : Number(prefixPart);
      if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return null;
      return { bytes, prefix };
    })
    .filter(Boolean);
}

/** ip 是否落在任一 CIDR 内 */
function inAnyCidr(ip, cidrs) {
  const bytes = ipToBytes(normalizeIp(ip));
  if (!bytes || !cidrs.length) return false;
  for (const { bytes: base, prefix } of cidrs) {
    if (base.length !== bytes.length) continue;
    const fullBytes = prefix >> 3;
    const restBits = prefix & 7;
    let ok = true;
    for (let i = 0; i < fullBytes; i += 1) {
      if (bytes[i] !== base[i]) { ok = false; break; }
    }
    if (ok && restBits) {
      const mask = 0xff << (8 - restBits) & 0xff;
      if ((bytes[fullBytes] & mask) !== (base[fullBytes] & mask)) ok = false;
    }
    if (ok) return true;
  }
  return false;
}

/** 默认「可信代理」：回环 + 私有网段 + 链路本地（容器/反代都在这里） */
const DEFAULT_TRUSTED_PROXIES = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,fc00::/7,fe80::/10";

module.exports = {
  normalizeIp,
  ipToBytes,
  parseCidrs,
  inAnyCidr,
  DEFAULT_TRUSTED_PROXIES
};
