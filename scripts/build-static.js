const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const requiredEnv = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'];
const missing = requiredEnv.filter(name => !process.env[name]);

if (missing.length) {
  console.error(`Missing required environment variable(s): ${missing.join(', ')}`);
  process.exit(1);
}

function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(file) {
  const from = path.join(root, file);
  const to = path.join(dist, file);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(dir) {
  const fromDir = path.join(root, dir);
  const toDir = path.join(dist, dir);
  fs.mkdirSync(toDir, { recursive: true });
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) copyDir(rel);
    else copyFile(rel);
  }
}

resetDir(dist);
['index.html', 'manifest.json', 'questions.json', 'service-worker.js', 'robots.txt', 'sitemap.xml'].forEach(copyFile);
['assets', 'icons'].forEach(copyDir);

const config = {
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY,
};

fs.writeFileSync(
  path.join(dist, 'config.js'),
  `window.__TSC_CONFIG__ = ${JSON.stringify(config)};\n`,
  'utf8'
);

console.log('Built static PWA into dist/');
