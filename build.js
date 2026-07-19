import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let html = fs.readFileSync(path.join(__dirname, 'index.template.html'), 'utf8');

const replacements = {
  '__SOSO_API_KEY__': process.env.SOSO_API_KEY || '',
  '__GROQ_API_KEY__': process.env.GROQ_API_KEY || '',
  '__SODEX_API_KEY__': process.env.SODEX_API_KEY || '',
  '__SODEX_API_SECRET__': process.env.SODEX_API_SECRET || ''
};

for (const [key, val] of Object.entries(replacements)) {
  html = html.split(key).join(val);
}

fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('Build complete: API keys injected from env vars');
