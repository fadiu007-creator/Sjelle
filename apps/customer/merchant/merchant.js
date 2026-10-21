const API = "https://saavqlbwffrwxingbnri.supabase.co/functions/v1/sjelle-api/api/v1";
function button(label,cls,handler){const b=document.createElement("button");b.type="button";b.className=cls;b.textContent=label;b.addEventListener("click",handler);return b;}
const $=s=>document.querySelector(s);$("#year").textContent=String(new Date().getFullYear());
function alertMsg(t,k=""){const e=$("#merchant-alert");e.textContent=t;if(k)e.dataset.kind=k;else delete e.dataset.kind;}
function token(){try{return JSON.parse(sessionStorage.getItem("sjelle.session")||"null")?.access_token||"";}catch{return "";}}
async function api(path,options={}){const headers=new Headers(options.headers||{});headers.set("accept","application/json");if(token())headers.set("authorization","Bearer "+token());if(options.body&&!headers.has("content-type"))headers.set("content-type","application/json");const res=await fetch(API+path,{...options,headers,cache:"no-store"});let body;try{body=await res.json();}catch{body=null;}if(!res.ok){const e=new Error(body?.error?.message||body?.error?.code||"Kërkesa s’u krye.");e.code=body?.error?.code;throw e;}return body;}
const statuses={submitted:"Në pritje",accepted:"Pranuar",preparing:"Në përgatitje",ready_for_pickup:"Gati për korrierin",courier_assigned:"Korrieri u caktua",picked_up:"U mor nga korrieri",delivered:"Dorëzuar",rejected:"Refuzuar",cancelled:"Anuluar",delivery_failed:"Dërgesa dështoi"};
function money(n){return new Intl.NumberFormat("sq-XK",{style:"currency",currency:"EUR"}).format((Number(n)||0)/100);}
async function load(){if(!token()){alertMsg("Hyr me llogarinë e pronarit ose stafit të restorantit në faqen kryesore, pastaj kthehu këtu.","error");return;}$("#merchant-orders").replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Po ngarkojmë porositë…"}));try{const r=await api("/merchant/orders");const data=r.data||{};const restaurants=data.restaurants||[];const orders=data.orders||[];const rr=$("#restaurant-list");rr.replaceChildren();if(!restaurants.length)rr.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Kjo llogari nuk ka restorante me qasje në porosi."}));for(const rest of restaurants){const c=document.createElement("article");c.className="portal-list-card";const title=document.createElement("strong");title.textContent=rest.name;c.append(title);const p=document.createElement("p");p.textContent=(rest.is_open?"Hapur":"Mbyllur")+" · "+(rest.delivery_enabled?"Dërgesa aktive":"Dërgesat joaktive");c.append(p);rr.append(c);}const root=$("#merchant-orders");root.replaceChildren();if(!orders.length){root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Nuk ka porosi për momentin."}));}for(const o of orders){const rest=restaurants.find(r=>r.id===o.restaurant_id);const c=document.createElement("article");c.className="portal-list-card";const h=document.createElement("strong");h.textContent=(rest?.name||"Restoranti")+" · "+money(o.total_cents);c.append(h);const p=document.createElement("p");p.textContent=(statuses[o.status]||o.status)+" · "+(o.payment_method==="cash"?"Para në dorë":"Pagesë online")+" · "+o.delivery_address_text;c.append(p);const items=document.createElement("p");items.textContent=(o.sjelle_food_order_items||[]).map(i=>i.quantity+"× "+i.item_name_snapshot).join(", ");c.append(items);if(o.delivery_instructions){const note=document.createElement("p");note.textContent="Udhëzime: "+o.delivery_instructions;c.append(note);}const actions=document.createElement("div");actions.className="portal-list-actions";const choices=o.status==="submitted"?[["accepted","Prano"],["rejected","Refuzo"]]:o.status==="accepted"?[["preparing","Fillo përgatitjen"]]:o.status==="preparing"||o.status==="courier_assigned"&&!o.ready_at?[["ready_for_pickup","Gati për korrierin"]]:[];for(const [next,label] of choices){const b=document.createElement("button");b.type="button";b.className=next==="rejected"?"secondary-button":"primary-button";b.textContent=label;b.addEventListener("click",async()=>{b.disabled=true;try{await api("/merchant/orders/"+o.id+"/status",{method:"PATCH",body:JSON.stringify({status:next})});alertMsg("Statusi i porosisë u përditësua.","success");await load();}catch(e){b.disabled=false;alertMsg("Nuk mundëm të përditësojmë porosinë: "+e.message,"error");}});actions.append(b);}if(actions.children.length)c.append(actions);root.append(c);}alertMsg("Lidhja u verifikua. Porositë shfaqen nga baza reale e të dhënave.","success");}catch(e){alertMsg("Nuk mundëm të ngarkojmë porositë: "+e.message,"error");}}
$("#merchant-refresh").addEventListener("click",load);load();

async function loadMerchantCities(){
  try{
    const r=await api("/cities");
    const sel=$("#merchant-city");sel.replaceChildren();
    for(const city of r.data||[]){const o=document.createElement("option");o.value=city.slug;o.textContent=city.name;sel.append(o);}
  }catch(e){alertMsg("Qytetet nuk u ngarkuan: "+e.message,"error");}
}
$("#restaurant-apply").addEventListener("submit",async e=>{
  e.preventDefault();const f=new FormData(e.currentTarget);
  try{
    const r=await api("/merchant/restaurants",{method:"POST",body:JSON.stringify({
      city:f.get("city"),name:f.get("name"),slug:String(f.get("slug")||"").trim().toLowerCase(),
      phone:f.get("phone"),description:f.get("description"),address_text:f.get("address_text"),
      latitude:Number(f.get("latitude")),longitude:Number(f.get("longitude")),
    })});
    alertMsg("Aplikimi u dërgua. Restoranti nuk është publik ose i hapur deri në aprovim.","success");
    e.currentTarget.reset();await loadMerchantCities();await loadRestaurantManager();
  }catch(err){alertMsg("Aplikimi dështoi: "+err.message,"error");}
});

async function loadRestaurantManager(){
  const root=$("#merchant-restaurants");if(!root)return;
  root.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Po ngarkojmë restorantet dhe menutë…"}));
  try{
    const r=await api("/merchant/restaurants");const restaurants=r.data||[];root.replaceChildren();
    if(!restaurants.length){root.append(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Nuk ka restorante në këtë llogari. Dërgo një aplikim më sipër."}));return;}
    for(const restaurant of restaurants){
      const c=document.createElement("article");c.className="portal-list-card";
      const h=document.createElement("strong");h.textContent=restaurant.name;c.append(h);
      const status=document.createElement("span");status.className="portal-status "+(restaurant.approval_status==="approved"?"approved":"pending");status.textContent="Aprovimi: "+restaurant.approval_status;c.append(status);
      const meta=document.createElement("p");meta.textContent=restaurant.slug+" · "+restaurant.address_text;c.append(meta);
      const controls=document.createElement("div");controls.className="admin-checkboxes";
      const openLabel=document.createElement("label");const open=document.createElement("input");open.type="checkbox";open.checked=Boolean(restaurant.is_open);open.disabled=restaurant.approval_status!=="approved";openLabel.append(open,document.createTextNode(" Hapur"));controls.append(openLabel);
      const deliveryLabel=document.createElement("label");const delivery=document.createElement("input");delivery.type="checkbox";delivery.checked=Boolean(restaurant.delivery_enabled);delivery.disabled=restaurant.approval_status!=="approved";deliveryLabel.append(delivery,document.createTextNode(" Pranon dërgesa"));controls.append(deliveryLabel);c.append(controls);
      const save=button("Ruaj statusin","primary-button",async()=>{save.disabled=true;try{await api("/merchant/restaurants/"+restaurant.id+"/settings",{method:"PATCH",body:JSON.stringify({is_open:open.checked,delivery_enabled:delivery.checked})});alertMsg("Statusi i restorantit u ruajt.","success");await loadRestaurantManager();}catch(err){save.disabled=false;alertMsg("Statusi nuk u ruajt: "+err.message,"error");}});save.disabled=restaurant.approval_status!=="approved";c.append(save);
      const section=document.createElement("div");section.className="portal-menu-manager";
      const categoryTitle=document.createElement("strong");categoryTitle.textContent="Kategoritë e menusë";section.append(categoryTitle);
      const categories=restaurant.categories||[];
      for(const category of categories){const p=document.createElement("p");p.textContent=category.name;section.append(p);}
      if(restaurant.can_manage_menu){
        const categoryForm=document.createElement("form");categoryForm.className="portal-inline-form";
        const categoryInput=document.createElement("input");categoryInput.required=true;categoryInput.maxLength=80;categoryInput.placeholder="Emri i kategorisë";
        const categoryButton=document.createElement("button");categoryButton.className="secondary-button";categoryButton.type="submit";categoryButton.textContent="Shto kategori";
        categoryForm.append(categoryInput,categoryButton);
        categoryForm.addEventListener("submit",async event=>{event.preventDefault();try{await api("/merchant/restaurants/"+restaurant.id+"/categories",{method:"POST",body:JSON.stringify({name:categoryInput.value.trim()})});await loadRestaurantManager();alertMsg("Kategoria u shtua.","success");}catch(err){alertMsg("Kategoria nuk u shtua: "+err.message,"error");}});
        section.append(categoryForm);
        const menuTitle=document.createElement("strong");menuTitle.textContent="Artikujt e menusë";section.append(menuTitle);
        for(const item of restaurant.menu_items||[]){
          const itemRow=document.createElement("div");itemRow.className="portal-menu-item";
          const itemText=document.createElement("span");itemText.textContent=item.name+" · "+money(item.price_cents)+" · "+(item.available?"Në menu":"Joaktiv");itemRow.append(itemText);
          itemRow.append(button(item.available?"Çaktivizo":"Aktivizo","secondary-button",async()=>{try{await api("/merchant/menu-items/"+item.id,{method:"PATCH",body:JSON.stringify({available:!item.available})});await loadRestaurantManager();}catch(err){alertMsg("Artikulli nuk u përditësua: "+err.message,"error");}}));
          section.append(itemRow);
        }
        const itemForm=document.createElement("form");itemForm.className="portal-menu-form";
        const itemName=document.createElement("input");itemName.required=true;itemName.maxLength=120;itemName.placeholder="Emri i artikullit";
        const itemDescription=document.createElement("input");itemDescription.maxLength=1000;itemDescription.placeholder="Përshkrimi (opsional)";
        const itemPrice=document.createElement("input");itemPrice.type="number";itemPrice.min="0";itemPrice.step="0.01";itemPrice.required=true;itemPrice.placeholder="Çmimi (€)";
        const categorySelect=document.createElement("select");const noCategory=document.createElement("option");noCategory.value="";noCategory.textContent="Pa kategori";categorySelect.append(noCategory);for(const category of categories){const o=document.createElement("option");o.value=category.id;o.textContent=category.name;categorySelect.append(o);}
        const itemButton=document.createElement("button");itemButton.type="submit";itemButton.className="primary-button";itemButton.textContent="Shto artikull";
        itemForm.append(itemName,itemDescription,itemPrice,categorySelect,itemButton);
        itemForm.addEventListener("submit",async event=>{event.preventDefault();try{await api("/merchant/restaurants/"+restaurant.id+"/menu-items",{method:"POST",body:JSON.stringify({name:itemName.value.trim(),description:itemDescription.value.trim(),price_cents:Math.round(Number(itemPrice.value)*100),category_id:categorySelect.value||null,available:true})});await loadRestaurantManager();alertMsg("Artikulli u shtua në menu.","success");}catch(err){alertMsg("Artikulli s’u shtua: "+err.message,"error");}});
        section.append(itemForm);
      }
      c.append(section);root.append(c);
    }
  }catch(err){root.replaceChildren(Object.assign(document.createElement("p"),{className:"portal-muted",textContent:"Restorantet s’u ngarkuan: "+err.message}));}
}
$("#merchant-manage-refresh").addEventListener("click",loadRestaurantManager);
loadMerchantCities();
loadRestaurantManager();

setInterval(()=>{if(document.visibilityState==='visible'&&token())load();},15000);
