const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

const params=new URLSearchParams(window.location.search);
const DEVICE_ZONE=params.get('zona')==='1'?'Zona 1':params.get('zona')==='2'?'Zona 2':null;

let state={
  user:null,
  round:null,
  loc:null,
  scanner:null,
  gps:null,
  selectedZone:DEVICE_ZONE
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

async function api(action,payload={}){
  if(CONFIG.DEMO_MODE) return demoApi(action,payload);
  const r=await fetch(CONFIG.API_URL,{
    method:'POST',
    headers:{'Content-Type':'text/plain;charset=utf-8'},
    body:JSON.stringify({action,payload})
  });
  return await r.json();
}

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
    const expected=SITES.filter(s=>s.zone===active.zone).length;
    $('#resumeInfo').textContent=`${active.zone} · ${(active.visits||[]).length}/${expected} pisos registrados`;
  }else{
    resume.style.display='none';
    fresh.style.display='block';
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
  $('#btnStart').disabled = !(
    state.selectedZone &&
    $('#startPhoto').files.length
  );
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

$('#btnLogin').onclick=async()=>{
  $('#rut').value=formatRut($('#rut').value);

  if(!rutIsStructurallyValid($('#rut').value))
    return alert('Ingresa un RUT válido.');

  if(!/^\d{4}$/.test($('#pin').value))
    return alert('El PIN debe tener 4 dígitos.');

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
  syncHomeForActive();
  show('home');
};

setInterval(()=>{
  let e=$('#clock');
  if(e) e.textContent=new Date().toLocaleString('es-CL');
},1000);

$('#startPhoto').onchange=()=>canStart();

$('#btnStart').onclick=async()=>{
  if(!state.selectedZone) return alert('Selecciona Zona 1 o Zona 2.');
  state.gps=await getGps();
  let id='R-'+Date.now();
  state.round={
    id,
    user:state.user,
    zone:state.selectedZone,
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

  const saveResult=await api('saveFloor',{
    round:state.round,
    loc:state.loc,
    gps:await getGps()
  });
  if(!saveResult?.ok){
    return alert(saveResult?.error || 'No fue posible guardar el piso.');
  }
  persistActive();
  showTransition();
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
    $('#transitionPending').textContent=`${remaining.length} pisos pendientes`;
    $('#btnContinueRound').style.display='block';
    $('#btnContinueRound').textContent='CONTINUAR RONDA';
    $('#btnEndRoundFromTransition').textContent='FINALIZAR RONDA';
  }
  show('transition');
}

function requestFinish(){
  const remaining=remainingZoneSites().length;
  if(remaining>0){
    $('#pendingTitle').textContent=`QUEDAN ${remaining} ${remaining===1?'PISO':'PISOS'}`;
    show('pendingFinish');
  }else{
    prepareFinish();
  }
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
  let expectedSites=zoneSites().length;
  let visitedSites=state.round.visits.length;

  $('#finishSummary').innerHTML=`
    <h2>Resumen</h2>
    <p><b>${state.round.zone}</b></p>
    <p><b>${visitedSites}/${expectedSites}</b> pisos/QR registrados</p>
    <p><b>${reviewed}/${total}</b> puntos revisados</p>
    <p><b>${state.round.issues}</b> novedades</p>`;

  show('finish');
}

$('#endPhoto').onchange=e=>
  $('#btnFinish').disabled=!e.target.files.length;

$('#btnFinish').onclick=async()=>{
  let patch={
    end:now(),
    gpsEnd:await getGps(),
    status:'Finalizada',
    endPhotoName:$('#endPhoto').files[0]?.name||''
  };
  Object.assign(state.round,patch);
  const rf=await api('finish',{
    id:state.round.id,
    end:patch.end,
    gpsEnd:patch.gpsEnd,
    endPhotoName:patch.endPhotoName
  });
  if(!rf?.ok) return alert(rf?.error || 'No fue posible finalizar la ronda.');
  clearActive();
  alert('Ronda finalizada correctamente');

  state.round=null;
  state.loc=null;
  state.selectedZone=DEVICE_ZONE;
  $$('.zoneBtn').forEach(x=>x.classList.toggle('selected',x.dataset.zone===DEVICE_ZONE));
  $('#zoneSelected').textContent=DEVICE_ZONE?'Teléfono configurado: '+DEVICE_ZONE:'Selecciona una zona';
  $('#startPhoto').value='';
  $('#endPhoto').value='';
  $('#btnStart').disabled=true;
  syncHomeForActive();
  show('home');
};

$('#btnDashboard').onclick=()=>show('dashboard');


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

async function renderDashboard(){
  let r=await api('dashboard');
  let rs=r.rounds||[];
  let today=new Date().toISOString().slice(0,10);
  let todays=rs.filter(x=>(x.start||'').slice(0,10)===today);

  $('#kToday').textContent=todays.length;
  $('#kDone').textContent=todays.filter(x=>x.status==='Finalizada').length;
  $('#kOpen').textContent=todays.filter(x=>x.status!=='Finalizada').length;
  $('#kIssues').textContent=todays.reduce((a,x)=>a+(x.issues||0),0);

  $('#dashRows').innerHTML=rs.slice().reverse().map(x=>
    `<div class="dashrow">
      <b>${x.user?.name||''}</b> · ${x.zone||'Sin zona'} · ${x.status}<br>
      <small>Inicio ${fmtTime(x.start)} · Fin ${x.end?fmtTime(x.end):'En curso'} · Duración ${fmtDuration(x.start,x.end)}</small><br>
      <small>${(x.visits||[]).length} pisos · ${x.issues||0} novedades</small>
    </div>`
  ).join('')||'<p>Sin datos</p>';
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
