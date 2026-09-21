const CACHE='rv-v9-1';
const APP_SHELL=[
  './',
  './index.html',
  './styles.css?v=9.1',
  './config.js?v=9.1',
  './sites.js?v=9.1',
  './app.js?v=9.1',
  './manifest.json',
  './assets/metro-logo.png',
  './assets/building.jpg'
];

const QR_LIB='https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await cache.addAll(APP_SHELL);

    // Intentamos dejar disponible el lector QR para uso sin cobertura.
    try{
      const req=new Request(QR_LIB,{mode:'no-cors'});
      const res=await fetch(req);
      await cache.put(req,res);
    }catch(e){}

    await self.skipWaiting();
  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const keys=await caches.keys();
    await Promise.all(
      keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch',event=>{
  const req=event.request;

  if(req.method!=='GET') return;

  const url=new URL(req.url);

  // Navegación: app shell primero cuando no hay red.
  if(req.mode==='navigate'){
    event.respondWith((async()=>{
      try{
        const fresh=await fetch(req);
        const cache=await caches.open(CACHE);
        cache.put('./index.html',fresh.clone()).catch(()=>{});
        return fresh;
      }catch(e){
        return (
          await caches.match('./index.html') ||
          await caches.match('./')
        );
      }
    })());
    return;
  }

  // Recursos estáticos: cache first + actualización en segundo plano.
  event.respondWith((async()=>{
    const cached=await caches.match(req);

    const networkPromise=fetch(req).then(async res=>{
      if(res && (res.ok || res.type==='opaque')){
        const cache=await caches.open(CACHE);
        cache.put(req,res.clone()).catch(()=>{});
      }
      return res;
    }).catch(()=>null);

    if(cached){
      networkPromise.catch(()=>{});
      return cached;
    }

    const network=await networkPromise;
    if(network) return network;

    return new Response('',{status:504,statusText:'Offline'});
  })());
});