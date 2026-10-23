const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

// Validar perfil de administrador
function isAdmin(){
  return String(state.user?.role || '')
    .trim()
    .toLowerCase() === 'administrador';
}

const params=new URLSearchParams(window.location.search);
const DEVICE_ZONE=params.get('zona')==='1'?'Zona 1':params.get('zona')==='2'?'Zona 2':null;

let state={
  user:null,
  round:null,
  loc:null,
  scanner:null,
  gps:null,
  selectedZone:DEVICE_ZONE,
  reasonMode:null,
  reasonReturn:null
};

function show(id){
  $$('.screen').forEach(x=>x.classList.remove('active'));
  $('#'+id).classList.add('active');
  if(id==='scan'){
    updateScanHeader();
    startScanner();
  }
  if(id==='dashboard') renderDashboard();
}


let busyCount=0;

function setLoading(on,text='Procesando...'){
  const overlay=$('#loadingOverlay');
  const label=$('#loadingText');

  if(on){
    busyCount++;
    if(label) label.textContent=text;
    if(overlay) overlay.classList.add('show');
    document.body.classList.add('busy');

    // Deshabilita acciones para evitar dobles toques
    $$('button').forEach(b=>{
      if(!b.dataset.prevDisabled){
        b.dataset.prevDisabled=b.disabled?'1':'0';
      }
      b.disabled=true;
    });
  }else{
    busyCount=Math.max(0,busyCount-1);
    if(busyCount===0){
      if(overlay) overlay.classList.remove('show');
      document.body.classList.remove('busy');

      $$('button').forEach(b=>{
        if(b.dataset.prevDisabled!==undefined){
          b.disabled=b.dataset.prevDisabled==='1';
          delete b.dataset.prevDisabled;
        }
      });

      // Recalcular botones dependientes del estado
      try{canStart()}catch(e){}
    }
  }
}

async function withLoading(text,fn){
  if(document.body.classList.contains('busy')) return;
  setLoading(true,text);
  try{
    return await fn();
  }finally{
    setLoading(false);
  }
}

function now(){return new Date().toISOString()}
function normalizeRut(s){return (s||'').replace(/[^0-9kK]/g,'').toUpperCase()}

function formatRut(value){
  let clean=normalizeRut(value).slice(0,9);
  if(clean.length<=1) return clean;
  const dv=clean.slice(-1);
  let body=clean.slice(0,-1);

  // Thousands separators for Chilean RUT
  body=body.replace(/\B(?=(\d{3})+(?!\d))/g,'.');
  return `${body}-${dv}`;
}

function rutIsStructurallyValid(value){
  const clean=normalizeRut(value);
  // 7-8 digit body + verifier = 8-9 characters total
  return /^[0-9]{7,8}[0-9K]$/.test(clean);
}

function getRutPin(value){
  const clean=normalizeRut(value);
  if(clean.length<2) return '';
  return clean.slice(0,-1).slice(-4);
}

const OFFLINE_QUEUE_KEY='rv_offline_queue_v1';
const ID_MAP_KEY='rv_id_map_v1';
const DASH_CACHE_KEY='rv_dashboard_cache_v1';
const AUTH_PREFIX='rv_auth_v1_';
let syncInProgress=false;

function readJson(key,fallback){
  try{
    const v=JSON.parse(localStorage.getItem(key)||'null');
    return v ?? fallback;
  }catch(e){return fallback}
}
function writeJson(key,value){
  localStorage.setItem(key,JSON.stringify(value));
}
function getQueue(){return readJson(OFFLINE_QUEUE_KEY,[])}
function saveQueue(q){writeJson(OFFLINE_QUEUE_KEY,q)}
function getIdMap(){return readJson(ID_MAP_KEY,{})}
function saveIdMap(m){writeJson(ID_MAP_KEY,m)}

function queueableAction(action){
  return ['start','saveFloor','finish','notRun','interrupt'].includes(action);
}

function makeQueueId(){
  return 'Q-'+Date.now()+'-'+Math.random().toString(36).slice(2,8);
}

function enqueueAction(action,payload){
  const q=getQueue();
  q.push({
    qid:makeQueueId(),
    action,
    payload,
    createdAt:new Date().toISOString(),
    attempts:0
  });
  saveQueue(q);
  updateConnectivityUI();
}

function mappedId(id){
  const map=getIdMap();
  return map[id] || id;
}

function remapPayload(action,payload){
  const p=JSON.parse(JSON.stringify(payload||{}));
  if(action==='saveFloor' && p.round?.id) p.round.id=mappedId(p.round.id);
  if(['finish','interrupt'].includes(action) && p.id) p.id=mappedId(p.id);
  return p;
}

function replaceLocalRoundId(localId,serverId){
  if(!localId || !serverId || localId===serverId) return;

  const map=getIdMap();
  map[localId]=serverId;
  saveIdMap(map);

  if(state.round?.id===localId){
    state.round.id=serverId;
    persistActive();
  }

  // Actualiza cualquier ronda activa guardada en este teléfono.
  Object.keys(localStorage).forEach(k=>{
    if(!k.startsWith('rv_active_')) return;
    try{
      const r=JSON.parse(localStorage.getItem(k)||'null');
      if(r?.id===localId){
        r.id=serverId;
        localStorage.setItem(k,JSON.stringify(r));
      }
    }catch(e){}
  });

  // Reescribe acciones pendientes para que apunten al ID definitivo.
  const q=getQueue().map(item=>{
    item.payload=remapPayload(item.action,item.payload);
    return item;
  });
  saveQueue(q);
}

async function fetchWithTimeout(url,options={},timeoutMs=5000){
  const controller=new AbortController();
  const t=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    return await fetch(url,{...options,signal:controller.signal});
  }finally{
    clearTimeout(t);
  }
}

async function apiDirect(action,payload={}){
  if(CONFIG.DEMO_MODE) return demoApi(action,payload);

  const r=await fetchWithTimeout(CONFIG.API_URL,{
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify({action,payload})
  },25000);

  if(!r.ok) throw new Error('HTTP '+r.status);
  return await r.json();
}

async function hashText(text){
  if(!crypto?.subtle) return btoa(unescape(encodeURIComponent(String(text))));
  const buf=await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(String(text))
  );
  return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function cacheAuthenticatedUser(rut,pin,user){
  const key=AUTH_PREFIX+normalizeRut(rut);
  writeJson(key,{
    user,
    pinHash:await hashText(pin),
    cachedAt:Date.now(),
    expiresAt:Date.now()+(7*24*60*60*1000)
  });
}

async function offlineLogin(rut,pin){
  const cached=readJson(AUTH_PREFIX+normalizeRut(rut),null);
  if(!cached) return {ok:false,error:'Sin conexión. Este usuario aún no ha iniciado sesión en este teléfono.'};
  if(cached.expiresAt && Date.now()>cached.expiresAt)
    return {ok:false,error:'La autorización offline venció. Conéctate a internet para validar nuevamente.'};
  const pinHash=await hashText(pin);
  if(pinHash!==cached.pinHash) return {ok:false,error:'PIN incorrecto'};
  return {ok:true,user:cached.user,offline:true};
}

async function api(action,payload={}){
  // Lecturas con fallback local.
  if(action==='login'){
    if(!navigator.onLine) return offlineLogin(payload.rut,payload.pin);
    try{
      const r=await apiDirect(action,payload);
      if(r?.ok) await cacheAuthenticatedUser(payload.rut,payload.pin,r.user);
      return r;
    }catch(e){
      return offlineLogin(payload.rut,payload.pin);
    }
  }

  if(action==='resume'){
    if(!navigator.onLine) return {ok:true,round:getActive(),offline:true};
    try{
      return await apiDirect(action,payload);
    }catch(e){
      return {ok:true,round:getActive(),offline:true};
    }
  }

  if(action==='dashboard'){
    if(!navigator.onLine){
      const cached=readJson(DASH_CACHE_KEY,null);
      return cached ? {...cached,offline:true} : {ok:false,error:'Sin conexión y sin datos de dashboard almacenados.'};
    }
    try{
      const r=await apiDirect(action,payload);
      if(r?.ok) writeJson(DASH_CACHE_KEY,r);
      return r;
    }catch(e){
      const cached=readJson(DASH_CACHE_KEY,null);
      return cached ? {...cached,offline:true} : {ok:false,error:'No fue posible cargar el dashboard.'};
    }
  }

  // Escrituras: local-first. La interfaz continúa al instante y sincroniza detrás.
  if(queueableAction(action)){
    const localPayload=JSON.parse(JSON.stringify(payload||{}));
    enqueueAction(action,localPayload);

    // Intentar sincronizar inmediatamente, sin bloquear la experiencia.
    setTimeout(()=>processQueue(),50);

    if(action==='start'){
      return {ok:true,queued:true,id:payload.id};
    }
    return {ok:true,queued:true};
  }

  return apiDirect(action,payload);
}


function normalizeBackendError(result){
  return String(result?.error||'').trim().toLowerCase();
}

function alreadyAppliedResult(item,result){
  const err=normalizeBackendError(result);

  // START: if backend says there is already an active round, the original
  // start most likely arrived. Use the server round ID and continue.
  if(item.action==='start' && result?.activeRound?.id){
    return {
      applied:true,
      serverId:result.activeRound.id,
      reason:'Ronda ya existente en servidor'
    };
  }

  // FLOOR: this exact validation is positive evidence that the same floor
  // was already persisted. It is safe to acknowledge the queued retry.
  if(item.action==='saveFloor' &&
     (err.includes('este piso ya fue registrado') ||
      err.includes('piso ya fue registrado'))){
    return {applied:true,reason:'Piso ya registrado en servidor'};
  }

  // FINISH: if a retry reaches a round already finalized, do not block
  // subsequent queue entries.
  if(item.action==='finish' &&
     (err.includes('ya fue finalizada') ||
      err.includes('ya está finalizada') ||
      err.includes('ya esta finalizada') ||
      err.includes('ronda finalizada'))){
    return {applied:true,reason:'Ronda ya finalizada en servidor'};
  }

  // INTERRUPT: same principle only for explicit "already interrupted" replies.
  if(item.action==='interrupt' &&
     (err.includes('ya fue interrumpida') ||
      err.includes('ya está interrumpida') ||
      err.includes('ya esta interrumpida'))){
    return {applied:true,reason:'Ronda ya interrumpida en servidor'};
  }

  return {applied:false};
}

async function processQueue(){
  if(syncInProgress || !navigator.onLine || CONFIG.DEMO_MODE){
    updateConnectivityUI();
    return;
  }

  syncInProgress=true;
  updateConnectivityUI(true);

  try{
    let q=getQueue();

    while(q.length && navigator.onLine){
      const item=q[0];
      item.attempts=(item.attempts||0)+1;
      item.lastAttemptAt=new Date().toISOString();
      item.lastError='';
      saveQueue(q);
      updateConnectivityUI(true);

      try{
        const payload=remapPayload(item.action,item.payload);
        const result=await apiDirect(item.action,payload);

        // Confirmación normal o recuperación de una operación que ya había
        // llegado al servidor pero cuya respuesta se perdió/agotó.
        if(!result || result.ok!==true){
          const recovered=alreadyAppliedResult(item,result);

          if(!recovered.applied){
            item.lastError=result?.error||'Backend sin confirmación';
            saveQueue(q);
            scheduleSyncRetry();
            break;
          }

          if(item.action==='start' && recovered.serverId){
            replaceLocalRoundId(item.payload?.id,recovered.serverId);
          }

          item.recovered=true;
          item.recoveredReason=recovered.reason;
        }else if(item.action==='start' && result.id){
          replaceLocalRoundId(item.payload?.id,result.id);
        }

        // Solo aquí se retira el pendiente: confirmación OK o evidencia
        // explícita de que la operación ya existe en servidor.
        q=getQueue().filter(x=>x.qid!==item.qid);
        saveQueue(q);
        updateConnectivityUI(true);

      }catch(e){
        item.lastError=(e?.name==='AbortError')
          ? 'Tiempo de espera agotado'
          : (e?.message||'Error de conexión');
        saveQueue(q);
        scheduleSyncRetry();
        break;
      }
    }
  }finally{
    syncInProgress=false;
    updateConnectivityUI();
  }
}

let syncRetryTimer=null;
function scheduleSyncRetry(){
  if(syncRetryTimer) clearTimeout(syncRetryTimer);
  if(!navigator.onLine) return;
  syncRetryTimer=setTimeout(()=>{
    syncRetryTimer=null;
    processQueue();
  },15000);
}

function exportPendingBackup(){
  const data={
    version:'9.2-recovery',
    exportedAt:new Date().toISOString(),
    pending:getQueue(),
    idMap:getIdMap(),
    activeRound:getActive(),
    user:state.user ? {
      rut:state.user.rut||'',
      name:state.user.name||''
    } : null
  };

  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url;
  a.download='respaldo_rondas_pendientes_'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function updateConnectivityUI(forceSyncing=false){
  const bar=$('#syncBar');
  const status=$('#syncStatus');
  const detail=$('#syncDetail');
  const btn=$('#btnSyncNow');
  const hint=$('#offlineLoginHint');
  if(!bar) return;

  const pending=getQueue().length;
  const online=navigator.onLine;

  bar.classList.toggle('offline',!online);
  bar.classList.toggle('pending',online && pending>0);
  bar.classList.toggle('online',online && pending===0 && !forceSyncing);

  if(forceSyncing || syncInProgress){
    status.textContent='Sincronizando';
    detail.textContent=pending ? `${pending} registro${pending===1?'':'s'} pendiente${pending===1?'':'s'}` : 'Comprobando datos';
    btn.style.display='none';
  }else if(!online){
    status.textContent='Sin conexión';
    detail.textContent=pending ? `${pending} registro${pending===1?'':'s'} guardado${pending===1?'':'s'} en el teléfono` : 'Puedes continuar la ronda';
    btn.style.display='none';
  }else if(pending>0){
    status.textContent='Pendiente de sincronizar';
    const first=getQueue()[0];
    const err=first?.lastError ? ` · Último intento: ${first.lastError}` : '';
    detail.textContent=`${pending} registro${pending===1?'':'s'} pendiente${pending===1?'':'s'}${err}`;
    btn.style.display='inline-flex';
  }else{
    status.textContent='En línea';
    detail.textContent='Todo sincronizado';
    btn.style.display='none';
  }

  if(hint) hint.style.display=online?'none':'block';
}

window.addEventListener('online',()=>{
  updateConnectivityUI();
  processQueue();
});
window.addEventListener('offline',updateConnectivityUI);

function demoDb(){
  return JSON.parse(localStorage.getItem('rv_demo')||'{"rounds":[]}');
}
function saveDb(db){localStorage.setItem('rv_demo',JSON.stringify(db))}
function activeKey(){return 'rv_active_'+normalizeRut(state.user?.rut||'')}
function persistActive(){
  if(state.user && state.round) localStorage.setItem(activeKey(),JSON.stringify(state.round));
}
function clearActive(){
  if(state.user) localStorage.removeItem(activeKey());
}
function getActive(){
  if(!state.user) return null;
  try{return JSON.parse(localStorage.getItem(activeKey())||'null')}catch(e){return null}
}
function syncHomeForActive(){
  const active=getActive();
  const resume=$('#resumeCard');
  const fresh=$('#newRoundCard');
  if(active && active.status==='En curso'){
    state.round=active;
    state.selectedZone=active.zone;
    resume.style.display='block';
    fresh.style.display='none';
    const registrados=(active.visits||[]).length;
    $('#resumeInfo').textContent=`${active.zone} · ${registrados} ${registrados===1?'sector/piso registrado':'sectores/pisos registrados'}`;
  }else{
    resume.style.display='none';
    fresh.style.display='block';
  }
}


function logoutToLogin(message){
  stopScanner();
  if(message) alert(message);

  state.user=null;
  state.round=null;
  state.loc=null;
  state.gps=null;
  state.reasonMode=null;
  state.reasonReturn=null;
  state.selectedZone=DEVICE_ZONE;

  $('#rut').value='';
  $('#pin').value='';
  $('#startPhoto').value='';
  $('#endPhoto').value='';
  $('#btnStart').disabled=true;
  if($('#btnNotRun')) $('#btnNotRun').disabled=true;

  $$('.zoneBtn').forEach(x=>{
    x.classList.toggle('selected',x.dataset.zone===DEVICE_ZONE);
  });

  if($('#zoneSelected')){
    $('#zoneSelected').textContent=DEVICE_ZONE
      ? 'Teléfono configurado: '+DEVICE_ZONE
      : 'Selecciona una zona';
  }

  show('login');
  setTimeout(()=>$('#rut')?.focus(),150);
}

function openReason(mode,returnScreen){
  state.reasonMode=mode;
  state.reasonReturn=returnScreen || (mode==='notRun'?'home':'scan');

  $('#reasonHeader').textContent = mode==='notRun'
    ? 'No realizar ronda'
    : 'Interrumpir ronda';

  $('#reasonTitle').textContent = mode==='notRun'
    ? 'MOTIVO DE NO REALIZACIÓN'
    : 'MOTIVO DE INTERRUPCIÓN';

  $('#otherReasonBox').style.display='none';
  $('#otherReason').value='';
  show('reason');
}

async function submitReason(reason){
  reason=(reason||'').trim();
  if(!reason) return alert('Selecciona o escribe un motivo.');

  const gps=await getGps();

  if(state.reasonMode==='notRun'){
    const result=await api('notRun',{
      user:state.user,
      zone:state.selectedZone,
      turno:state.user?.turnoHabitual||'',
      gps,
      startPhotoName:$('#startPhoto').files[0]?.name||'',
      reason
    });

    if(!result?.ok){
      return alert(result?.error || 'No fue posible registrar la no realización.');
    }

    clearActive();
    logoutToLogin(result?.queued
      ? 'Registro guardado en el teléfono. Se sincronizará automáticamente.'
      : 'Registro guardado. La ronda quedó como No realizada.');
    return;
  }

  if(state.reasonMode==='interrupt'){
    if(!state.round?.id) return alert('No hay una ronda activa.');

    const result=await api('interrupt',{
      id:state.round.id,
      reason,
      gps
    });

    if(!result?.ok){
      return alert(result?.error || 'No fue posible interrumpir la ronda.');
    }

    clearActive();
    logoutToLogin(result?.queued
      ? 'Ronda interrumpida. Registro guardado y pendiente de sincronización.'
      : 'Ronda interrumpida y registrada correctamente.');
  }
}

async function demoApi(action,p={}){
  let db=demoDb();
  if(action==='login'){
    const nr=normalizeRut(p.rut);
    const rutPin=getRutPin(p.rut);
    if(normalizeRut(p.rut)===normalizeRut(CONFIG.DEMO_RUT) && (p.pin===CONFIG.DEMO_PIN || p.pin===rutPin))
      return {ok:true,user:{rut:p.rut,name:CONFIG.DEMO_NAME}};
    return {ok:false,error:'RUT o PIN incorrecto'};
  }
  if(action==='start'){
    db.rounds.push(p); saveDb(db); return {ok:true};
  }
  if(action==='update'){
    let r=db.rounds.find(x=>x.id===p.id);
    if(r) Object.assign(r,p.patch);
    saveDb(db); return {ok:true};
  }
  if(action==='dashboard') return {ok:true,rounds:db.rounds};
  return {ok:true};
}

async function getGps(){
  return new Promise(res=>
    navigator.geolocation
      ? navigator.geolocation.getCurrentPosition(
          p=>res({lat:p.coords.latitude,lng:p.coords.longitude,acc:p.coords.accuracy}),
          ()=>res(null),
          {enableHighAccuracy:true,timeout:8000}
        )
      : res(null)
  );
}

function canStart(){
  const ready=!!(
    state.selectedZone &&
    $('#startPhoto').files.length
  );
  $('#btnStart').disabled=!ready;
  if($('#btnNotRun')) $('#btnNotRun').disabled=!ready;
}

$$('.zoneBtn').forEach(btn=>{
  btn.onclick=()=>{
    state.selectedZone=btn.dataset.zone;
    $$('.zoneBtn').forEach(x=>x.classList.toggle('selected',x===btn));
    $('#zoneSelected').textContent='Seleccionada: '+state.selectedZone;
    canStart();
  };
});


const rutInput=$('#rut');

rutInput.addEventListener('input',e=>{
  // Accept pasted/formatted/unformatted RUT, limit to 8-digit body + DV
  const cursorAtEnd=e.target.selectionStart===e.target.value.length;
  e.target.value=formatRut(e.target.value);
  if(cursorAtEnd) e.target.setSelectionRange(e.target.value.length,e.target.value.length);
});

rutInput.addEventListener('blur',e=>{
  e.target.value=formatRut(e.target.value);
});

rutInput.addEventListener('keydown',e=>{
  if(e.key==='Enter') $('#pin').focus();
});

$('#pin').addEventListener('keydown',e=>{
  if(e.key==='Enter') $('#btnLogin').click();
});

if($('#btnSyncNow')){
  $('#btnSyncNow').onclick=()=>processQueue();
}

if($('#btnBackupPending')){
  $('#btnBackupPending').onclick=()=>exportPendingBackup();
}


$('#btnLogin').onclick=async()=>{
  $('#rut').value=formatRut($('#rut').value);

  if(!rutIsStructurallyValid($('#rut').value))
    return alert('Ingresa un RUT válido.');

  if(!/^\d{4}$/.test($('#pin').value))
    return alert('El PIN debe tener 4 dígitos.');

  return withLoading('Validando acceso...',async()=>{
    let r=await api('login',{rut:$('#rut').value,pin:$('#pin').value});
    if(!r.ok) return alert(r.error);
  state.user=r.user;
  $('#userName').textContent=r.user.name;
  if(DEVICE_ZONE){
    state.selectedZone=DEVICE_ZONE;
    $$('.zoneBtn').forEach(x=>x.classList.toggle('selected',x.dataset.zone===DEVICE_ZONE));
    $('#zoneSelected').textContent='Teléfono configurado: '+DEVICE_ZONE;
    $$('.zoneBtn').forEach(x=>x.style.display='none');
  }

  try{
    const rr=await api('resume',{rut:state.user.rut});
    if(rr?.ok && rr.round){
      state.round=rr.round;
      state.selectedZone=rr.round.zone || DEVICE_ZONE;
      localStorage.setItem(activeKey(),JSON.stringify(rr.round));
    }
  }catch(e){
    console.warn('No se pudo consultar la ronda activa del backend',e);
  }

  state.gps=await getGps();
  $('#gpsStatus').textContent=state.gps?'Ubicación disponible':'Ubicación no disponible';

// Determinar pantalla según perfil
if(isAdmin()){

  if($('#dashUser')){
    $('#dashUser').textContent =
      state.user.name || 'Administrador';
  }

  if($('#btnDashboard')){
    $('#btnDashboard').style.display = '';
  }

  show('dashboard');

}else{

  // Vigilantes, supervisores y guardias
  // ingresan a realizar rondas

  if($('#btnDashboard')){
    $('#btnDashboard').style.display = 'none';
  }

  syncHomeForActive();
  show('home');

}
  });
};

setInterval(()=>{
  let e=$('#clock');
  if(e) e.textContent=new Date().toLocaleString('es-CL');
},1000);

$('#startPhoto').onchange=()=>canStart();

$('#btnNotRun').onclick=()=>{
  if(!state.selectedZone){
    return alert('No se pudo identificar la zona del teléfono.');
  }
  if(!$('#startPhoto').files.length){
    return alert('Toma primero la selfie de inicio.');
  }
  openReason('notRun','home');
};

$('#btnInterruptRound').onclick=()=>{
  if(!state.round?.id){
    return alert('No hay una ronda activa para interrumpir.');
  }
  stopScanner();
  openReason('interrupt','scan');
};

$('#btnInterruptFromTransition').onclick=()=>{
  openReason('interrupt','transition');
};

$('#btnReasonBack').onclick=()=>{
  const target=state.reasonReturn || 'home';
  state.reasonMode=null;
  show(target);
};

$$('.reasonBtn').forEach(btn=>{
  btn.onclick=()=>{
    const reason=btn.dataset.reason;
    if(reason==='Otro'){
      $('#otherReasonBox').style.display='block';
      $('#otherReason').focus();
      return;
    }
    submitReason(reason);
  };
});

$('#btnConfirmOtherReason').onclick=()=>{
  submitReason($('#otherReason').value);
};

$('#btnStart').onclick=async()=>{
  if(!state.selectedZone) return alert('Selecciona Zona 1 o Zona 2.');

  state.gps=await getGps();
    let id='R-'+Date.now();
    state.round={
    id,
    user:state.user,
    zone:state.selectedZone,
    turno:state.user?.turnoHabitual||'',
    start:now(),
    gpsStart:state.gps,
    status:'En curso',
    visits:[],
    issues:0,
    startPhotoName:$('#startPhoto').files[0]?.name||''
  };
  const rs=await api('start',state.round);
  if(!rs?.ok){
    if(rs?.activeRound){
      state.round=rs.activeRound;
      persistActive();
      syncHomeForActive();
      return alert('Ya tienes una ronda en curso. Continúa la ronda existente.');
    }
    return alert(rs?.error || 'No fue posible iniciar la ronda.');
  }
  if(rs.id) state.round.id=rs.id;
  persistActive();
  show('scan');
  updateConnectivityUI();
};

function parseCode(raw){
  raw=(raw||'').trim();
  if(raw.startsWith('RV1:')) raw=raw.slice(4);
  return SITES.find(s=>s.code===raw);
}

function updateScanHeader(){
  let e=$('#scanZone');
  if(e) e.textContent=state.round ? state.round.zone : '';
  let f=$('#btnFinishEarly');
  if(f) f.style.display = state.round && state.round.visits.length ? 'block':'none';
}

function locationAlreadyVisited(code){
  return !!state.round?.visits?.some(v=>v.code===code);
}

function validateLocation(loc){
  if(!state.round) return 'No hay una ronda activa.';
  if(loc.zone!==state.round.zone)
    return `Este QR pertenece a ${loc.zone}. La ronda activa corresponde a ${state.round.zone}.`;
  if(locationAlreadyVisited(loc.code))
    return `${loc.building} - ${loc.floor} ya fue registrado en esta ronda.`;
  return '';
}

async function startScanner(){
  if(state.scanner) return;
  try{
    state.scanner=new Html5Qrcode('reader');
    await state.scanner.start(
      {facingMode:'environment'},
      {fps:10,qrbox:220},
      txt=>{
        let loc=parseCode(txt);
        if(!loc) return;
        const error=validateLocation(loc);
        if(error){
          stopScanner();
          alert(error);
          setTimeout(()=>show('scan'),150);
          return;
        }
        stopScanner();
        openLoc(loc);
      }
    );
  }catch(e){console.warn(e)}
}

async function stopScanner(){
  if(state.scanner){
    try{await state.scanner.stop()}catch(e){}
    try{state.scanner.clear()}catch(e){}
    state.scanner=null;
  }
}

$('#btnManual').onclick=()=>{
  let c=prompt('Código QR (ej: GG-P01)');
  let loc=parseCode(c);
  if(!loc) return alert('Código no reconocido');
  const error=validateLocation(loc);
  if(error) return alert(error);
  stopScanner();
  openLoc(loc);
};

function openLoc(loc){
  state.loc=JSON.parse(JSON.stringify(loc));
  state.loc.answers=loc.points.map(p=>({
    name:p.name,
    reviewed:false,
    issue:false,
    note:'',
    photo:''
  }));
  $('#locTitle').textContent=loc.building+' · '+loc.floor;
  $('#locSub').textContent=loc.zone+' · '+loc.code;
  renderPoints();
  show('checklist');
}

function renderPoints(){
  let box=$('#points');
  box.innerHTML='';
  state.loc.answers.forEach((a,i)=>{
    let d=document.createElement('div');
    d.className='point';
    d.innerHTML=`
      <div class="pointTop">
        <input type="checkbox" data-i="${i}" class="review">
        <div class="pointName">${a.name}</div>
        <label>
          <input type="checkbox" data-i="${i}" class="issue" style="width:20px"> Novedad
        </label>
      </div>
      <div class="novelty" id="nov${i}" style="display:none">
        <textarea placeholder="Observación"></textarea>
        <label class="photoBtn">📷 1 foto opcional
          <input type="file" accept="image/*" capture="environment" hidden>
        </label>
      </div>`;
    box.appendChild(d);
  });

  $$('.review').forEach(x=>x.onchange=e=>{
    state.loc.answers[e.target.dataset.i].reviewed=e.target.checked;
    updateProgress();
  });

  $$('.issue').forEach(x=>x.onchange=e=>{
    let i=e.target.dataset.i;
    state.loc.answers[i].issue=e.target.checked;
    $('#nov'+i).style.display=e.target.checked?'block':'none';
    updateProgress();
  });

  $$('.novelty textarea').forEach((x,i)=>
    x.oninput=e=>state.loc.answers[i].note=e.target.value
  );

  $$('.novelty input[type=file]').forEach((x,i)=>
    x.onchange=e=>state.loc.answers[i].photo=e.target.files[0]?.name||''
  );

  updateProgress();
}

function updateProgress(){
  let n=state.loc.answers.filter(x=>x.reviewed).length;
  let t=state.loc.answers.length;
  $('#progress').innerHTML=`<span style="width:${t?100*n/t:0}%"></span>`;
}

function zoneSites(){
  return SITES.filter(s=>s.zone===state.round.zone);
}

function remainingZoneSites(){
  const done=new Set(state.round.visits.map(v=>v.code));
  return zoneSites().filter(s=>!done.has(s.code));
}

function suggestNextInZone(){
  return remainingZoneSites()[0] || null;
}

$('#btnCompleteFloor').onclick=async()=>{
  let missing=state.loc.answers.filter(x=>!x.reviewed).length;
  if(missing && !confirm(`Quedan ${missing} puntos sin marcar. ¿Completar piso igualmente?`)) return;

  let issues=state.loc.answers.filter(x=>x.issue).length;
  state.round.issues+=issues;
  state.round.visits.push({
    code:state.loc.code,
    zone:state.loc.zone,
    building:state.loc.building,
    floor:state.loc.floor,
    at:now(),
    gps:await getGps(),
    answers:state.loc.answers
  });

  const lastVisit=state.round.visits[state.round.visits.length-1];
  const saveResult=await api('saveFloor',{
    round:state.round,
    loc:state.loc,
    gps:lastVisit?.gps||null
  });

  if(!saveResult?.ok){
    return alert(saveResult?.error || 'No fue posible guardar el piso.');
  }

  persistActive();
  showTransition();
  updateConnectivityUI();
};

$('#btnFinishEarly').onclick=()=>{
  stopScanner();
  requestFinish();
};


function showTransition(){
  const remaining=remainingZoneSites();
  const last=state.round.visits[state.round.visits.length-1];

  if(remaining.length===0){
    $('#transitionTitle').textContent=(state.round.zone||'ZONA').toUpperCase()+' COMPLETADA';
    $('#transitionPlace').textContent='Todos los pisos revisados';
    $('#transitionPending').textContent='';
    $('#btnContinueRound').style.display='none';
    $('#btnEndRoundFromTransition').textContent='FINALIZAR RONDA';
  }else{
    const next=remaining[0];
    $('#transitionTitle').textContent='PISO COMPLETADO';
    $('#transitionPlace').textContent=`${last.building} · ${last.floor}`;
    const registrados=state.round.visits.length;
    $('#transitionPending').textContent=`${registrados} ${registrados===1?'sector/piso registrado':'sectores/pisos registrados'} en esta ronda`;
    $('#btnContinueRound').style.display='block';
    $('#btnContinueRound').textContent='CONTINUAR RONDA';
    $('#btnEndRoundFromTransition').textContent='FINALIZAR RONDA';
  }
  show('transition');
}

function requestFinish(){
  prepareFinish();
}

$('#btnContinueRound').onclick=()=>show('scan');
$('#btnEndRoundFromTransition').onclick=()=>requestFinish();
$('#btnKeepGoing').onclick=()=>show('scan');
$('#btnFinishAnyway').onclick=()=>prepareFinish();

$('#btnResume').onclick=()=>{
  const active=getActive();
  if(!active) return syncHomeForActive();
  state.round=active;
  state.selectedZone=active.zone;
  show('scan');
};

function prepareFinish(){
  stopScanner();
  let reviewed=state.round.visits.reduce(
    (a,v)=>a+v.answers.filter(x=>x.reviewed).length,0
  );
  let total=state.round.visits.reduce(
    (a,v)=>a+v.answers.length,0
  );
  let visitedSites=state.round.visits.length;

  $('#finishSummary').innerHTML=`
    <h2>Resumen</h2>
    <p><b>${state.round.zone}</b></p>
    <p><b>${visitedSites}</b> ${visitedSites===1?'sector/piso registrado':'sectores/pisos registrados'}</p>
    <p><b>${reviewed}/${total}</b> puntos revisados</p>
    <p><b>${state.round.issues}</b> novedades</p>`;

  show('finish');
}

$('#endPhoto').onchange=e=>
  $('#btnFinish').disabled=!e.target.files.length;

$('#btnFinish').onclick=async()=>{
  const patch={
    end:now(),
    gpsEnd:await getGps(),
    status:'Finalizada',
    endPhotoName:$('#endPhoto').files[0]?.name||''
  };

  Object.assign(state.round,patch);

  const localDuration=fmtDuration(state.round.start,patch.end);

  const rf=await api('finish',{
    id:state.round.id,
    end:patch.end,
    gpsEnd:patch.gpsEnd,
    endPhotoName:patch.endPhotoName
  });

  if(!rf?.ok) return alert(rf?.error || 'No fue posible finalizar la ronda.');

  clearActive();

  logoutToLogin(
    rf?.queued
      ? `Ronda finalizada. Duración: ${localDuration}\nRegistro guardado en el teléfono y pendiente de sincronización.`
      : `Ronda finalizada correctamente.\nDuración: ${rf?.duration||localDuration}`
  );

  updateConnectivityUI();
};

// Acceso exclusivo al panel administrativo
$('#btnDashboard').onclick=()=>{

  if(!isAdmin()){
    alert('No tienes permisos para acceder al panel de administración.');
    return;
  }

  show('dashboard');

};


function fmtDuration(start,end){
  if(!start) return '--:--:--';
  const a=new Date(start).getTime();
  const b=end?new Date(end).getTime():Date.now();
  let sec=Math.max(0,Math.floor((b-a)/1000));
  const h=Math.floor(sec/3600);
  sec%=3600;
  const m=Math.floor(sec/60);
  const s=sec%60;
  return [h,m,s].map(x=>String(x).padStart(2,'0')).join(':');
}
function fmtTime(v){
  if(!v) return '—';
  return new Date(v).toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'});
}


let dashboardCache={rounds:[],novedades:[]};

function normalizeBackendRound(x){
  return {
    id:x.IDRonda ?? x.id ?? '',
    name:x.Nombre ?? x.user?.name ?? '',
    rut:x.RUT ?? x.user?.rut ?? '',
    zone:x.Zona ?? x.zone ?? '',
    turno:x.Turno ?? '',
    status:x.Estado ?? x.status ?? '',
    motivo:x.MotivoCierre ?? '',
    start:x.FechaInicio ?? x.start ?? '',
    end:x.FechaFin ?? x.end ?? '',
    duration:x.Duracion ?? '',
    durationSeconds:Number(x.DuracionSegundos ?? 0),
    floors:Number(x.CantidadPisos ?? (x.visits||[]).length ?? 0),
    points:Number(x.CantidadPuntos ?? 0),
    issues:Number(x.CantidadNovedades ?? x.issues ?? 0)
  };
}

function localDateKey(v){
  if(!v) return '';
  const d=new Date(v);
  if(isNaN(d)) return '';
  return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');
}

function secondsToHM(sec){
  sec=Math.max(0,Number(sec)||0);
  const h=Math.floor(sec/3600);
  const m=Math.floor((sec%3600)/60);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function populateVigilanteFilter(rounds){
  const sel=$('#fVigilante');
  if(!sel) return;
  const current=sel.value;
  const names=[...new Set(rounds.map(x=>x.name).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  sel.innerHTML='<option value="">Todos</option>'+names.map(n=>`<option>${n}</option>`).join('');
  if(names.includes(current)) sel.value=current;
}

function getFilteredRounds(){
  let rs=dashboardCache.rounds.map(normalizeBackendRound);
  const desde=$('#fDesde')?.value||'';
  const hasta=$('#fHasta')?.value||'';
  const zona=$('#fZona')?.value||'';
  const turno=$('#fTurno')?.value||'';
  const estado=$('#fEstado')?.value||'';
  const vigilante=$('#fVigilante')?.value||'';

  return rs.filter(x=>{
    const d=localDateKey(x.start);
    if(desde && d<desde) return false;
    if(hasta && d>hasta) return false;
    if(zona && x.zone!==zona) return false;
    if(turno && x.turno!==turno) return false;
    if(estado && x.status!==estado) return false;
    if(vigilante && x.name!==vigilante) return false;
    return true;
  });
}

function renderSupervisorDashboard(){
  const rs=getFilteredRounds();

  $('#kToday').textContent=rs.length;
  $('#kDone').textContent=rs.filter(x=>x.status==='Finalizada').length;
  $('#kOpen').textContent=rs.filter(x=>x.status==='En curso').length;
  $('#kInterrupted').textContent=rs.filter(x=>x.status==='Interrumpida').length;
  $('#kNotRun').textContent=rs.filter(x=>x.status==='No realizada').length;
  $('#kIssues').textContent=rs.reduce((a,x)=>a+x.issues,0);

  const completed=rs.filter(x=>x.status==='Finalizada' && x.durationSeconds>0);
  const avg=completed.length ? completed.reduce((a,x)=>a+x.durationSeconds,0)/completed.length : 0;
  $('#kAvg').textContent=secondsToHM(avg);

  $('#dashRows').innerHTML=rs.slice().reverse().map(x=>{
    const duration=x.duration || (x.start ? fmtDuration(x.start,x.end) : '—');
    const motive=x.motivo ? `<br><small>Motivo: ${x.motivo}</small>` : '';
    return `<div class="dashrow">
      <b>${x.name||'Sin nombre'}</b> · ${x.zone||'Sin zona'} · <strong>${x.status||''}</strong><br>
      <small>${localDateKey(x.start)} · ${fmtTime(x.start)} → ${x.end?fmtTime(x.end):'En curso'} · ${duration}</small><br>
      <small>${x.floors} pisos · ${x.points} puntos · ${x.issues} novedades${x.turno?' · '+x.turno:''}</small>
      ${motive}
    </div>`;
  }).join('')||'<p>Sin registros para los filtros seleccionados.</p>';

  const by={};
  rs.forEach(x=>{
    if(!x.name) return;
    if(!by[x.name]) by[x.name]={name:x.name,total:0,done:0,secs:0,doneWithDuration:0,issues:0};
    const v=by[x.name];
    v.total++;
    v.issues+=x.issues;
    if(x.status==='Finalizada'){
      v.done++;
      if(x.durationSeconds>0){
        v.secs+=x.durationSeconds;
        v.doneWithDuration++;
      }
    }
  });

  const ranking=Object.values(by).sort((a,b)=>b.done-a.done || b.total-a.total || a.name.localeCompare(b.name,'es'));

  $('#rankingRows').innerHTML=ranking.map((x,i)=>{
    const avg=x.doneWithDuration?secondsToHM(x.secs/x.doneWithDuration):'—';
    return `<div class="rankrow">
      <div class="rankpos">${i+1}</div>
      <div class="rankbody">
        <b>${x.name}</b>
        <small>${x.total} rondas · ${x.done} finalizadas · Prom. ${avg} · ${x.issues} novedades</small>
      </div>
    </div>`;
  }).join('')||'<p>Sin datos.</p>';
}
async function renderDashboard(){
  setLoading(true,'Cargando dashboard...');
  try{
    const r=await api('dashboard');
    if(!r?.ok) return alert(r?.error || 'No fue posible cargar el dashboard.');

    dashboardCache={rounds:r.rounds||[],novedades:r.novedades||[]};
    if($('#dashUser') && r.offline){
      $('#dashUser').textContent=(state.user?.name||'Supervisor')+' · Datos guardados sin conexión';
    }
    const normalized=dashboardCache.rounds.map(normalizeBackendRound);
    populateVigilanteFilter(normalized);

    if(!$('#fDesde').value && !$('#fHasta').value){
      const today=localDateKey(new Date());
      $('#fDesde').value=today;
      $('#fHasta').value=today;
    }

    renderSupervisorDashboard();
  }finally{
    setLoading(false);
  }
}

$$('[data-go]').forEach(b=>b.onclick=()=>{
  if(b.dataset.go==='home' && state.round){
    persistActive();
    syncHomeForActive();
  }
  if(b.dataset.go!=='scan') stopScanner();
  show(b.dataset.go);
});

window.addEventListener('load',()=>show('login'));

document.addEventListener('click',e=>{
  if(e.target?.id==='btnApplyFilters') renderSupervisorDashboard();

  if(e.target?.id==='btnClearFilters'){
    $('#fZona').value='';
    $('#fTurno').value='';
    $('#fEstado').value='';
    $('#fVigilante').value='';
    const today=localDateKey(new Date());
    $('#fDesde').value=today;
    $('#fHasta').value=today;
    renderSupervisorDashboard();
  }

  if(e.target?.id==='btnDashBack'){

  if(isAdmin()){
    logoutToLogin();
  }else{
    show('home');
  }

}
});


/* =====================================================
   PWA / OFFLINE
===================================================== */
if('serviceWorker' in navigator){
  window.addEventListener('load',async()=>{
    try{
      const reg=await navigator.serviceWorker.register('./sw.js?v=9.0');
      reg.update().catch(()=>{});
    }catch(e){
      console.warn('Service Worker no disponible',e);
    }
  });
}

window.addEventListener('load',()=>{
  updateConnectivityUI();
  if(navigator.onLine) setTimeout(()=>processQueue(),600);
});


// Reintento de seguridad cada minuto mientras la aplicación esté abierta.
setInterval(()=>{
  if(navigator.onLine && getQueue().length && !syncInProgress){
    processQueue();
  }
},60000);
