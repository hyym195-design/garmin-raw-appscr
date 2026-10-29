const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');

function env(fetcher){
 const properties={GARMIN_PERSONAL_API_KEY:'TEST_ONLY_NOT_A_REAL_KEY',API_ACCESS_KEY:'test-archive-access-key-32-characters',ARCHIVE_FOLDER_ID:'root'};
 const files=new Map(),folders=new Map(),cache=new Map();let number=0;
 function folder(id){if(folders.has(id))return folders.get(id);const f={id,getId:()=>id,createFolder:()=>folder('folder'+ ++number),getFilesByName:name=>{const matches=[...files.values()].filter(x=>x.parent===id&&x.name===name);let i=0;return {hasNext:()=>i<matches.length,next:()=>matches[i++]};},createFile:(name,text,type)=>{const k='file'+ ++number;const x={id:k,parent:id,name,text,type,getId:()=>k,setContent:v=>{x.text=v;return x;},getSize:()=>Buffer.byteLength(x.text),getBlob:()=>({getDataAsString:()=>x.text})};files.set(k,x);return x;}};folders.set(id,f);return f;}
 folder('root');
 const c={console,Date,JSON,Math,Number,String,Object,Array,RegExp,Error,isNaN,parseInt,
  PropertiesService:{getScriptProperties:()=>({getProperty:k=>properties[k]??null,setProperty:(k,v)=>{properties[k]=v;}})},
  Utilities:{formatDate:()=> '2026-10-29',DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(alg,s)=>Array.from(crypto.createHash('sha256').update(typeof s==='string'?s:Buffer.from(s)).digest()).map(b=>b>127?b-256:b)},
  DriveApp:{getFileById:id=>{if(!files.has(id))throw new Error('missing file');return files.get(id);},getFolderById:folder,createFolder:()=>folder('folder'+ ++number)},
  CacheService:{getScriptCache:()=>({get:k=>cache.get(k)||null,put:(k,v)=>cache.set(k,v)})},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})},
  Session:{getActiveUser:()=>({getEmail:()=> 'owner@example.com'}),getEffectiveUser:()=>({getEmail:()=> 'owner@example.com'})},
  ScriptApp:{getProjectTriggers:()=>[],newTrigger:()=>({timeBased(){return this;},everyMinutes(){return this;},create(){return this;}})},
  ContentService:{MimeType:{JSON:'application/json'},createTextOutput:text=>({text,setMimeType(){return this;}})},
  UrlFetchApp:{fetch:(url,opt)=>fetcher?fetcher(url,opt):response('{}')}
 };
 vm.createContext(c);vm.runInContext(fs.readFileSync('src/Code.gs','utf8'),c);return {c,properties,files,folders,cache};
}
function response(text,code=200){return {getResponseCode:()=>code,getContentText:()=>text,getBlob:()=>({getDataAsString:()=>text})};}

test('API rejects an unauthenticated request before fetching data',()=>{
 let calls=0;const {c}=env(()=>{calls++;return response('{}');});
 assert.throws(()=>c.dispatch_('wrong','sync',{}),/UNAUTHORIZED/);assert.equal(calls,0);
 assert.equal(JSON.parse(c.doPost({postData:{contents:JSON.stringify({accessKey:'wrong',action:'status'})}}).text).error,'UNAUTHORIZED');
});
test('token endpoint plain text JWT is accepted and never added to the catalog',()=>{
 let calls=0;const {c,cache}=env((url,opt)=>{calls++;assert.equal(opt.method,'post');assert.equal(opt.headers.Accept,undefined);return response('  abc.def.ghi\n');});
 assert.equal(c.token_(false),'abc.def.ghi');assert.equal(c.token_(false),'abc.def.ghi');assert.equal(calls,1);assert.equal(cache.get('garmin-bearer'),'abc.def.ghi');
 assert.equal(Object.keys(c.loadState_().catalogPages).length,0);
});
test('archive preserves raw whitespace, deduplicates unchanged responses, and retains previous changed snapshots',()=>{
 const {c,files}=env();let a=' {"x": 1, "hebrew":"שלום"}\n';
 c.store_('daily','one','2026-10-29','2026-10-29','/test',response(a),false);
 const first=c.catalogEntry_('daily','one','2026-10-29').fileId;
 assert.equal(files.get(first).text,a);const count=files.size;
 c.store_('daily','one','2026-10-29','2026-10-29','/test',response(a),false);assert.equal(files.size,count);
 c.store_('daily','one','2026-10-29','2026-10-29','/test',response('{"x":2}'),false);
 assert.notEqual(c.catalogEntry_('daily','one','2026-10-29').fileId,first);assert.equal(files.get(first).text,a);
});
test('range import includes details even for empty historical dates',()=>{
 const {c}=env();const s=c.loadState_();s.job=c.newRangeJob_('history','2026-10-01','2026-10-02');
 c.requestStore_=()=>({data:[]});
 for(let i=0;i<100&&s.job;i++)c.runRangeStep_(s);
 assert.equal(s.job,null);assert.equal(s.historyBefore,'2026-09-30');
});
test('failed request keeps the exact detail cursor and can resume without skipping',()=>{
 const {c}=env();const s=c.loadState_();s.job={mode:'history',start:'2026-10-01',end:'2026-10-02',stage:'days',index:10,days:['2026-10-01','2026-10-02'],dayIndex:0,detailIndex:2};
 c.requestStore_=()=>{throw c.error_('GARMIN_HTTP_429');};
 assert.throws(()=>c.runRangeStep_(s),/GARMIN_HTTP_429/);assert.equal(s.job.dayIndex,0);assert.equal(s.job.detailIndex,2);
 c.saveState_();c.ACTIVE_STATE_=null;const reloaded=c.loadState_();assert.equal(reloaded.job.detailIndex,2);
 c.requestStore_=()=>({});c.runRangeStep_(reloaded);assert.equal(reloaded.job.detailIndex,3);
});
test('latest refresh uses three-day overlap and advances only to completed chunk end',()=>{
 const {c}=env();const s=c.loadState_();s.lastSync='2026-09-01T12:00:00Z';
 const j=c.beginLatest_(s);assert.equal(j.start,'2026-08-29');assert.equal(j.end,'2026-09-25');
 s.job={...j,stage:'days',days:[],dayIndex:0};c.runRangeStep_(s);
 assert.equal(s.lastSync,'2026-09-25T23:59:59.000Z');assert.notEqual(s.lastSync.slice(0,10),'2026-10-29');
});
test('activity pagination continues until a verified empty page; details do not advance early',()=>{
 const {c}=env();const s=c.loadState_();c.prepareActivities_(s);let paths=[];
 c.requestStore_=(dataset,key,start,end,path)=>{paths.push(path);if(dataset==='activity_pages')return path.includes('start=0&')?[{activityId:123,startTimeLocal:'2020-01-01 10:00:00'}]:[];return {};};
 c.runActivityStep_(s);assert.equal(s.activityJob.start,0);
 c.runActivityStep_(s);assert.equal(s.activityJob.itemIndex,0);
 c.runActivityStep_(s);assert.equal(s.activityJob.itemIndex,1);
 c.runActivityStep_(s);assert.equal(s.activityJob.start,1);
 c.runActivityStep_(s);assert.equal(s.activityJob,null);assert.equal(s.activitiesComplete,true);
 assert.equal(paths.length,4);
});
test('date filters return overlapping whole raw files with pagination and original raw payload',()=>{
 const {c,properties}=env();for(let n=1;n<=3;n++)c.store_('daily','k'+n,'2026-10-01','2026-10-28','/test',response('{"batch":'+n+'}'),false);
 const result=c.dispatch_(properties.API_ACCESS_KEY,'get',{dataset:'daily',start:'2026-10-20',end:'2026-10-22',sync:false,limit:2});
 assert.equal(result.total,3);assert.equal(result.nextOffset,2);assert.equal(result.records[0].raw,'{"batch":1}');
 assert.equal(c.dispatch_(properties.API_ACCESS_KEY,'get',{dataset:'daily',start:'2026-11-01',sync:false}).total,0);
});
test('invalid dates, unknown datasets and dangerous API paths fail closed',()=>{
 const {c,properties}=env();assert.equal(c.validDate_('2026-02-30'),false);
 assert.throws(()=>c.dispatch_(properties.API_ACCESS_KEY,'get',{dataset:'nope',sync:false}),/INVALID_DATASET/);
 assert.throws(()=>c.dispatch_(properties.API_ACCESS_KEY,'list',{dataset:'daily',start:'2026-02-30',sync:false}),/INVALID_DATE/);
 assert.throws(()=>c.garmin_('https://attacker.example'),/INVALID_API_PATH/);
});
test('history coverage completes only after the configured floor is reached',()=>{
 const {c}=env();const s=c.loadState_();s.historyStart='2026-10-01';s.job={...c.newRangeJob_('history','2026-10-01','2026-10-02'),stage:'days',days:[]};c.runRangeStep_(s);
 assert.equal(s.historyComplete,true);assert.equal(s.historyBefore,'2026-09-30');
});
test('public RPC surface contains no unauthenticated continuation worker',()=>{
 const source=fs.readFileSync('src/Code.gs','utf8');const names=[...source.matchAll(/^function (\w+)\(/gm)].map(m=>m[1]).filter(x=>!x.endsWith('_'));
 assert.deepEqual(names.sort(),['api','doGet','doPost','setup']);
});
test('secrets and Garmin bearer credentials are absent from repository sources',()=>{
 for(const name of ['src/Code.gs','src/Index.html','scripts/setup.mjs','.github/workflows/push-appscript.yml'])assert.ok(!/GCDC_[a-f\d-]+\./i.test(fs.readFileSync(name,'utf8')));
});
