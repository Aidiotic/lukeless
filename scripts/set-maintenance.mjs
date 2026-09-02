#!/usr/bin/env node
/* Flips config.js's maintenance flag. Exists so restart.sh (and anything else
 * that needs this) never has to hand-quote a notice string through a shell —
 * JSON.stringify handles quotes, apostrophes and newlines in the message
 * without any of that.
 *
 *   node scripts/set-maintenance.mjs true "back in five minutes"
 *   node scripts/set-maintenance.mjs false
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const CONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '../config.js');
const [flagArg, ...rest] = process.argv.slice(2);

if (flagArg !== 'true' && flagArg !== 'false') {
  console.error('usage: set-maintenance.mjs <true|false> [notice text]');
  process.exit(1);
}

let text = readFileSync(CONFIG, 'utf8');
text = text.replace(/maintenance:\s*(true|false)/, `maintenance: ${flagArg}`);

if (rest.length) {
  const notice = rest.join(' ');
  text = text.replace(/maintenanceNotice:\s*(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/, `maintenanceNotice: ${JSON.stringify(notice)}`);
}

writeFileSync(CONFIG, text);
console.log(`config.js: maintenance -> ${flagArg}`);
