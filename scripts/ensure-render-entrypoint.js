const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const targetEntry = path.join(distDir, 'main.js');
const compatibilityEntry = path.join(distDir, 'src', 'main.js');

if (!fs.existsSync(targetEntry)) {
  console.error(`Expected compiled entrypoint not found at ${path.relative(projectRoot, targetEntry)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(compatibilityEntry), { recursive: true });

const shim = [
  "'use strict';",
  "require('../main');",
  "",
].join('\n');

fs.writeFileSync(compatibilityEntry, shim, 'utf8');
console.log(`Created Render compatibility entrypoint at ${path.relative(projectRoot, compatibilityEntry)}`);
