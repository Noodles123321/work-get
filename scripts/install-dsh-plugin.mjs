#!/usr/bin/env node
/**
 * 把 dsh-workget-bridge 装进 DSH 的 desktop profile。
 *
 *   node scripts/install-dsh-plugin.mjs            # 安装（会改 profile 的 package.json 并跑 pnpm install）
 *   node scripts/install-dsh-plugin.mjs --check    # 只读检查，不改任何文件
 *   node scripts/install-dsh-plugin.mjs --rollback # 还原备份，删掉 node_modules 里的链接
 *
 * 改的都是 profile 目录（默认 %USERPROFILE%\.dsh\profiles\desktop，可用 --profile 覆盖），
 * 位于工作区之外，所以可能需要在提权终端里运行。
 *
 * 设计原则：幂等、先备份、失败给回滚命令。除了 pnpm install 之外不做任何“推断”。
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = 'dsh-workget-bridge';
const DEFAULT_PORT = 3610;
const CHECK_TIMEOUT_MS = 1500;

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginDir = path.join(repoRoot, 'dsh-plugin');
const stateDir = path.join(repoRoot, '.dsh-bridge');
const installDir = path.join(stateDir, 'install');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const profileDir = path.resolve(argValue('--profile', path.join(os.homedir(), '.dsh', 'profiles', 'desktop')));
const manifestPath = path.join(profileDir, 'package.json');
const lockPath = path.join(profileDir, 'pnpm-lock.yaml');
const manifestBackup = `${manifestPath}.bak-workget`;
const lockBackup = `${lockPath}.bak-workget`;
const modulesDir = path.join(profileDir, 'node_modules');
const linkedDir = path.join(modulesDir, PKG);

const ok = (text) => console.log(`  \u2714 ${text}`);
const bad = (text) => console.log(`  \u2716 ${text}`);
const info = (text) => console.log(`    ${text}`);

function fail(message, hint) {
  console.error(`\n[失败] ${message}`);
  if (hint) console.error(`[怎么做] ${hint}`);
  process.exit(1);
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** Windows 上 file: 依赖写成正斜杠，pnpm 与 DSH 都能认。 */
function fileSpec() {
  return `file:${pluginDir.replace(/\\/g, '/')}`;
}

function readManifest() {
  if (!existsSync(manifestPath)) {
    fail(`找不到 profile 清单：${manifestPath}`, '确认 DSH 用的是 desktop profile，或用 --profile 指定正确目录');
  }
  try {
    return readJson(manifestPath);
  } catch (error) {
    return fail(`profile 清单不是合法 JSON：${String(error)}`, '先在 DSH 里装一次插件让它自己修好，或手动检查该文件');
  }
}

function hasDependency(manifest) {
  return manifest.dependencies?.[PKG] !== undefined;
}

function hasBundle(manifest) {
  return Array.isArray(manifest.dsh?.profile?.bundles) && manifest.dsh.profile.bundles.includes(PKG);
}

function linkResolvesToPlugin() {
  if (!existsSync(linkedDir)) return false;
  const target = path.join(linkedDir, 'package.json');
  if (!existsSync(target)) return false;
  try {
    const pkg = readJson(target);
    return pkg.name === PKG;
  } catch {
    return false;
  }
}

async function portStatus() {
  try {
    const res = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const body = await res.json();
    return { up: true, name: body.name, version: body.version, pushes: body.pushes };
  } catch (error) {
    return { up: false, error: String(error) };
  }
}

function snapshotModules() {
  mkdirSync(installDir, { recursive: true });
  const names = existsSync(modulesDir)
    ? readdirSync(modulesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort()
    : [];
  return names;
}

function writeSnapshot(file, names) {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(file, `${names.join('\n')}\n`, 'utf8');
}

async function check() {
  console.log(`\n== 只读检查 ==`);
  info(`插件目录：${pluginDir}`);
  info(`目标 profile：${profileDir}`);
  info(`运行中的桥：${DEFAULT_PORT}`);

  existsSync(path.join(pluginDir, 'package.json')) ? ok('插件源码存在') : bad('插件源码缺失（dsh-plugin/package.json 不在）');

  if (!existsSync(manifestPath)) {
    bad('profile package.json 不存在');
    return;
  }
  const manifest = readManifest();
  hasDependency(manifest) ? ok(`dependencies 已声明（${manifest.dependencies[PKG]}）`) : bad('dependencies 未声明');
  hasBundle(manifest) ? ok('dsh.profile.bundles 已包含') : bad('dsh.profile.bundles 未包含');
  linkResolvesToPlugin() ? ok('node_modules 已就位') : bad('node_modules 里没有可用的包');

  existsSync(path.join(stateDir, 'token.txt')) ? ok('token.txt 已生成') : bad('token.txt 还没有（插件首次启动时才生成）');

  const health = await portStatus();
  if (health.up) ok(`桥在跑：${health.name} v${health.version}，已推送 ${health.pushes} 次`);
  else bad(`桥没在跑（${DEFAULT_PORT} 无响应）—— 改完 profile 后需要重启 DSH`);

  console.log('\n检查完，未修改任何文件。');
}

function ensureBackups() {
  if (!existsSync(manifestBackup)) {
    copyFileSync(manifestPath, manifestBackup);
    ok(`已备份 package.json → ${path.basename(manifestBackup)}`);
  } else {
    info(`备份已存在，保留不覆盖：${path.basename(manifestBackup)}`);
  }
  if (existsSync(lockPath) && !existsSync(lockBackup)) {
    copyFileSync(lockPath, lockBackup);
    ok(`已备份 pnpm-lock.yaml → ${path.basename(lockBackup)}`);
  }
}

function patchManifest() {
  const manifest = readManifest();
  const spec = fileSpec();
  let changed = false;

  if (!manifest.dependencies) manifest.dependencies = {};
  if (manifest.dependencies[PKG] !== spec) {
    manifest.dependencies[PKG] = spec;
    changed = true;
  }

  if (!manifest.dsh) manifest.dsh = {};
  if (!manifest.dsh.profile) manifest.dsh.profile = {};
  if (!Array.isArray(manifest.dsh.profile.bundles)) manifest.dsh.profile.bundles = [];
  if (!manifest.dsh.profile.bundles.includes(PKG)) {
    manifest.dsh.profile.bundles.push(PKG);
    changed = true;
  }

  if (!changed) {
    info('清单已是最新，无需修改');
    return;
  }
  writeJson(manifestPath, manifest);
  ok(`已写入依赖 ${PKG} → ${spec}`);
  ok('已加入 dsh.profile.bundles');
}

function runPnpm() {
  const command = `corepack pnpm@11.28.5 install --reporter=append-only --config.confirmModulesPurge=false`;
  console.log(`\n[安装] ${command}`);
  console.log(`[安装] 工作目录：${profileDir}`);
  const result = spawnSync('cmd.exe', ['/c', command], { cwd: profileDir, stdio: 'inherit' });
  if (result.error) fail(`无法启动 pnpm：${String(result.error)}`, '确认 Node 自带 corepack：`corepack --version`');
  if (result.status !== 0) {
    fail(
      `pnpm install 退出码 ${result.status}`,
      `运行 node scripts/install-dsh-plugin.mjs --rollback 还原，然后把上面的报错发出来`,
    );
  }
}

function diffModules(before, after) {
  const removed = before.filter((name) => !after.includes(name));
  const added = after.filter((name) => !before.includes(name));
  if (added.length > 0) info(`新增：${added.slice(0, 8).join(', ')}${added.length > 8 ? ` …（共 ${added.length}）` : ''}`);
  if (removed.length > 0) {
    console.log(`\n[注意] 本次安装移除了 ${removed.length} 个 node_modules 顶层条目：`);
    console.log(`  ${removed.slice(0, 15).join(', ')}${removed.length > 15 ? ' …' : ''}`);
    console.log('  若其中有你其它插件要用的包，先跑 --rollback，再改用 junction 降级方案（见 docs/dsh-bridge.md）。');
  } else {
    info('没有删除任何 node_modules 条目');
  }
}

function install() {
  console.log(`\n== 安装 ${PKG} ==`);
  info(`插件目录：${pluginDir}`);
  info(`目标 profile：${profileDir}`);

  if (!existsSync(path.join(pluginDir, 'package.json'))) {
    fail('找不到 dsh-plugin/package.json', '确认在仓库根目录执行本脚本');
  }
  const pluginPkg = readJson(path.join(pluginDir, 'package.json'));
  if (pluginPkg.name !== PKG) fail(`插件包名不符：${pluginPkg.name}，应为 ${PKG}`);

  ensureBackups();
  const before = snapshotModules();
  writeSnapshot(path.join(installDir, 'node-modules-before.txt'), before);
  ok(`已快照 node_modules 顶层 ${before.length} 项 → .dsh-bridge/install/node-modules-before.txt`);

  patchManifest();
  runPnpm();

  const after = snapshotModules();
  writeSnapshot(path.join(installDir, 'node-modules-after.txt'), after);
  diffModules(before, after);

  if (!linkResolvesToPlugin()) {
    fail(
      'pnpm 跑完了，但 node_modules 里仍然找不到可用的包',
      '试试 junction 降级：New-Item -ItemType Junction -Path "<profile>\\node_modules\\dsh-workget-bridge" -Target "E:\\DP_HANS\\Work_GET\\dsh-plugin"',
    );
  }
  ok('node_modules 已就位');

  console.log(`\n下一步：`);
  console.log(`  1) 关掉并重新打开 DSH（新插件只在启动时加载）`);
  console.log(`  2) node dsh-plugin/scripts/selfcheck.mjs`);
  console.log(`  3) 把 ${path.join(stateDir, 'token.txt')} 的内容粘到扩展「设置 → DSH 侧」`);
  console.log(`\n回滚：node scripts/install-dsh-plugin.mjs --rollback`);
}

function rollback() {
  console.log(`\n== 回滚 ==`);
  if (existsSync(manifestBackup)) {
    copyFileSync(manifestBackup, manifestPath);
    rmSync(manifestBackup, { force: true });
    ok('已还原 package.json');
  } else {
    info('没有 package.json 备份，跳过');
  }
  if (existsSync(lockBackup)) {
    copyFileSync(lockBackup, lockPath);
    rmSync(lockBackup, { force: true });
    ok('已还原 pnpm-lock.yaml');
  } else {
    info('没有 pnpm-lock.yaml 备份，跳过');
  }
  if (existsSync(linkedDir)) {
    rmSync(linkedDir, { recursive: true, force: true });
    ok('已删除 node_modules 里的插件目录');
  } else {
    info('node_modules 里没有该插件目录');
  }
  console.log('\n回滚完成。重启 DSH 后生效。');
}

if (flag('--help') || flag('-h')) {
  console.log('用法：node scripts/install-dsh-plugin.mjs [--check | --rollback] [--profile <dir>]');
  process.exit(0);
} else if (flag('--check')) {
  await check();
} else if (flag('--rollback')) {
  rollback();
} else {
  install();
}
