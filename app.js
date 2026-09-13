const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];

let state={
  user:null,
  round:null,
  loc:null,
  scanner:null,
  gps:null,
  selectedZone:null
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

async function demoApi(action,p={}){
  let db=demoDb();
  if(action==='login'){
    if(normalizeRut(p.rut)===normalizeRut(CONFIG.DEMO_RUT) && p.pin===CONFIG.DEMO_PIN)
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

$('#btnLogin').onclick=async()=>{
  let r=await api('login',{rut:$('#rut').value,pin:$('#pin').value});
  if(!r.ok) return alert(r.error);
  state.user=r.user;
  $('#userName').textContent=r.user.name;
  state.gps=await getGps();
  $('#gpsStatus').textContent=state.gps?'Ubicación disponible':'Ubicación no disponible';
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
  await api('start',state.round);
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

  await api('update',{
    id:state.round.id,
    patch:{
      visits:state.round.visits,
      issues:state.round.issues
    }
  });

  const remaining=remainingZoneSites();

  if(remaining.length===0){
    alert(`${state.round.zone} completada. Se registraron todos los QR configurados para esta zona.`);
    prepareFinish();
    return;
  }

  const next=remaining[0];
  const goNext=confirm(
    `Piso registrado correctamente.\n\n`+
    `Pendientes en ${state.round.zone}: ${remaining.length}\n`+
    `Siguiente sugerido: ${next.building} - ${next.floor}\n\n`+
    `Aceptar para escanear el siguiente QR.\n`+
    `Cancelar para finalizar la ronda ahora.`
  );

  if(goNext) show('scan');
  else prepareFinish();
};

$('#btnFinishEarly').onclick=()=>{
  const remaining=remainingZoneSites().length;
  if(remaining>0){
    if(!confirm(
      `Aún quedan ${remaining} QR/pisos pendientes en ${state.round.zone}.\n\n`+
      `¿Deseas finalizar la ronda igualmente?`
    )) return;
  }
  stopScanner();
  prepareFinish();
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
  await api('update',{id:state.round.id,patch});
  alert('Ronda finalizada correctamente');

  state.round=null;
  state.loc=null;
  state.selectedZone=null;
  $$('.zoneBtn').forEach(x=>x.classList.remove('selected'));
  $('#zoneSelected').textContent='Selecciona una zona';
  $('#startPhoto').value='';
  $('#endPhoto').value='';
  $('#btnStart').disabled=true;
  show('home');
};

$('#btnDashboard').onclick=()=>show('dashboard');

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
      <small>${new Date(x.start).toLocaleString('es-CL')} · ${(x.visits||[]).length} pisos · ${x.issues||0} novedades</small>
    </div>`
  ).join('')||'<p>Sin datos</p>';
}

$$('[data-go]').forEach(b=>b.onclick=()=>{
  if(b.dataset.go==='home' && state.round){
    if(!confirm('Hay una ronda en curso. Volver no la finaliza. ¿Continuar?')) return;
  }
  if(b.dataset.go!=='scan') stopScanner();
  show(b.dataset.go);
});

window.addEventListener('load',()=>show('login'));
