/*
 * Make an Xcode-26-built WebDriverAgentRunner loadable on older iOS:
 * Swift Testing (Xcode 16+) is hard-linked by XCTest's support libraries but needs a
 * Swift runtime that iOS < 16 doesn't have. Any @rpath dependency that isn't actually
 * present in the bundle is turned into a weak link, so dyld resolves it to null instead
 * of refusing to load the bundle. WDA itself is Objective-C and never calls into them.
 */
const fs = require('fs'), path = require('path');
const root = process.cwd();
const LC_LOAD_DYLIB = 0xc, LC_LOAD_WEAK_DYLIB = 0x80000018;

function machoFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) machoFiles(p, out);
    else if (e.isFile()) {
      const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(4);
      try { fs.readSync(fd, b, 0, 4, 0); } catch {} finally { fs.closeSync(fd); }
      if (b.readUInt32BE(0) === 0xcafebabe || b.readUInt32LE(0) === 0xfeedfacf) out.push(p);
    }
  }
  return out;
}
const eachSlice = (buf, fn) => {
  if (buf.readUInt32BE(0) === 0xcafebabe) { const n = buf.readUInt32BE(4); for (let i = 0; i < n; i++) fn(buf.readUInt32BE(8 + i * 20 + 8)); }
  else fn(0);
};
// Where @rpath can resolve: the app's Frameworks, each plugin's own Frameworks, and the binary's directory.
const searchDirs = (file) => [
  path.join(root, 'Frameworks'),
  path.dirname(file),
  ...fs.existsSync(path.join(root, 'PlugIns')) ? fs.readdirSync(path.join(root, 'PlugIns')).map((p) => path.join(root, 'PlugIns', p, 'Frameworks')) : [],
];
const resolves = (file, rel) => searchDirs(file).some((d) => fs.existsSync(path.join(d, rel)));

let weakened = 0, kept = 0;
for (const file of machoFiles(root)) {
  const buf = fs.readFileSync(file);
  let changed = 0;
  eachSlice(buf, (base) => {
    if (buf.readUInt32LE(base) !== 0xfeedfacf) return;
    const ncmds = buf.readUInt32LE(base + 16);
    let off = base + 32;
    for (let i = 0; i < ncmds; i++) {
      const cmd = buf.readUInt32LE(off), size = buf.readUInt32LE(off + 4);
      if (cmd === LC_LOAD_DYLIB) {
        const nameOff = buf.readUInt32LE(off + 8);
        const name = buf.toString('utf8', off + nameOff, off + size).replace(/\0+$/, '');
        if (name.startsWith('@rpath/')) {
          if (resolves(file, name.slice(7))) kept++;
          else { buf.writeUInt32LE(LC_LOAD_WEAK_DYLIB, off); changed++; console.log(`  weak → ${path.relative(root, file)} : ${name}`); }
        }
      }
      off += size;
    }
  });
  if (changed) { fs.writeFileSync(file, buf); weakened += changed; }
}
console.log(`weakened ${weakened} unresolvable dependency link(s); left ${kept} resolvable one(s) hard`);
