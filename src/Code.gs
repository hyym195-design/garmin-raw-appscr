/* Garmin Raw Archive. Credentials belong in Script Properties, never source. */
var BASE_ = 'https://personal.connectapi.garmin.com';
var RANGE_ = {
  daily: '/usersummary-service/v2/dailysummaries?startDate={s}&endDate={e}',
  steps: '/usersummary-service/stats/steps/daily/{s}/{e}',
  stress: '/usersummary-service/stats/stress/daily/{s}/{e}',
  hydration: '/usersummary-service/stats/hydration/daily/{s}/{e}',
  weight: '/weight-service/weight/range/{s}/{e}?includeAll=true',
  weight_goals: '/goal-service/goal/user/effective/weightgoal/{s}/{e}',
  sleep_summary: '/sleep-service/sleep/dailySleepSummariesByDate?startDate={s}&endDate={e}',
  hrv_summary: '/hrv-service/hrv/daily/{s}/{e}',
  body_battery: '/wellness-service/wellness/bodyBattery/reports/daily?startDate={s}&endDate={e}',
  wellness_activities: '/wellnessactivity-service/activity/summary/range/{s}/{e}'
};
var DAY_ = {
  heart_rate: '/wellness-service/wellness/dailyHeartRate?date={d}',
  sleep: '/sleep-service/sleep/dailySleep?date={d}',
  hrv: '/hrv-service/hrv/{d}',
  spo2: '/wellness-service/wellness/daily/spo2acclimation/{d}',
  food: '/nutrition-service/food/logs/{d}',
  fitness_age: '/fitnessage-service/fitnessage/v2/{d}'
};
var PROFILE_ = {
  profile: '/userprofile-service/userprofile/settings',
  heart_rate_zones: '/biometric-service/heartRateZones/v2'
};
var ACTIVE_STATE_ = null;
var ACTIVE_PAGES_ = {};

function props_() { return PropertiesService.getScriptProperties(); }
function today_() { return Utilities.formatDate(new Date(), 'Asia/Jerusalem', 'yyyy-MM-dd'); }
function shift_(d, n) { var x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0,10); }
function validDate_(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v + 'T12:00:00Z').toISOString().slice(0,10) === v; }
function hash_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s,Utilities.Charset.UTF_8).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join(''); }
function template_(p,s,e,d) { return p.replace(/\{s\}/g,s).replace(/\{e\}/g,e).replace(/\{d\}/g,d); }
function error_(code) { var e = new Error(code); e.safeCode = code; return e; }

// Run once from the Apps Script editor after setting Script Properties.
function setup() {
  var p = props_();
  var email = Session.getActiveUser().getEmail();
  if (!email || email !== Session.getEffectiveUser().getEmail()) throw error_('OWNER_ONLY');
  if (!p.getProperty('GARMIN_PERSONAL_API_KEY')) throw error_('SET_GARMIN_PERSONAL_API_KEY');
  if ((p.getProperty('API_ACCESS_KEY') || '').length < 32) throw error_('SET_API_ACCESS_KEY_MIN_32_CHARACTERS');
  var floor = p.getProperty('HISTORY_START') || '2000-01-01';
  if (!validDate_(floor) || floor > today_()) throw error_('INVALID_HISTORY_START');
  p.setProperty('OWNER_EMAIL', email);
  if (!p.getProperty('ARCHIVE_FOLDER_ID')) p.setProperty('ARCHIVE_FOLDER_ID',DriveApp.createFolder('Garmin Raw Archive').getId());
  withLock_(function(){ loadState_(); saveState_(); });
  // Continuation worker: 25 second work budget, 10 minute cadence.
  if (!ScriptApp.getProjectTriggers().some(function(t){return t.getHandlerFunction()==='continueSync_';})) {
    ScriptApp.newTrigger('continueSync_').timeBased().everyMinutes(10).create();
  }
  console.log('Ready. Deploy as a Web App for the owner. Archive data remains private in Drive.');
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) return {busy:true, message:'A synchronization is already running. Try again shortly.'};
  try { ACTIVE_STATE_ = null; ACTIVE_PAGES_={}; return fn(); } finally { ACTIVE_STATE_=null; ACTIVE_PAGES_={}; lock.releaseLock(); }
}
function loadState_() {
  if (ACTIVE_STATE_) return ACTIVE_STATE_;
  var p=props_(), id=p.getProperty('STATE_FILE_ID');
  if (id) ACTIVE_STATE_=JSON.parse(DriveApp.getFileById(id).getBlob().getDataAsString());
  else ACTIVE_STATE_={version:1,createdAt:new Date().toISOString(),historyStart:p.getProperty('HISTORY_START')||'2000-01-01',historyBefore:shift_(today_(),-7),historyComplete:false,lastSync:null,lastAttempt:null,job:null,activityJob:null,activitiesComplete:false,activityLastSync:null,catalogPages:{},folders:{},lastError:null,pausedUntil:0};
  return ACTIVE_STATE_;
}
function saveState_() {
  var p=props_(), s=loadState_(), text=JSON.stringify(s), id=p.getProperty('STATE_FILE_ID');
  if(id) DriveApp.getFileById(id).setContent(text);
  else { var f=DriveApp.getFolderById(p.getProperty('ARCHIVE_FOLDER_ID')).createFile('state.json',text,'application/json'); p.setProperty('STATE_FILE_ID',f.getId()); }
}
function dataFolder_(dataset) {
  var s=loadState_();
  if(!s.folders[dataset]) { s.folders[dataset]=DriveApp.getFolderById(props_().getProperty('ARCHIVE_FOLDER_ID')).createFolder(dataset).getId(); saveState_(); }
  return DriveApp.getFolderById(s.folders[dataset]);
}
function pageKey_(dataset,start) {return dataset+'/'+(/^\d{4}-\d{2}/.test(start)?start.slice(0,7):'other');}
function page_(key) {
  if(ACTIVE_PAGES_[key])return ACTIVE_PAGES_[key];
  var meta=loadState_().catalogPages[key];
  ACTIVE_PAGES_[key]=meta?JSON.parse(DriveApp.getFileById(meta.fileId).getBlob().getDataAsString()):{};
  return ACTIVE_PAGES_[key];
}
function savePage_(key,dataset,entries) {
  var s=loadState_(), meta=s.catalogPages[key], text=JSON.stringify(entries);
  if(meta)DriveApp.getFileById(meta.fileId).setContent(text);
  else {var file=dataFolder_(dataset).createFile('index_'+key.split('/')[1]+'.json',text,'application/json');meta={fileId:file.getId(),dataset:dataset};s.catalogPages[key]=meta;}
  var rows=Object.keys(entries).map(function(k){return entries[k];});
  meta.count=rows.length;meta.start=rows.map(function(r){return r.start;}).sort()[0]||'';meta.end=rows.map(function(r){return r.end;}).sort().pop()||'';
  saveState_();
}
function catalogEntry_(dataset,key,start) {return page_(pageKey_(dataset,start))[key];}
function store_(dataset,key,start,end,path,response,binary) {
  var s=loadState_(), bucket=pageKey_(dataset,start), catalog=page_(bucket);
  var bytes=binary?response.getBlob().getBytes():null;
  var text=binary?null:response.getContentText();
  var digest=binary?Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,bytes).map(function(b){return ('0'+((b+256)%256).toString(16)).slice(-2);}).join(''):hash_(text);
  var old=catalog[key], fetchedAt=new Date().toISOString();
  if(old && old.sha256===digest) { old.lastChecked=fetchedAt; savePage_(bucket,dataset,catalog); return old; }
  // Immutable, content-addressed snapshots. The bytes / text are never normalized.
  var name=key+'__'+digest.slice(0,20)+(binary?'.zip':'.json');
  var folder=dataFolder_(dataset), existing=folder.getFilesByName(name), file;
  if(existing.hasNext()) file=existing.next();
  else file=binary?folder.createFile(response.getBlob().setName(name)):folder.createFile(name,text,'application/json');
  var entry={dataset:dataset,key:key,start:start,end:end,path:path,fileId:file.getId(),sha256:digest,fetchedAt:fetchedAt,lastChecked:fetchedAt,bytes:file.getSize(),format:binary?'zip':'json'};
  catalog[key]=entry; savePage_(bucket,dataset,catalog); return entry;
}
function token_(force) {
  var cache=CacheService.getScriptCache(), cached=cache.get('garmin-bearer');
  if(cached && !force) return cached;
  var key=props_().getProperty('GARMIN_PERSONAL_API_KEY');
  if(!key) throw error_('GARMIN_KEY_NOT_CONFIGURED');
  var r=UrlFetchApp.fetch(BASE_+'/personalapitoken-service/personal-api/personal-api-key/token',{method:'post',headers:{Authorization:'ApiKey '+key},muteHttpExceptions:true,followRedirects:false,timeoutSeconds:15});
  if(r.getResponseCode()!==200) throw error_('TOKEN_HTTP_'+r.getResponseCode());
  // Garmin returns text/plain JWT, not a JSON object.
  var raw=r.getContentText().trim(), tok=raw;
  if(raw.charAt(0)==='{') { var obj=JSON.parse(raw); tok=obj.access_token||obj.accessToken; }
  if(typeof tok!=='string' || tok.split('.').length!==3) throw error_('INVALID_TOKEN_RESPONSE');
  cache.put('garmin-bearer',tok,18000); return tok;
}
function garmin_(path,binary) {
  if(path.charAt(0)!=='/' || path.indexOf('://')>=0 || path.indexOf('..')>=0) throw error_('INVALID_API_PATH');
  var fetch=function(t){return UrlFetchApp.fetch(BASE_+path,{headers:{Authorization:'Bearer '+t},muteHttpExceptions:true,followRedirects:false,timeoutSeconds:15});};
  var r=fetch(token_(false));
  if(r.getResponseCode()===401) r=fetch(token_(true));
  var code=r.getResponseCode();
  if(code!==200 && code!==204) throw error_('GARMIN_HTTP_'+code);
  if(!binary && code!==204) { try {JSON.parse(r.getContentText());} catch(ignore){throw error_('GARMIN_NON_JSON');} }
  if(binary) { var b=r.getBlob().getBytes(); if(b.length<4 || b[0]!==80 || b[1]!==75) throw error_('GARMIN_NON_ZIP'); }
  return r;
}
function requestStore_(dataset,key,start,end,path,binary) {
  var r=garmin_(path,binary); store_(dataset,key,start,end,path,r,binary);
  return !binary && r.getResponseCode()!==204 ? JSON.parse(r.getContentText()) : null;
}
function newRangeJob_(mode,start,end) {
  return {mode:mode,start:start,end:end,stage:'range',index:0,days:[],dayIndex:0,detailIndex:0};
}
function beginLatest_(s) {
  var end=today_(), start=s.lastSync?shift_(s.lastSync.slice(0,10),-3):shift_(end,-6);
  if(start<s.historyStart) start=s.historyStart;
  // Bound a chunk to 28 days even after a long offline interval.
  var chunkEnd=shift_(start,27); if(chunkEnd>end) chunkEnd=end;
  return newRangeJob_('latest',start,chunkEnd);
}
function prepareJob_(s) {
  if(s.job) return;
  if(!s.lastSync || s.lastSync.slice(0,10)<today_() || Date.now()-Date.parse(s.lastSync)>15*60000) s.job=beginLatest_(s);
  else if(!s.historyComplete) {
    var end=s.historyBefore, start=shift_(end,-27);
    if(start<s.historyStart) start=s.historyStart;
    if(end<s.historyStart) s.historyComplete=true;
    else s.job=newRangeJob_('history',start,end);
  }
}
function runRangeStep_(s) {
  var j=s.job;
  if(j.stage==='range') {
    var names=Object.keys(RANGE_);
    if(j.index<names.length) {
      var name=names[j.index], path=template_(RANGE_[name],j.start,j.end,'');
      var data=requestStore_(name,j.start+'_'+j.end,j.start,j.end,path,false);
      // Detailed day endpoints are queued for EVERY date, including empty days.
      j.index++; saveState_(); return;
    }
    j.days=[]; for(var d=j.start;d<=j.end;d=shift_(d,1)) j.days.push(d);
    j.stage='days'; saveState_(); return;
  }
  if(j.dayIndex<j.days.length) {
    var kinds=Object.keys(DAY_), date=j.days[j.dayIndex], kind=kinds[j.detailIndex];
    requestStore_(kind,date,date,date,template_(DAY_[kind],'','',date),false);
    j.detailIndex++; if(j.detailIndex===kinds.length){j.detailIndex=0;j.dayIndex++;}
    saveState_(); return;
  }
  if(j.mode==='history') {s.historyBefore=shift_(j.start,-1); s.historyComplete=s.historyBefore<s.historyStart;}
  else {
    // Advance only through the successfully completed range, never to now if behind.
    s.lastSync=j.end===today_()?new Date().toISOString():j.end+'T23:59:59.000Z';
  }
  s.job=null; s.lastError=null; saveState_();
}
function prepareActivities_(s) {
  if(s.activityJob) return;
  if(!s.activitiesComplete) s.activityJob={start:0,items:null,itemIndex:0,detailIndex:0,from:null};
  else if(!s.activityLastSync || Date.now()-Date.parse(s.activityLastSync)>15*60000) s.activityJob={start:0,items:null,itemIndex:0,detailIndex:0,from:shift_(s.activityLastSync.slice(0,10),-3)};
}
function runActivityStep_(s) {
  var j=s.activityJob;
  if(!j.items) {
    var path='/activitylist-service/activities/search/activities?start='+j.start+'&limit=20'+(j.from?'&startDate='+j.from:'');
    var data=requestStore_('activity_pages',(j.from||'all')+'_'+j.start,j.from||s.historyStart,today_(),path,false);
    if(!Array.isArray(data)) throw error_('INVALID_ACTIVITY_LIST');
    if(!data.length) {s.activitiesComplete=true;s.activityLastSync=new Date().toISOString();s.activityJob=null;saveState_();return;}
    j.items=data.map(function(a){return {id:String(a.activityId),date:String(a.startTimeLocal||'').slice(0,10)};});
    j.itemIndex=0;j.detailIndex=0;saveState_();return;
  }
  if(j.itemIndex>=j.items.length) {j.start+=j.items.length;j.items=null;saveState_();return;}
  var a=j.items[j.itemIndex];
  if(!/^\d+$/.test(a.id)) throw error_('INVALID_ACTIVITY_ID');
  var includeFit=props_().getProperty('INCLUDE_FIT')==='true';
  var type=j.detailIndex===0?'activity':j.detailIndex===1?'activity_workouts':'activity_fit';
  var path=j.detailIndex===0?'/activity-service/activity/'+a.id:j.detailIndex===1?'/activity-service/activity/'+a.id+'/workouts':'/download-service/files/activity/'+a.id;
  requestStore_(type,a.id,a.date,a.date,path,j.detailIndex===2);
  j.detailIndex++; if(j.detailIndex===(includeFit?3:2)){j.detailIndex=0;j.itemIndex++;}
  saveState_();
}
function work_(seconds,forceLatest) {
  return withLock_(function(){
    var s=loadState_(), until=Date.now()+seconds*1000;
    if(Date.now()<s.pausedUntil) return status_(s);
    if(forceLatest) {
      // Preserve the precise historical cursor while giving current data priority.
      if(s.job && s.job.mode==='history') {s.suspendedHistory=s.job;s.job=null;}
      if(!s.job) s.job=beginLatest_(s);
    }
    s.lastAttempt=new Date().toISOString();saveState_();
    try {
      var profileNames=Object.keys(PROFILE_);
      for(var k=0;k<profileNames.length && Date.now()<until;k++) {
        var name=profileNames[k], old=catalogEntry_(name,'current','');
        if(!old || Date.now()-Date.parse(old.lastChecked)>86400000) requestStore_(name,'current','','',PROFILE_[name],false);
      }
      var turn=0;
      while(Date.now()<until) {
        prepareActivities_(s);
        if(s.activityJob && turn++%3===0) {runActivityStep_(s);continue;}
        if(!s.job && s.suspendedHistory && s.lastSync && s.lastSync.slice(0,10)===today_()) {s.job=s.suspendedHistory;delete s.suspendedHistory;}
        prepareJob_(s);
        if(s.job) runRangeStep_(s);
        else if(s.activityJob) runActivityStep_(s);
        else break;
      }
      s.lastError=null;
    } catch(e) {
      s.lastError={code:e.safeCode||'INTERNAL_ERROR',at:new Date().toISOString()};
      // Keep the exact failed cursor. Back off; never interpret errors as empty data.
      s.pausedUntil=Date.now()+(e.safeCode==='GARMIN_HTTP_429'?3600000:600000);
    }
    saveState_();return status_(s);
  });
}
function continueSync_() { if(props_().getProperty('PAUSED')!=='true') work_(25,false); }
function status_(s) {
  var counts={},total=0; Object.keys(s.catalogPages).forEach(function(k){var p=s.catalogPages[k];counts[p.dataset]=(counts[p.dataset]||0)+p.count;total+=p.count;});
  return {historyStart:s.historyStart,historyComplete:s.historyComplete,historyBefore:s.historyBefore,lastSync:s.lastSync,lastAttempt:s.lastAttempt,activitiesComplete:s.activitiesComplete,activityLastSync:s.activityLastSync,job:s.job?{mode:s.job.mode,start:s.job.start,end:s.job.end,stage:s.job.stage,rangeIndex:s.job.index,dayIndex:s.job.dayIndex}:null,activityOffset:s.activityJob?s.activityJob.start:null,counts:counts,totalFiles:total,lastError:s.lastError,pausedUntil:s.pausedUntil,paused:props_().getProperty('PAUSED')==='true',datasets:Object.keys(RANGE_).concat(Object.keys(DAY_),Object.keys(PROFILE_),['activity','activity_workouts','activity_fit','activity_pages'])};
}
function authorized_(key) {
  var expected=props_().getProperty('API_ACCESS_KEY');
  if(!expected || typeof key!=='string' || hash_(key)!==hash_(expected)) throw error_('UNAUTHORIZED');
}
function dispatch_(key,action,args) {
  authorized_(key);args=args||{};
  if(action==='sync') return {ok:true,status:work_(20,true)};
  if(action==='status') return withLock_(function(){return {ok:true,status:status_(loadState_())};});
  if(action==='list' || action==='get') {
    // Every authorized reader can ask for an incremental refresh, not a fresh full import.
    var sync=args.sync!==false?work_(15,true):null;
    return withLock_(function(){
      var s=loadState_(), dataset=args.dataset;
      if(typeof dataset!=='string' || status_(s).datasets.indexOf(dataset)<0) throw error_('INVALID_DATASET');
      if(args.start && !validDate_(args.start) || args.end && !validDate_(args.end)) throw error_('INVALID_DATE');
      var rows=[];
      Object.keys(s.catalogPages).forEach(function(k){var p=s.catalogPages[k];if(p.dataset!==dataset || args.start&&p.end&&p.end<args.start || args.end&&p.start&&p.start>args.end)return;var entries=page_(k);Object.keys(entries).forEach(function(id){var r=entries[id];if((!args.start||!r.end||r.end>=args.start)&&(!args.end||!r.start||r.start<=args.end)&&(!args.key||r.key===String(args.key)))rows.push(r);});});
      rows.sort(function(a,b){return (a.start+'|'+a.key).localeCompare(b.start+'|'+b.key);});
      var offset=Number(args.offset||0), limit=Math.min(Number(args.limit||10),action==='get'?10:100);
      if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1) throw error_('INVALID_PAGINATION');
      var page=rows.slice(offset,offset+limit), result={ok:true,status:status_(s),total:rows.length,nextOffset:offset+page.length<rows.length?offset+page.length:null,records:page};
      if(action==='get') {
        var total=0;
        result.records=page.map(function(r){
          if(r.format!=='json') return {metadata:r,binary:true,message:'Original FIT ZIP is stored privately in Drive; JSON bridge does not stream binary files.'};
          total+=r.bytes;if(total>2*1024*1024) throw error_('RESPONSE_TOO_LARGE_USE_LIMIT_1');
          var raw=DriveApp.getFileById(r.fileId).getBlob().getDataAsString();
          return {metadata:r,raw:raw,data:raw?JSON.parse(raw):null};
        });
      }
      return result;
    });
  }
  throw error_('UNKNOWN_ACTION');
}
function output_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function doPost(e) {
  try {var body=JSON.parse(e.postData.contents);return output_(dispatch_(body.accessKey,body.action,body.params));}
  catch(e) {return output_({ok:false,error:e.safeCode||'INVALID_REQUEST'});}
}
function doGet() { return HtmlService.createHtmlOutputFromFile('Index').setTitle('Garmin · ארכיון נתונים'); }
// The only browser RPC. All server helpers are private (underscore suffix).
function api(accessKey,action,args) {
  try{return dispatch_(accessKey,action,args);}catch(e){return {ok:false,error:e.safeCode||'INTERNAL_ERROR'};}
}
