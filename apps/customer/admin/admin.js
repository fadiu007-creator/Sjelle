const API = "https://saavqlbwffrwxingbnri.supabase.co/functions/v1/sjelle-api/api/v1";
const ADMIN_LOGIN_HREF = "../?account=login&return_to=admin";
const ADMIN_ROLE_SETUP_HREF = "https://github.com/fadiu007-creator/Sjelle/blob/main/supabase/operations/first-admin.sql";
const $=s=>document.querySelector(s);
$("#year").textContent=String(new Date().getFullYear());
let cities=[];let currentCity=null;let adminBootToken="";let adminBooting=false;let refreshPromise=null;
function alertMsg(t,k=""){const e=$("#admin-alert");e.textContent=t;if(k)e.dataset.kind=k;else delete e.dataset.kind;}
function savedSession(){try{return JSON.parse(sessionStorage.getItem("sjelle.session")||"null");}catch{return null;}}
function token(){return savedSession()?.access_token||"";}
function showLoginRequired(){const e=$("#admin-alert");e.replaceChildren(document.createTextNode("Kyçu me llogarinë e administratorit për të parë aplikimet e shoferëve, restoranteve dhe menaxhimin e Sjelle. "));const a=document.createElement("a");a.href=ADMIN_LOGIN_HREF;a.className="primary-button";a.textContent="Kyçu si administrator";e.append(a);e.dataset.kind="warning";}
function adminErrorMessage(err){if(err?.code==="UNAUTHENTICATED"||err?.status===401)return "Sesioni ka skaduar ose nuk është aktiv. Kyçu përsëri me llogarinë e administratorit.";if(err?.code==="FORBIDDEN"||err?.status===403)return "Llogaria është kyçur, por nuk ka rolin admin në sjelle_user_roles. Përdor llogarinë e administratorit; roli nuk jepet automatikisht.";if(err?.code==="ROLE_CHECK_FAILED")return "Nuk mundëm ta verifikojmë rolin admin në Supabase. Provo përsëri më vonë.";return err?.message||"Kërkesa s’u krye.";}
function appendAdminRoleSetupLink(container){const p=document.createElement("p");p.className="portal-muted";p.append(document.createTextNode("Për ta aktivizuar këtë llogari si administratorin e parë, ndiq udhëzimin e sigurt të Sjelle: "));const a=document.createElement("a");a.href=ADMIN_ROLE_SETUP_HREF;a.target="_blank";a.rel="noopener noreferrer";a.textContent="Udhëzimi për rolin e parë admin";p.append(a);container.append(p);}
function renderQueueError(root,prefix,err){root.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:prefix+adminErrorMessage(err)}));if(err?.code==="FORBIDDEN")appendAdminRoleSetupLink(root);}
function renderAdminAlertError(err){const root=$("#admin-alert");root.replaceChildren(document.createTextNode(adminErrorMessage(err)));if(err?.code==="FORBIDDEN")appendAdminRoleSetupLink(root);root.dataset.kind="error";}
async function refreshSession(current){
 const latest=savedSession();
 if(latest?.access_token&&latest.access_token!==current?.access_token)return latest;
 if(!current?.refresh_token)return null;
 if(!refreshPromise){
  refreshPromise=(async()=>{try{const response=await fetch(API+"/auth/refresh",{method:"POST",headers:{"content-type":"application/json",accept:"application/json"},body:JSON.stringify({refresh_token:current.refresh_token}),cache:"no-store"});const body=await response.json();if(!response.ok||!body?.data?.access_token)return null;sessionStorage.setItem("sjelle.session",JSON.stringify(body.data));return body.data;}catch{return null;}})();
 }
 const pending=refreshPromise;const result=await pending;if(refreshPromise===pending)refreshPromise=null;return result;
}
async function api(path,options={},allowRefresh=true){const current=savedSession();const headers=new Headers(options.headers||{});headers.set("accept","application/json");if(current?.access_token)headers.set("authorization","Bearer "+current.access_token);if(options.body&&!headers.has("content-type"))headers.set("content-type","application/json");const res=await fetch(API+path,{...options,headers,cache:"no-store"});let body;try{body=await res.json();}catch{body=null;}if(res.status===401&&allowRefresh){const latest=savedSession();if(latest?.access_token&&latest.access_token!==current?.access_token)return api(path,options,false);const refreshed=await refreshSession(current);if(refreshed)return api(path,options,false);try{sessionStorage.removeItem("sjelle.session");}catch{}}if(!res.ok){const e=new Error(body?.error?.message||body?.error?.code||"Kërkesa s’u krye.");e.code=body?.error?.code;e.status=res.status;throw e;}return body;}
function cents(value){return Math.round(Number(value||0)*100);}
function euros(c){return (Number(c||0)/100).toFixed(2);}
function makeCard(title,description){const c=document.createElement("article");c.className="portal-list-card";const h=document.createElement("strong");h.textContent=title;c.append(h);if(description){const p=document.createElement("p");p.textContent=description;c.append(p);}return c;}
function button(label,cls,handler){const b=document.createElement("button");b.type="button";b.className=cls;b.textContent=label;b.addEventListener("click",handler);return b;}
function setQueueCount(selector,count,label){const e=$(selector);if(!e)return;e.textContent=count===null?"—":String(count);e.setAttribute("aria-label",count===null?label+" nuk u ngarkuan":label+": "+count);}
async function loadCities(){const r=await api("/admin/cities");cities=r.data||[];const sel=$("#admin-city");sel.replaceChildren();for(const city of cities){const o=document.createElement("option");o.value=city.slug;o.textContent=city.name+(city.active?" · aktiv":" · joaktiv");sel.append(o);}if(cities.length){sel.value=cities.some(c=>c.slug==="prishtina")?"prishtina":cities[0].slug;await selectCity();}}
async function selectCity(){currentCity=cities.find(c=>c.slug===$("#admin-city").value)||null;if(!currentCity)return;const p=currentCity.pricing;const f=$("#pricing-form");f.elements.version.value=p?.version||"v1";f.elements.active.checked=Boolean(p?.active);f.elements.food_delivery_fee.value=p?euros(p.food_delivery_fee_cents):"";f.elements.food_service_fee.value=p?euros(p.food_service_fee_cents):"0";f.elements.food_minimum.value=p?euros(p.food_minimum_subtotal_cents):"0";f.elements.ride_base.value=p&&p.ride_base_fare_cents!==null?euros(p.ride_base_fare_cents):"0";f.elements.ride_minimum.value=p&&p.ride_minimum_fare_cents!==null?euros(p.ride_minimum_fare_cents):"0";f.elements.ride_per_km.value=p&&p.ride_per_km_cents!==null?euros(p.ride_per_km_cents):"0";f.elements.ride_per_minute.value=p&&p.ride_per_minute_cents!==null?euros(p.ride_per_minute_cents):"0";const s=$("#city-services-form");s.elements.active.checked=Boolean(currentCity.active);s.elements.rides_enabled.checked=Boolean(currentCity.rides_enabled);s.elements.food_enabled.checked=Boolean(currentCity.food_enabled);s.elements.confirm_ready.checked=false;s.elements.reason.value="";syncCityActivationConfirmation();renderCityReadiness();await loadRoutes();renderServiceAreas();}
const cityServicesForm=$("#city-services-form");
const cityActiveInput=cityServicesForm.elements.active;
const cityConfirmInput=cityServicesForm.elements.confirm_ready;
function syncCityActivationConfirmation(){cityConfirmInput.required=cityActiveInput.checked;if(!cityActiveInput.checked)cityConfirmInput.checked=false;}
cityActiveInput.addEventListener("change",syncCityActivationConfirmation);
syncCityActivationConfirmation();
function isUsableServiceAreaGeometry(value){
 if(!value||!["Polygon","MultiPolygon"].includes(value.type)||!Array.isArray(value.coordinates)||!value.coordinates.length)return false;
 const polygons=value.type==="Polygon"?[value.coordinates]:value.coordinates;
 if(polygons.length>100)return false;
 let vertices=0;
 for(const polygon of polygons){
  if(!Array.isArray(polygon)||!polygon.length||polygon.length>100)return false;
  for(const ring of polygon){
   if(!Array.isArray(ring)||ring.length<4||ring.length>500)return false;
   vertices+=ring.length;if(vertices>10000)return false;
   for(const point of ring){
    if(!Array.isArray(point)||point.length!==2||!Number.isFinite(point[0])||!Number.isFinite(point[1])||point[0]<19.7||point[0]>22||point[1]<41.7||point[1]>43.4)return false;
   }
   const first=ring[0],last=ring[ring.length-1];
   if(Math.abs(first[0]-last[0])>1e-6||Math.abs(first[1]-last[1])>1e-6)return false;
  }
 }
 return true;
}
function renderCityReadiness(){
 const root=$("#city-readiness");if(!root)return;root.replaceChildren();
 if(!currentCity){root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Zgjidh një qytet për të parë kontrollet."}));return;}
 const checks=[
  ["Qyteti",Boolean(currentCity.active),"Qyteti publikisht aktiv"],
  ["Zona e shërbimit",Boolean((currentCity.service_areas||[]).some(area=>area.active&&isUsableServiceAreaGeometry(area.boundary_geojson))),"Të paktën një zonë aktive me gjeometri"],
  ["Tarifat",Boolean(currentCity.pricing?.active),"Konfigurimi i çmimeve aktiv"],
  ["Udhëtimet",Boolean(currentCity.rides_enabled),"Shërbimi i udhëtimeve i aktivizuar"],
  ["Dërgesat e ushqimit",Boolean(currentCity.food_enabled),"Shërbimi i ushqimit i aktivizuar"],
 ];
 for(const [label,ready,detail] of checks){
  const c=makeCard((ready?"✓ ":"! ")+label,detail+" · "+(ready?"Po":"Jo"));
  c.dataset.kind=ready?"success":"warning";root.append(c);
 }
 root.append(makeCard("Furnizimi real","Shoferët/dokumentet/automjetet dhe restorantet/menutë nuk shënohen si të gatshme nga ky përmbledhje; aktivizimi kontrollohet nga serveri."));
}
$("#readiness-refresh")?.addEventListener("click",async()=>{try{await loadCities();renderCityReadiness();alertMsg("Kontrolli u rifreskua nga të dhënat aktuale të administrimit.","success");}catch(err){alertMsg("Kontrolli nuk u rifreskua: "+err.message,"error");}});
$("#admin-city").addEventListener("change",()=>selectCity().catch(e=>alertMsg(e.message,"error")));
$("#pricing-form").addEventListener("submit",async e=>{e.preventDefault();if(!currentCity)return;const f=new FormData(e.currentTarget);const payload={version:String(f.get("version")),active:f.get("active")==="on",food_delivery_fee_cents:cents(f.get("food_delivery_fee")),food_service_fee_cents:cents(f.get("food_service_fee")),food_minimum_subtotal_cents:cents(f.get("food_minimum")),ride_base_fare_cents:cents(f.get("ride_base")),ride_minimum_fare_cents:cents(f.get("ride_minimum")),ride_per_km_cents:cents(f.get("ride_per_km")),ride_per_minute_cents:cents(f.get("ride_per_minute"))};try{await api("/admin/cities/"+currentCity.slug+"/pricing",{method:"PUT",body:JSON.stringify(payload)});alertMsg("Tarifat u ruajtën. Çmimet janë të shprehura në cent euro dhe konfigurimi aktivizohet vetëm kur e zgjedh.","success");await loadCities();}catch(err){alertMsg("Tarifat nuk u ruajtën: "+err.message,"error");}});
$("#city-services-form").addEventListener("submit",async e=>{e.preventDefault();if(!currentCity)return;const f=new FormData(e.currentTarget);try{await api("/admin/cities/"+currentCity.slug+"/services",{method:"PATCH",body:JSON.stringify({active:f.get("active")==="on",rides_enabled:f.get("rides_enabled")==="on",food_enabled:f.get("food_enabled")==="on",confirm_ready:f.get("confirm_ready")==="on",reason:String(f.get("reason")||"")})});alertMsg("Disponueshmëria e qytetit u përditësua.","success");await loadCities();}catch(err){alertMsg("Qyteti nuk u aktivizua: "+err.message,"error");}});
async function loadRoutes(){if(!currentCity)return;const root=$("#route-list");root.replaceChildren();try{const r=await api("/admin/routes?city="+encodeURIComponent(currentCity.slug));for(const route of r.data||[]){const c=makeCard(route.origin_label+" → "+route.destination_label,route.route_key+" · "+route.vehicle_type+" · "+(Number(route.amount_cents)/100).toFixed(2)+" € · "+(route.active?"Aktive":"Joaktive"));const actions=document.createElement("div");actions.className="portal-list-actions";actions.append(button(route.active?"Çaktivizo":"Aktivizo",route.active?"secondary-button":"primary-button",async()=>{try{await api("/admin/routes/"+route.id,{method:"PATCH",body:JSON.stringify({active:!route.active})});alertMsg("Statusi i rrugës u ndryshua.","success");await loadRoutes();}catch(err){alertMsg("Rruga nuk u përditësua: "+err.message,"error");}}));c.append(actions);root.append(c);}if(!(r.data||[]).length)root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Nuk ka rrugë të konfiguruara për këtë qytet."}));}catch(err){root.textContent="Rrugët nuk mund të ngarkohen: "+err.message;}}
$("#routes-refresh").addEventListener("click",loadRoutes);
$("#route-form").addEventListener("submit",async e=>{e.preventDefault();if(!currentCity)return;const f=new FormData(e.currentTarget);const payload={city:currentCity.slug,route_key:f.get("route_key"),vehicle_type:f.get("vehicle_type"),origin_label:f.get("origin_label"),destination_label:f.get("destination_label"),amount_cents:cents(f.get("amount")),version:f.get("version"),origin_lat:Number(f.get("origin_lat")),origin_lon:Number(f.get("origin_lon")),destination_lat:Number(f.get("destination_lat")),destination_lon:Number(f.get("destination_lon"))};try{const r=await api("/admin/routes",{method:"POST",body:JSON.stringify(payload)});alertMsg("Rruga u krijua si joaktive. Kontrollo etiketat, koordinatat dhe çmimin para aktivizimit.","success");e.currentTarget.reset();e.currentTarget.elements.version.value="fixed-v1";await loadRoutes();}catch(err){alertMsg("Rruga nuk u krijua: "+err.message,"error");}});
async function review(path,payload){await api(path,{method:"PATCH",body:JSON.stringify(payload)});await loadQueue();}
async function loadQueue(){const root=$("#driver-queue");root.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Po ngarkojmë aplikimet…"}));try{const r=await api("/admin/driver-documents");root.replaceChildren();const data=r.data||{};setQueueCount("#driver-queue-count",(data.documents||[]).length+(data.vehicles||[]).length+(data.drivers||[]).length,"Rishikime të shoferëve në pritje");for(const d of data.documents||[]){const c=makeCard("Dokument · "+d.document_type,"Shoferi: "+d.driver_id+" · 4 shenjat: "+(d.document_number_last4||"—")+" · Skadon: "+(d.expires_at||"—"));const actions=document.createElement("div");actions.className="portal-list-actions";actions.append(button("Shiko dokumentin","secondary-button",async()=>{try{const signed=await api("/admin/driver-documents/"+d.id+"/signed-url",{method:"POST"});window.open(signed.data.url,"_blank","noopener,noreferrer");}catch(err){alertMsg("Dokumenti nuk u hap: "+err.message,"error");}}));actions.append(button("Aprovo","primary-button",()=>review("/admin/driver-documents/"+d.id+"/review",{review_status:"approved"}).then(()=>alertMsg("Dokumenti u aprovua.","success")).catch(err=>alertMsg(err.message,"error"))));actions.append(button("Refuzo","secondary-button",()=>{const reason=prompt("Arsyeja e refuzimit?","Dokumenti duhet të jetë i qartë dhe i vlefshëm.");if(reason!==null)review("/admin/driver-documents/"+d.id+"/review",{review_status:"rejected",rejection_reason:reason}).then(()=>alertMsg("Dokumenti u refuzua.","success")).catch(err=>alertMsg(err.message,"error"));}));c.append(actions);root.append(c);}for(const v of data.vehicles||[]){const c=makeCard("Automjet · "+v.vehicle_type,[v.make,v.model,v.color,v.registration_number].filter(Boolean).join(" · "),"pending");const actions=document.createElement("div");actions.className="portal-list-actions";actions.append(button("Aprovo automjetin","primary-button",()=>review("/admin/vehicles/"+v.id+"/review",{review_status:"approved",document_expires_at:v.document_expires_at||null}).then(()=>alertMsg("Automjeti u aprovua.","success")).catch(err=>alertMsg(err.message,"error"))));actions.append(button("Refuzo","secondary-button",()=>review("/admin/vehicles/"+v.id+"/review",{review_status:"rejected"}).then(()=>alertMsg("Automjeti u refuzua.","success")).catch(err=>alertMsg(err.message,"error"))));c.append(actions);root.append(c);}for(const d of data.drivers||[]){const c=makeCard("Aplikim shoferi",d.user_id+" · "+d.selected_mode+" · qyteti "+d.city_id);const actions=document.createElement("div");actions.className="portal-list-actions";actions.append(button("Aprovo shoferin","primary-button",()=>review("/admin/drivers/"+d.user_id+"/review",{review_status:"approved"}).then(()=>alertMsg("Shoferi u aprovua.","success")).catch(err=>alertMsg("Shoferi nuk mund të aprovohet ende: "+err.message,"error"))));actions.append(button("Refuzo","secondary-button",()=>review("/admin/drivers/"+d.user_id+"/review",{review_status:"rejected"}).then(()=>alertMsg("Aplikimi u refuzua.","success")).catch(err=>alertMsg(err.message,"error"))));c.append(actions);root.append(c);}if(!root.children.length)root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Nuk ka dokumente, automjete ose aplikime në pritje."}));return true;}catch(err){setQueueCount("#driver-queue-count",null,"Rishikimet e shoferëve");renderQueueError(root,"Radhët nuk mund të ngarkohen: ",err);return false;}}
$("#queue-refresh").addEventListener("click",loadQueue);
async function loadRestaurantQueue(){
 const root=$("#admin-restaurants");root.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Po ngarkojmë aplikimet…"}));
 try{
  const r=await api("/admin/restaurants");root.replaceChildren();const rows=r.data||[];setQueueCount("#restaurant-queue-count",rows.length,"Aplikime restorantesh në pritje");
  if(!rows.length){root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Nuk ka aplikime restorantesh në pritje."}));return true;}
  for(const rest of rows){
   const c=makeCard(rest.name,rest.address_text+" · "+rest.slug+" · pronari: "+rest.owner_id);
   const desc=document.createElement("p");desc.textContent=(rest.phone||"Pa telefon")+" · koordinatat "+rest.latitude+", "+rest.longitude;c.append(desc);
   const actions=document.createElement("div");actions.className="portal-list-actions";
   actions.append(button("Aprovo","primary-button",async()=>{try{await api("/admin/restaurants/"+rest.id+"/review",{method:"PATCH",body:JSON.stringify({approval_status:"approved"})});alertMsg("Restoranti u aprovua, por mbetet i mbyllur derisa pronari të konfigurojë menunë dhe shërbimet.","success");await loadRestaurantQueue();}catch(err){alertMsg("Aplikimi nuk u aprovua: "+err.message,"error");}}));
   actions.append(button("Refuzo","secondary-button",async()=>{try{await api("/admin/restaurants/"+rest.id+"/review",{method:"PATCH",body:JSON.stringify({approval_status:"rejected"})});alertMsg("Aplikimi u refuzua.","success");await loadRestaurantQueue();}catch(err){alertMsg(err.message,"error");}}));
   c.append(actions);root.append(c);
  }
  return true;
 }catch(err){setQueueCount("#restaurant-queue-count",null,"Aplikimet e restoranteve");renderQueueError(root,"Aplikimet nuk mund të ngarkohen: ",err);return false;}
}
$("#restaurants-refresh").addEventListener("click",loadRestaurantQueue);

function renderServiceAreas(){
 const root=$("#service-area-list");if(!root)return;root.replaceChildren();
 const areas=currentCity?.service_areas||[];
 if(!areas.length){root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Nuk ka zona shërbimi. Krijo dhe aktivizo një zonë para aktivizimit të qytetit."}));return;}
 for(const area of areas){
  const geometry=area.boundary_geojson;
  const geometryType=geometry&&typeof geometry.type==="string"?geometry.type:"GeoJSON mungon";
  const status=area.active?"Aktive — mund të përdoret për verifikimin e adresave":"Joaktive — ende nuk përdoret për verifikimin e adresave";
  const c=makeCard(area.name,status+" · Gjeometria: "+geometryType);
  const actions=document.createElement("div");actions.className="portal-list-actions";
  if(geometry&&["Polygon","MultiPolygon"].includes(geometry.type)){
   const preview=document.createElement("a");
   const feature={type:"Feature",properties:{name:area.name,city:currentCity.name},geometry};
   const collection={type:"FeatureCollection",features:[feature]};
   preview.href="https://geojson.io/#data=data:application/json,"+encodeURIComponent(JSON.stringify(collection));
   preview.target="_blank";preview.rel="noopener noreferrer";preview.className="secondary-button";
   preview.textContent="Shiko kufirin në hartë";
   preview.setAttribute("aria-label","Shiko kufirin e zonës "+area.name+" në hartë");
   actions.append(preview);
  }
  actions.append(button(area.active?"Çaktivizo zonën":"Aktivizo zonën",area.active?"secondary-button":"primary-button",async()=>{try{await api("/admin/service-areas/"+area.id,{method:"PATCH",body:JSON.stringify({active:!area.active})});await loadCities();alertMsg("Zona e shërbimit u përditësua.","success");}catch(err){alertMsg("Zona nuk u përditësua: "+err.message,"error");}}));
  c.append(actions);root.append(c);
 }
}
$("#service-area-form").addEventListener("submit",async e=>{
 e.preventDefault();if(!currentCity)return;const f=new FormData(e.currentTarget);
 let polygon;try{polygon=JSON.parse(String(f.get("boundary_geojson")||""));}catch{alertMsg("GeoJSON nuk është JSON i vlefshëm.","error");return;}
 try{await api("/admin/cities/"+currentCity.slug+"/service-areas",{method:"POST",body:JSON.stringify({name:f.get("name"),boundary_geojson:polygon})});e.currentTarget.reset();await loadCities();alertMsg("Zona u krijua joaktive. Kontrollo kufijtë dhe aktivizoje para se të hapësh qytetin.","success");}
 catch(err){alertMsg("Zona nuk u krijua: "+err.message,"error");}
});


function localDateInput(date){
 const y=date.getFullYear(),m=String(date.getMonth()+1).padStart(2,"0"),d=String(date.getDate()).padStart(2,"0");
 return y+"-"+m+"-"+d;
}
function renderReconciliationSummary(summary,meta){
 const root=$("#reconciliation-summary");root.replaceChildren();
 const note=document.createElement("p");note.className="portal-muted";
 note.textContent="Periudha "+meta.from+" — "+meta.to+" · "+meta.returned+" hyrje"+(meta.possibly_truncated?" · KUJDES: u arrit kufiri prej 1,000 hyrjesh; ky nuk është raport i plotë.":"");
 root.append(note);
 for(const item of summary||[]){
  const c=makeCard(item.account_type,String(item.entry_count)+" hyrje · "+(Number(item.net_amount_cents)/100).toFixed(2)+" € neto");
  root.append(c);
 }
}
function renderReconciliationEntries(rows,meta){
 const root=$("#reconciliation-entries");root.replaceChildren();
 const entries=(rows||[]).slice(0,100);
 if(!entries.length){root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Nuk ka hyrje financiare në këtë periudhë."}));return;}
 for(const row of entries){
  const related=row.related_ride_id?"Udhëtimi "+row.related_ride_id:row.related_order_id?"Porosia "+row.related_order_id:"Pa lidhje";
  const signed=(Number(row.amount_cents)/100).toFixed(2)+" "+(Number(row.amount_cents)<0?"€ (dalje)":"€ (hyrje)");
  const c=makeCard(row.entry_type||row.account_type,related+" · "+signed+" · "+new Date(row.created_at).toLocaleString());
  const detail=document.createElement("p");detail.className="portal-muted";detail.textContent=row.account_type+" · "+row.currency+" · idempotency: "+row.idempotency_key;c.append(detail);
  root.append(c);
 }
 if((rows||[]).length>entries.length){
  const note=document.createElement("p");note.className="portal-muted";
  note.textContent="Po shfaqen "+entries.length+" hyrjet e para nga "+rows.length+" të kthyera. Përdor një periudhë më të shkurtër për të kontrolluar detajet.";
  root.append(note);
 }
 if(meta?.possibly_truncated){
  const warning=document.createElement("p");warning.className="portal-alert";warning.dataset.kind="error";
  warning.textContent="Raporti ka arritur kufirin e API-së (1,000 hyrje). Për shifra përfundimtare duhet ndarë periudha në intervale më të shkurtra.";
  root.prepend(warning);
 }
}
async function loadReconciliation(){
 const form=$("#reconciliation-form");const from=form.elements.from.value,to=form.elements.to.value;
 const summary=$("#reconciliation-summary"),entries=$("#reconciliation-entries");
 summary.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Po ngarkohet raporti…"}));entries.replaceChildren();
 try{
  const result=await api("/admin/reconciliation?from="+encodeURIComponent(from)+"&to="+encodeURIComponent(to));
  renderReconciliationSummary(result.summary||[],result.meta||{from,to,returned:(result.data||[]).length});
  renderReconciliationEntries(result.data||[],result.meta||{});
  alertMsg("Raporti financiar u ngarkua. Kontrollo nëse periudha është e plotë para se të marrësh vendime.","success");
 }catch(err){
  summary.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Raporti nuk mund të ngarkohet: "+err.message}));
  alertMsg("Rakordimi dështoi: "+err.message,"error");
 }
}
const reconciliationForm=$("#reconciliation-form");
if(reconciliationForm){
 const now=new Date(),monthAgo=new Date(now);monthAgo.setDate(monthAgo.getDate()-29);
 reconciliationForm.elements.from.value=localDateInput(monthAgo);
 reconciliationForm.elements.to.value=localDateInput(now);
 reconciliationForm.addEventListener("submit",e=>{e.preventDefault();loadReconciliation();});
 $("#reconciliation-refresh").addEventListener("click",loadReconciliation);
}


const supportStatusLabel = {open:"E hapur",in_progress:"Në verifikim",resolved:"E zgjidhur",closed:"E mbyllur"};
const supportCategoryLabel = {ride:"Udhëtim",food_order:"Porosi ushqimi",payment:"Pagesa",safety:"Siguria",driver:"Shoferi",restaurant:"Restoranti",account:"Llogaria",other:"Tjetër"};
async function loadSupportTickets(){
 const root=$("#admin-support-tickets");if(!root)return;
 root.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Po ngarkohen kërkesat…"}));
 try{
  const result=await api("/admin/support-tickets");const tickets=result.data||[];root.replaceChildren();
  if(!tickets.length){root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"S’ka kërkesa për ndihmë."}));return true;}
  for(const ticket of tickets){
   const c=makeCard((supportCategoryLabel[ticket.category]||"Kërkesë")+" · "+(supportStatusLabel[ticket.status]||ticket.status),ticket.description);
   const meta=document.createElement("p");meta.className="portal-muted";meta.textContent="Krijuar: "+new Date(ticket.created_at).toLocaleString("sq-XK")+" · Klienti: "+ticket.requester_id+(ticket.ride_id?" · Udhëtimi: "+ticket.ride_id:"")+(ticket.order_id?" · Porosia: "+ticket.order_id:"")+(ticket.assigned_to?" · Caktuar: "+ticket.assigned_to:"");c.append(meta);
   const actions=document.createElement("div");actions.className="portal-list-actions";
   for(const [status,label] of [["open","Rihap"],["in_progress","Merre në shqyrtim"],["resolved","Zgjidhur"],["closed","Mbyll"]]){
    if(status===ticket.status)continue;
    actions.append(button(label,status==="resolved"?"primary-button":"secondary-button",async()=>{
     try{await api("/admin/support-tickets/"+ticket.id,{method:"PATCH",body:JSON.stringify({status})});alertMsg("Statusi i kërkesës u ruajt dhe u regjistrua.","success");await loadSupportTickets();}
     catch(err){alertMsg("Kërkesa s’u përditësua: "+err.message,"error");}
    }));
   }
   c.append(actions);root.append(c);
  }
  return true;
 }catch(err){root.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Kërkesat s’u ngarkuan: "+adminErrorMessage(err)}));return false;}
}
$("#support-refresh")?.addEventListener("click",loadSupportTickets);

async function bootAdmin(){
 const accessToken=token();
 if(!accessToken){adminBootToken="";showLoginRequired();return;}
 if(adminBooting||adminBootToken===accessToken)return;
 adminBootToken=accessToken;adminBooting=true;
 alertMsg("Po verifikojmë qasjen dhe po ngarkojmë aplikimet…");
 try{
  const results=await Promise.all([loadCities(),loadQueue(),loadRestaurantQueue(),loadSupportTickets()]);
  if(!token()){adminBootToken="";showLoginRequired();return;}
  adminBootToken=token();
  if(results.some(result=>result===false))alertMsg("Disa seksione nuk u ngarkuan. Kontrollo mesazhin te secila listë dhe përdor Rifresko.","error");
  else alertMsg("Paneli administrativ u ngarkua. Të dhënat dhe miratimet lexohen nga API-ja e mbrojtur.","success");
 }catch(err){if(!token())showLoginRequired();else renderAdminAlertError(err);}
 finally{adminBooting=false;}
}
window.addEventListener("pageshow",()=>{const current=token();if(current&&current!==adminBootToken)bootAdmin();});
document.addEventListener("visibilitychange",()=>{const current=token();if(document.visibilityState==="visible"&&current&&current!==adminBootToken)bootAdmin();});
bootAdmin();
