
const $=id=>document.getElementById(id);
let lastRows=[];
const fmt=n=>Number(n||0).toLocaleString("zh-TW");
const icon=c=>c==="魔晶"?"💎":"🪙";
const cls=c=>c==="魔晶"?"crystal":"gold";

function selectedCurrency(){
  const v=$("currency").value;
  return v==="gold"?"金幣":v==="crystal"?"魔晶":"all";
}
function setCurrency(v){
  $("currency").value=v;
  document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.cur===v));
}
document.querySelectorAll(".tab").forEach(b=>b.addEventListener("click",()=>{setCurrency(b.dataset.cur); search()}));
$("currency").addEventListener("change",()=>setCurrency($("currency").value));

async function search(){
  const q=$("q").value.trim();
  if(!q){$("status").textContent="請輸入關鍵字。";return}
  const base=(window.STARCG_API||"").replace(/\/$/,"");
  if(!base || base.includes("PASTE_YOUR")){
    $("status").innerHTML='尚未設定即時搜尋 API。請先部署專案內的 Cloudflare Worker，然後把網址填入 <code>config.js</code>。';
    return;
  }
  $("status").textContent=`正在原始 StarCG 市場搜尋「${q}」…`;
  $("results").innerHTML="";
  $("summary").classList.add("hidden");
  const p=new URLSearchParams({
    q,
    server:$("server").value,
    type:$("type").value,
    currency:selectedCurrency()
  });
  try{
    const r=await fetch(`${base}/search?${p}`,{cache:"no-store"});
    const d=await r.json();
    if(!r.ok) throw new Error(d.error||`HTTP ${r.status}`);
    lastRows=d.items||[];
    render(lastRows,d);
  }catch(e){
    $("status").textContent="搜尋失敗："+e.message;
  }
}

function render(rows,d){
  const sort=$("sort").value;
  rows=[...rows].sort((a,b)=>sort==="unit"?(a.unit_price-a.unit_price||0)-(b.unit_price||b.price):a.price-b.price);
  // Fix sort expression robustly
  if(sort==="unit") rows.sort((a,b)=>(a.unit_price||a.price)-(b.unit_price||b.price));
  else rows.sort((a,b)=>a.price-b.price);

  $("status").textContent=`原始市場找到 ${rows.length} 筆攤位商品${d.result_pages>1?`（原站搜尋結果共 ${d.result_pages} 頁，已全部合併）`:""}。`;

  if(!rows.length){
    $("results").innerHTML='<div class="empty">原始市場沒有找到符合關鍵字的商品。</div>';
    return;
  }

  const gold=rows.filter(x=>x.currency==="金幣");
  const cry=rows.filter(x=>x.currency==="魔晶");
  const min=a=>a.length?Math.min(...a.map(x=>x.price)):null;
  $("summary").innerHTML=`
    <div><span class="k">找到攤位</span><span class="v">${rows.length}</span></div>
    <div><span class="k">🪙 最低金幣價</span><span class="v">${min(gold)==null?"—":fmt(min(gold))}</span></div>
    <div><span class="k">💎 最低魔晶價</span><span class="v">${min(cry)==null?"—":fmt(min(cry))}</span></div>
    <div><span class="k">來源</span><span class="v">即時原站搜尋</span></div>`;
  $("summary").classList.remove("hidden");

  const minBy={};
  rows.forEach(x=>{if(minBy[x.currency]==null||x.price<minBy[x.currency])minBy[x.currency]=x.price});
  $("results").innerHTML=rows.map(x=>{
    const best=x.price===minBy[x.currency];
    return `<article class="card ${best?"best":""}">
      <div class="top">
        <div>
          <div class="name">${esc(x.name)}</div>
          <div class="tags">
            <span class="tag">${esc(x.type||"")}</span>
            <span class="tag">${esc(x.server||"")}</span>
            ${best?'<span class="tag">目前最低</span>':""}
            ${x.quantity>1?`<span class="tag">x${fmt(x.quantity)}</span>`:""}
          </div>
        </div>
        <div class="price ${cls(x.currency)}">${icon(x.currency)} ${fmt(x.price)} ${x.currency}
          ${x.quantity>1?`<div class="muted">單價約 ${fmt(Math.round(x.unit_price))} / 個</div>`:""}
        </div>
      </div>
      <div class="grid">
        <div class="cell"><small>伺服器</small><b>${esc(x.server||"—")}</b></div>
        <div class="cell"><small>城市 / 地點</small><b>${esc(x.place||"—")}</b></div>
        <div class="cell"><small>座標</small><b class="coord">${x.east!=null?`東:${x.east}　南:${x.south}`:"—"}</b></div>
        <div class="cell"><small>攤販</small><b>${esc(x.shop||"—")}</b></div>
      </div>
      ${x.expires?`<div class="muted" style="margin-top:9px">攤位到期：${esc(x.expires)}</div>`:""}
    </article>`;
  }).join("");
}
const esc=s=>String(s??"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
$("search").addEventListener("click",search);
$("q").addEventListener("keydown",e=>{if(e.key==="Enter")search()});
$("server").addEventListener("change",()=>{if($("q").value.trim())search()});
$("type").addEventListener("change",()=>{if($("q").value.trim())search()});
$("sort").addEventListener("change",()=>{if(lastRows.length)render(lastRows,{result_pages:1})});
