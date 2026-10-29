import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const win=process.platform==='win32';
function run(command,args){const r=spawnSync(command,args,{stdio:'inherit',shell:win});if(r.status!==0){console.error('Stopped. Resolve the error above and run setup again.');process.exit(r.status||1);}}
if(Number(process.versions.node.split('.')[0])<20)throw new Error('Node.js 20 or newer is required.');
if(!existsSync('node_modules/@google/clasp'))run('npm',['ci','--ignore-scripts']);
const cli=resolve('node_modules/.bin/clasp'+(win?'.cmd':''));
console.log('Sign into Google in the browser. No password or authorization code should be pasted into chat.');
run(cli,['login']);
// clasp create may generate a default manifest; preserve the reviewed scopes/access.
const manifest=readFileSync('src/appsscript.json','utf8');
if(!existsSync('.clasp.json'))run(cli,['create-script','--title','Garmin Raw Archive','--type','standalone','--rootDir','src']);
writeFileSync('src/appsscript.json',manifest);
const config=JSON.parse(readFileSync('.clasp.json','utf8'));
config.rootDir='src';writeFileSync('.clasp.json',JSON.stringify(config,null,2)+'\n');
run('npm',['test']);run(cli,['push']);
console.log('\nCode uploaded. Open Project Settings and set these Script Properties:');
console.log('  GARMIN_PERSONAL_API_KEY: your Garmin key');
console.log('  API_ACCESS_KEY: a separate random secret, at least 32 characters');
console.log('  HISTORY_START: optional, default 2000-01-01 (full historical scan)');
console.log('  INCLUDE_FIT: optional true to archive original activity ZIP files');
console.log('Then run setup once in the editor and approve the required Google scopes.');
console.log('Deployment remains owner-only. See README for external client access.');
run(cli,['open-script']);
