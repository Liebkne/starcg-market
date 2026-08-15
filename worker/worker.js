
const ORIGIN = "https://member.starcg.net";
const START = ORIGIN + "/market.php?page=1&type=all&server=all";
const MAX_RESULT_PAGES = 40;

export default {
  async fetch(request) {
    const u = new URL(request.url);
    if (request.method === "OPTIONS") return cors(new Response(null,{status:204}));
    if (u.pathname === "/" || u.pathname === "/health") {
      return cors(json({ok:true,mode:"StarCG direct search proxy"}));
    }
    if (u.pathname !== "/search") return cors(json({error:"Not found"},404));

    const q=(u.searchParams.get("q")||"").trim();
    if(!q) return cors(json({error:"Missing q"},400));

    try{
      const server=u.searchParams.get("server")||"all";
      const type=u.searchParams.get("type")||"all";
      const currency=u.searchParams.get("currency")||"all";

      // 1) Read the original market page and dynamically discover its search
      // input name/form method. This means we do not hard-code the site's
      // private search parameter.
      const landing=await fetchText(START);
      const form=discoverSearchForm(landing);

      // 2) Submit the user's keyword to the ORIGINAL StarCG search.
      let first = await submitOriginalSearch(form,q,server,type);

      // 3) Parse the original search result only.
      // If the site's keyword result itself has "next page", follow only those
      // result pages. We never scan the 100+ unfiltered market pages.
      let items=[];
      let visited=new Set();
      let pages=0;
      let current=first;
      while(current && pages<MAX_RESULT_PAGES){
        pages++;
        items.push(...parseMarket(current.html));
        const next=findNextHref(current.html);
        if(!next) break;
        const nextUrl=new URL(next,current.url).href;
        if(visited.has(nextUrl)) break;
        visited.add(nextUrl);
        current={url:nextUrl,html:await fetchText(nextUrl)};
      }

      // Keep only requested currency and dedupe.
      if(currency!=="all") items=items.filter(x=>x.currency===currency);
      const map=new Map();
      for(const x of items){
        const k=[x.name,x.server,x.place,x.east,x.south,x.shop,x.price,x.currency,x.quantity].join("|");
        map.set(k,x);
      }
      items=[...map.values()].sort((a,b)=>a.price-b.price);

      return cors(json({
        query:q,
        source:"original StarCG keyword search",
        search_field:form.field,
        method:form.method,
        result_pages:pages,
        count:items.length,
        items
      }));
    }catch(err){
      return cors(json({error:String(err?.message||err)},502));
    }
  }
};

function cors(res){
  const h=new Headers(res.headers);
  h.set("Access-Control-Allow-Origin","*");
  h.set("Access-Control-Allow-Methods","GET,OPTIONS");
  h.set("Access-Control-Allow-Headers","Content-Type");
  return new Response(res.body,{status:res.status,headers:h});
}
function json(o,status=200){
  return new Response(JSON.stringify(o),{status,headers:{"content-type":"application/json; charset=utf-8"}});
}
async function fetchText(url,init={}){
  const r=await fetch(url,{...init,headers:{
    "User-Agent":"Mozilla/5.0 StarCG-Market-Compare/3.0",
    "Accept-Language":"zh-TW,zh;q=0.9",
    ...(init.headers||{})
  }});
  if(!r.ok) throw new Error(`StarCG HTTP ${r.status}`);
  return await r.text();
}
function attr(tag,name){
  const m=tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`,"i"));
  return m?(m[1]??m[2]??""):"";
}
function discoverSearchForm(html){
  // Find the input identified by the original placeholder.
  const im=html.match(/<input\b[^>]*placeholder\s*=\s*["'][^"']*搜尋名字[^"']*["'][^>]*>/i);
  if(!im) throw new Error("找不到 StarCG 原始搜尋欄位，原站可能已改版");
  const inputTag=im[0];
  const field=attr(inputTag,"name");
  if(!field) throw new Error("StarCG 搜尋欄位沒有 name");

  const idx=im.index;
  const before=html.slice(0,idx);
  const fs=before.lastIndexOf("<form");
  if(fs<0) throw new Error("找不到 StarCG 搜尋表單");
  const fe=html.indexOf(">",fs);
  const formTag=html.slice(fs,fe+1);
  const method=(attr(formTag,"method")||"GET").toUpperCase();
  const action=attr(formTag,"action")||"/market.php";

  // Preserve hidden fields from that form (up to the search input).
  const formClose=html.indexOf("</form>",fe);
  const formHtml=html.slice(fe+1,formClose>0?formClose:idx+4000);
  const hidden={};
  for(const m of formHtml.matchAll(/<input\b[^>]*type\s*=\s*["']hidden["'][^>]*>/gi)){
    const n=attr(m[0],"name"), v=attr(m[0],"value");
    if(n) hidden[n]=v;
  }
  return {field,method,action:new URL(action,ORIGIN).href,hidden};
}
async function submitOriginalSearch(form,q,server,type){
  const p=new URLSearchParams(form.hidden);
  p.set(form.field,q);
  // These are public filter names visible in StarCG market URLs.
  p.set("server",server);
  p.set("type",type);
  // Deliberately do not turn on 精確搜索: user wants keyword/partial match.
  p.delete("page");

  if(form.method==="POST"){
    const html=await fetchText(form.action,{
      method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},
      body:p.toString()
    });
    return {url:form.action,html};
  }else{
    const url=new URL(form.action);
    for(const [k,v] of p) url.searchParams.set(k,v);
    const final=url.href;
    return {url:final,html:await fetchText(final)};
  }
}
function decode(s){
  return s.replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">")
          .replace(/&quot;/gi,'"').replace(/&#0*39;/gi,"'").replace(/&#x27;/gi,"'");
}
function strip(html){
  return decode(html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"")
    .replace(/<br\s*\/?>/gi,"\n").replace(/<\/(?:div|p|li|tr|td|section|article|h\d)>/gi,"\n")
    .replace(/<[^>]+>/g," ").replace(/\r/g,""))
    .split("\n").map(x=>x.replace(/\s+/g," ").trim()).filter(Boolean);
}
function parseMarket(html){
  const lines=strip(html);
  const out=[];
  const stall=/\[(S[123])\]\s*(.*?)\s*\[\s*東\s*[:：]\s*(\d+)\s*南\s*[:：]\s*(\d+)\s*\]/;
  const price=/價格\s*[:：]\s*([\d,]+)\s*(金幣|魔晶)/;
  let cur=null,type="道具",name="";
  const bad=s=>!s||/^(搜尋|全部|道具攤位|寵物攤位|所有分流|上一頁|下一頁|金幣|魔晶)$/.test(s)||
    /價格|商店[:：]|攤位到期|販售道具|販售寵物/.test(s)||stall.test(s);

  for(let i=0;i<lines.length;i++){
    const line=lines[i], sm=line.match(stall);
    if(sm){
      cur={server:sm[1],place:sm[2].trim(),east:+sm[3],south:+sm[4],shop:"",expires:""};
      name=""; type="道具"; continue;
    }
    if(!cur) continue;
    if(line.includes("販售道具")){type="道具";name="";continue}
    if(line.includes("販售寵物")){type="寵物";name="";continue}
    if(/^商店\s*[:：]/.test(line)){cur.shop=line.replace(/^商店\s*[:：]\s*/,"");continue}
    if(/^攤位到期時間\s*[:：]/.test(line)){cur.expires=line.replace(/^攤位到期時間\s*[:：]\s*/,"");continue}

    const pm=line.match(price);
    if(pm){
      let n=name;
      if(!n) for(let k=i-1;k>=Math.max(0,i-6);k--) if(!bad(lines[k])){n=lines[k];break}
      if(!n) continue;
      let quantity=1;
      const qm=n.match(/\s*[xX×]\s*(\d+)\s*$/);
      if(qm){quantity=Math.max(1,+qm[1]);n=n.replace(/\s*[xX×]\s*\d+\s*$/,"").trim()}
      const p=+pm[1].replace(/,/g,"");
      out.push({...cur,name:n,type,quantity,price:p,unit_price:p/quantity,currency:pm[2]});
      continue;
    }
    if(!bad(line) && line.length<=100) name=line;
  }
  return out;
}
function findNextHref(html){
  for(const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)){
    const text=strip(m[2]).join(" ");
    if(text.includes("下一頁")){
      const href=attr(m[0],"href");
      if(href && href!=="#" && !/^javascript:/i.test(href)) return decode(href);
    }
  }
  return null;
}
