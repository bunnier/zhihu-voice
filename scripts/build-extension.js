#!/usr/bin/env node
// Copy only the files needed by the unpacked extension. Never replace a
// previously generated directory if its contents have been changed.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const output = path.join(dist, 'zhihu-voice');
const marker = '.zhihu-voice-build.json';
const files = [
  'manifest.json', 'background.js', 'content.js', 'content.css', 'extract.js',
  'speech.js', 'tencent.js', 'options.html', 'options.js', 'options.css'
];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function regularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`不是普通文件：${file}`);
}

function verifyPreviousBuild() {
  const stat = fs.lstatSync(output);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`输出路径不是普通目录：${output}`);
  regularFile(path.join(output, marker));
  const old = JSON.parse(fs.readFileSync(path.join(output, marker), 'utf8'));
  if (old.format !== 1 || !old.files || typeof old.files !== 'object') throw new Error('输出目录没有有效的生成记录');
  const names = Object.keys(old.files).sort();
  const actual = fs.readdirSync(output).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...names, marker].sort()) ||
      names.some(name => !files.includes(name))) throw new Error('输出目录包含额外或未知文件');
  for (const name of names) {
    const file = path.join(output, name);
    regularFile(file);
    if (hash(fs.readFileSync(file)) !== old.files[name]) throw new Error(`输出文件已被修改：${name}`);
  }
}

let stage;
let backup;
try {
  if (!fs.existsSync(dist)) fs.mkdirSync(dist);
  const distStat = fs.lstatSync(dist);
  if (!distStat.isDirectory() || distStat.isSymbolicLink()) throw new Error(`输出父目录不是普通目录：${dist}`);
  const exists = fs.existsSync(output) || (() => { try { fs.lstatSync(output); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } })();
  if (exists) verifyPreviousBuild();
  stage = fs.mkdtempSync(path.join(dist, '.zhihu-voice-stage-'));
  const checksums = {};
  for (const name of files) {
    const file = path.join(source, name);
    regularFile(file);
    const bytes = fs.readFileSync(file);
    fs.writeFileSync(path.join(stage, name), bytes, { flag: 'wx' });
    checksums[name] = hash(bytes);
  }
  fs.writeFileSync(path.join(stage, marker), JSON.stringify({ format: 1, files: checksums }, null, 2) + '\n', { flag: 'wx' });
  if (exists) {
    // Recheck immediately before moving the previous build aside.
    verifyPreviousBuild();
    backup = fs.mkdtempSync(path.join(dist, '.zhihu-voice-backup-'));
    fs.rmdirSync(backup);
    fs.renameSync(output, backup);
  }
  try {
    fs.renameSync(stage, output);
    stage = undefined;
  } catch (error) {
    if (backup) { fs.renameSync(backup, output); backup = undefined; }
    throw error;
  }
  if (backup) { fs.rmSync(backup, { recursive: true }); backup = undefined; }
  console.log(`扩展已生成：${output}`);
  console.log('在 Chrome/Edge 扩展管理页面加载该目录；更新后点击重新加载并刷新知乎页面。');
} catch (error) {
  console.error(`生成失败：${error.message}`);
  console.error('现有输出已保留；请检查该目录并自行备份或移走需要保留的文件。');
  process.exitCode = 1;
} finally {
  if (stage) fs.rmSync(stage, { recursive: true, force: true });
  if (backup) console.error(`旧输出保留在：${backup}`);
}
