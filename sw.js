const CACHE='rv-v10-0-integridad';

const APP_SHELL=[
  './',
  './index.html',
  './styles.css?v=10.0',
  './config.js?v=10.0',
  './sites.js?v=10.0',
  './app.js?v=10.0',
  './manifest.json',
  './assets/metro-logo.png',
  './assets/building.jpg'
];

const QR_LIB=
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';

self.addEventListener('install',event=>{
  event.waitUntil((async()=>{

    const cache=await caches.open(CACHE);

    await cache.addAll(
      APP_SHELL.map(url=>
        new Request(url,{cache:'reload'})
      )
    );

    // Mantener disponible el lector QR sin conexión.
    try{
      const req=new Request(QR_LIB,{
        mode:'no-cors',
        cache:'reload'
      });

      const res=await fetch(req);

      if(res.ok || res.type==='opaque'){
        await cache.put(req,res);
      }

    }catch(e){
      console.warn('Lector QR no disponible en caché',e);
    }

    await self.skipWaiting();

  })());
});

self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{

    const keys=await caches.keys();

    await Promise.all(
      keys
        .filter(k=>k.startsWith('rv-') && k!==CACHE)
        .map(k=>caches.delete(k))
    );

    await self.clients.claim();

  })());
});

self.addEventListener('fetch',event=>{

  const req=event.request;

  if(req.method!=='GET') return;

  const url=new URL(req.url);

  const sameOrigin=url.origin===self.location.origin;

  const inScope=req.url.startsWith(
    self.registration.scope
  );

  // No interceptar recursos ajenos a la aplicación.
  if(!(sameOrigin && inScope) && req.url!==QR_LIB){
    return;
  }

  // Navegación: cargar la versión instalada rápidamente.
  if(req.mode==='navigate'){

    event.respondWith((async()=>{

      const cache=await caches.open(CACHE);

      const cached=await cache.match('./index.html');

      if(cached) return cached;

      try{

        const fresh=await fetch(req);

        if(fresh.ok){
          await cache.put('./index.html',fresh.clone());
        }

        return fresh;

      }catch(e){

        return new Response(
          'Aplicación no disponible sin conexión',
          {
            status:503,
            headers:{
              'Content-Type':'text/plain;charset=utf-8'
            }
          }
        );

      }

    })());

    return;

  }

  // Recursos estáticos: utilizar primero la caché.
  event.respondWith((async()=>{

    const cache=await caches.open(CACHE);

    const cached=await cache.match(req);

    if(cached) return cached;

    try{

      const res=await fetch(req);

      if(res.ok || res.type==='opaque'){
        await cache.put(req,res.clone());
      }

      return res;

    }catch(e){

      return new Response('',{
        status:504,
        statusText:'Offline'
      });

    }

  })());

});
