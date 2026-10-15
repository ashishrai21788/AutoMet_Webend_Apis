/**
 * The public ride-tracking web page (a small PWA): opened from a shared link, it shows the driver, the vehicle, the
 * route and the live position, refreshing every few seconds. No sign-in, no account data.
 *
 * Served from /t/:token, with /t/manifest.webmanifest and /t/sw.js. Everything the page shows comes from
 * GET /api/v1/public/track/:token and is written with textContent, never as HTML.
 */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#15803D">
<meta name="robots" content="noindex, nofollow">
<link rel="manifest" href="/t/manifest.webmanifest">
<link rel="apple-touch-icon" href="/t/icon.svg">
<title>Track ride</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
:root{--g:#15803D;--g2:#16A34A;--ink:#0F172A;--mut:#64748B;--line:#E5E7EB;--bg:#fff;--soft:#F4F6F8;--tint:#F0FAF3}
@media (prefers-color-scheme: dark){:root{--ink:#F1F5F9;--mut:#94A3B8;--line:#273244;--bg:#0F172A;--soft:#1E293B;--tint:#12301F}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg);overflow:hidden}
#map{position:absolute;inset:0 0 0 0;height:56%}
.top{position:absolute;z-index:500;left:12px;right:12px;top:calc(env(safe-area-inset-top) + 10px);display:flex;align-items:center;gap:8px}
.brand{background:#fff;color:#0F172A;border-radius:22px;padding:8px 14px;font-weight:600;font-size:14px;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.pill{margin-left:auto;background:#fff;color:#15803D;border-radius:22px;padding:8px 12px;font-weight:600;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.18);display:flex;align-items:center;gap:6px}
.pill[hidden]{display:none}
.dot{width:8px;height:8px;border-radius:50%;background:var(--g2);animation:p 1.6s infinite}
@keyframes p{50%{opacity:.3}}
.sheet{position:absolute;left:0;right:0;bottom:0;height:52%;background:var(--bg);border-radius:20px 20px 0 0;box-shadow:0 -4px 20px rgba(0,0,0,.15);overflow:auto;padding:14px 14px calc(env(safe-area-inset-bottom) + 16px)}
.grab{width:40px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 10px}
h1{font-size:19px;margin:0 0 2px}
.sub{color:var(--mut);font-size:13px;margin:0 0 12px}.sub b{color:var(--g)}
.card{border:1px solid var(--line);border-radius:14px;padding:10px 12px;margin-bottom:10px;display:flex;gap:12px;align-items:center}
.ph{width:52px;height:52px;border-radius:50%;background:var(--g);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;overflow:hidden;flex:none}
.ph img{width:100%;height:100%;object-fit:cover}
.n{font-weight:600;font-size:16px}.m{color:var(--mut);font-size:12.5px;margin-top:2px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.chip{background:var(--soft);border-radius:9px;padding:3px 8px;font-size:11.5px}
.route{display:block}
.stop{display:flex;gap:10px;align-items:flex-start;font-size:14px}
.stop+.stop{margin-top:10px}
.sd{width:10px;height:10px;border-radius:50%;background:var(--g2);margin-top:5px;flex:none}
.sp{width:10px;height:10px;border-radius:2px;background:#DC2626;margin-top:5px;flex:none}
.safe{background:var(--tint);border-radius:14px;padding:10px 12px;font-size:13px;color:var(--g);font-weight:600}
.safe span{display:block;color:var(--mut);font-weight:400;font-size:12px;margin-top:2px}
.end{padding:36px 20px;text-align:center}
.end h1{font-size:20px}
.err{text-align:center;color:var(--mut);padding:30px 16px}
.veh{width:30px;height:30px}
</style>
</head>
<body>
<div id="map"></div>
<div class="top"><div class="brand" id="brand">Ride</div><div class="pill" id="live" hidden><span class="dot"></span>Live tracking</div></div>
<div class="sheet" id="sheet"><div class="grab"></div><div class="err" id="msg">Loading ride…</div></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
  var token = location.pathname.split('/').filter(Boolean).pop();
  var map = L.map('map',{zoomControl:false,attributionControl:true}).setView([20.59,78.96],5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
  var carIcon = L.divIcon({className:'',html:'<div style="width:34px;height:34px;border-radius:50%;background:#16A34A;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px">&#9650;</div>',iconSize:[34,34],iconAnchor:[17,17]});
  var dotIcon = function(c){return L.divIcon({className:'',html:'<div style="width:16px;height:16px;border-radius:50%;background:'+c+';border:3px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4)"></div>',iconSize:[16,16],iconAnchor:[8,8]});};
  var mCar=null,mPick=null,mDrop=null,line=null,fitted=false,timer=null;
  var sheet=document.getElementById('sheet'), msg=document.getElementById('msg');
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function short(a){return a?String(a).split(',').slice(0,2).join(',').trim():'';}
  function render(d){
    document.getElementById('brand').textContent = d.brand || 'Ride';
    document.title = (d.title||'Track ride') + (d.brand?' · '+d.brand:'');
    document.getElementById('live').hidden = !d.live;
    sheet.textContent=''; sheet.appendChild(el('div','grab'));
    if(!d.live){
      var end=el('div','end'); end.appendChild(el('h1',null,d.title)); end.appendChild(el('p','sub',d.step==='COMPLETED'?'The ride reached its destination.':'This ride is no longer in progress.'));
      sheet.appendChild(end);
    } else {
      sheet.appendChild(el('h1',null,d.title));
      var sub=el('p','sub');
      if(d.step==='ARRIVED') sub.textContent='The driver is at the pickup point.';
      else if(d.eta && d.eta.minutes){
        sub.appendChild(document.createTextNode((d.eta.to==='DROP'?'Arriving at the destination in ':'Arriving in ')));
        var b=el('b',null,d.eta.minutes+' min'); sub.appendChild(b);
        sub.appendChild(document.createTextNode(' ('+d.eta.km+' km away)'));
      } else sub.textContent='Waiting for the driver\\u2019s location…';
      sheet.appendChild(sub);
    }
    var dr=d.driver;
    if(dr){
      var c=el('div','card'), ph=el('div','ph');
      if(dr.photo){var im=document.createElement('img');im.alt='';im.src=dr.photo;im.onerror=function(){im.remove();ph.textContent=(dr.firstName||'D')[0].toUpperCase();};ph.appendChild(im);} else ph.textContent=(dr.firstName||'D')[0].toUpperCase();
      c.appendChild(ph);
      var t=el('div'); t.appendChild(el('div','n',dr.firstName));
      var meta=[]; if(dr.rating) meta.push('\\u2605 '+dr.rating.toFixed(1)); if(dr.trips) meta.push(dr.trips+' trips');
      if(meta.length) t.appendChild(el('div','m',meta.join(' \\u00b7 ')));
      c.appendChild(t); sheet.appendChild(c);
      var v=el('div','card'), vt=el('div');
      vt.appendChild(el('div','n',[dr.vehicleModel,dr.vehicleType].filter(Boolean)[0]||'Vehicle'));
      if(dr.vehicleNumber) vt.appendChild(el('div','m',dr.vehicleNumber));
      var ch=el('div','chips'); if(dr.vehicleColor) ch.appendChild(el('span','chip',dr.vehicleColor)); if(dr.vehicleType&&dr.vehicleModel) ch.appendChild(el('span','chip',dr.vehicleType));
      if(ch.childNodes.length) vt.appendChild(ch); v.appendChild(vt); sheet.appendChild(v);
    }
    if(d.pickup&&d.drop){
      var r=el('div','card route'), s1=el('div','stop'), s2=el('div','stop');
      s1.appendChild(el('span','sd')); s1.appendChild(el('span',null,short(d.pickup.address)));
      s2.appendChild(el('span','sp')); s2.appendChild(el('span',null,short(d.drop.address)));
      r.appendChild(s1); r.appendChild(s2);
      var info=[]; if(d.distanceKm) info.push(d.distanceKm+' km'); if(d.durationMin) info.push(d.durationMin+' min');
      if(info.length) r.appendChild(el('div','m',info.join(' \\u00b7 ')));
      sheet.appendChild(r);
    }
    var sf=el('div','safe','Safe rides, always'); sf.appendChild(el('span',null,'Verified drivers \\u00b7 Live ride tracking')); sheet.appendChild(sf);
    // map
    var pts=[];
    if(d.pickup){ if(!mPick) mPick=L.marker([d.pickup.lat,d.pickup.lng],{icon:dotIcon('#16A34A')}).addTo(map); pts.push([d.pickup.lat,d.pickup.lng]); }
    if(d.drop){ if(!mDrop) mDrop=L.marker([d.drop.lat,d.drop.lng],{icon:dotIcon('#DC2626')}).addTo(map); pts.push([d.drop.lat,d.drop.lng]); }
    if(d.location){
      var ll=[d.location.lat,d.location.lng];
      if(!mCar) mCar=L.marker(ll,{icon:carIcon,zIndexOffset:1000}).addTo(map); else mCar.setLatLng(ll);
      pts.push(ll);
    }
    if(pts.length && !fitted){
      fitted=true;
      // the map box is laid out after the first paint: measure it again, then frame the ride
      var framing=L.latLngBounds(pts).pad(0.25);
      var frame=function(){ map.invalidateSize(); map.fitBounds(framing,{maxZoom:16,animate:false}); };
      setTimeout(frame,250); setTimeout(frame,1500);
    }
  }
  function load(){
    fetch('/api/v1/public/track/'+encodeURIComponent(token),{cache:'no-store'})
      .then(function(r){return r.json().then(function(j){return {s:r.status,j:j};});})
      .then(function(x){
        if(x.s===200&&x.j&&x.j.success){ render(x.j.data); if(!x.j.data.live) clearInterval(timer); }
        else { clearInterval(timer); sheet.textContent=''; sheet.appendChild(el('div','grab')); var e=el('div','err',(x.j&&x.j.message)||'This link is not valid'); sheet.appendChild(e); document.getElementById('live').hidden=true; }
      })
      .catch(function(){ if(!sheet.querySelector('.card')) msg.textContent='Could not load the ride. Retrying…'; });
  }
  window.addEventListener('resize',function(){ map.invalidateSize(); });
  load(); timer=setInterval(load,5000);
  if('serviceWorker' in navigator) navigator.serviceWorker.register('/t/sw.js').catch(function(){});
})();
</script>
</body>
</html>`;

const MANIFEST = JSON.stringify({
  name: 'Track ride',
  short_name: 'Track ride',
  start_url: '/',
  scope: '/t/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#15803D',
  icons: [{ src: '/t/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }]
});

// network first; the shell is only kept so the page can open once with a weak connection
const SW = `self.addEventListener('install',function(){self.skipWaiting();});
self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.pathname.indexOf('/api/')===0) return;
  e.respondWith(fetch(e.request).then(function(r){var c=r.clone();caches.open('track-v1').then(function(k){k.put(e.request,c);});return r;}).catch(function(){return caches.match(e.request);}));
});`;

const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#15803D"/><path d="M48 18l22 52-22-12-22 12z" fill="#fff"/></svg>`;

module.exports = { PAGE, MANIFEST, SW, ICON };
