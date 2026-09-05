const WEB_APP_ID='936619743392459';
const ASBD_ID='198387';
const USER_RE=/^[A-Za-z0-9._]{1,30}$/;
const UA='Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1';

function normalizeUsername(raw){
  let v=String(raw||'').trim();
  if(!v) throw new Error('username が必要です。');
  if(v.startsWith('@')) v=v.slice(1);
  if(/^https?:\/\//i.test(v)||/^(?:www\.)?instagram\.com\//i.test(v)){
    const u=new URL(/^https?:\/\//i.test(v)?v:`https://${v}`);
    if(!['instagram.com','www.instagram.com'].includes(u.hostname.toLowerCase())) throw new Error('instagram.com の公開プロフィールだけ指定できます。');
    const p=u.pathname.split('/').filter(Boolean);
    if(p.length!==1) throw new Error('Story診断はプロフィールURLだけ指定できます。');
    v=p[0];
  }
  if(!USER_RE.test(v)) throw new Error('有効なInstagramユーザー名を指定してください。');
  return v;
}

function headerValue(v){return Array.isArray(v)?v[0]||'':String(v||'');}
function safeMessage(p){const v=p?.message||p?.error_message||p?.error_type||p?.status;return typeof v==='string'?v.slice(0,240):null;}
function authConfig(){
  const sessionid=String(process.env.INSTAGRAM_SESSIONID||'').trim();
  const csrftoken=String(process.env.INSTAGRAM_CSRFTOKEN||'').trim();
  const dsUserId=String(process.env.INSTAGRAM_DS_USER_ID||'').trim();
  const rur=String(process.env.INSTAGRAM_RUR||'').trim();
  const parts=[];
  if(sessionid)parts.push(`sessionid=${sessionid}`);
  if(csrftoken)parts.push(`csrftoken=${csrftoken}`);
  if(dsUserId)parts.push(`ds_user_id=${dsUserId}`);
  if(rur)parts.push(`rur=${rur}`);
  return{sessionid,csrftoken,dsUserId,cookie:parts.join('; ')};
}
function storyHeaders(username,a){
  const h={Accept:'application/json, text/plain, */*','Accept-Language':'ja,en-US;q=0.8,en;q=0.7','User-Agent':UA,'X-IG-App-ID':WEB_APP_ID,'X-ASBD-ID':String(process.env.INSTAGRAM_ASBD_ID||ASBD_ID),'X-Requested-With':'XMLHttpRequest',Referer:`https://www.instagram.com/${encodeURIComponent(username)}/`,Cookie:a.cookie};
  if(a.csrftoken)h['X-CSRFToken']=a.csrftoken;
  return h;
}

async function fetchEmbed(username,attempts){
  const url=`https://www.instagram.com/${encodeURIComponent(username)}/embed/`;
  const t=Date.now();
  try{
    const r=await fetch(url,{redirect:'follow',headers:{Accept:'text/html,application/xhtml+xml','Accept-Language':'ja,en-US;q=0.8,en;q=0.7','User-Agent':UA},signal:AbortSignal.timeout(10000)});
    const html=await r.text();
    attempts.push({name:'profile_embed_html',kind:'html',status:r.status,ok:r.ok,durationMs:Date.now()-t,bodyLength:html.length,contentType:r.headers.get('content-type')||null,containsUsername:html.toLowerCase().includes(username.toLowerCase()),containsGraphqlMedia:/graphql_media/i.test(html)});
    return{response:r,html,url};
  }catch(e){attempts.push({name:'profile_embed_html',kind:'html',status:'ERROR',ok:false,durationMs:Date.now()-t,error:e?.message||String(e)});return{response:null,html:'',url};}
}

function decode(s){return String(s||'').replace(/\\\\/g,'\\').replace(/\\"/g,'"').replace(/\\\//g,'/').replace(/\\u0022/gi,'"').replace(/\\u0026/gi,'&').replace(/\\u002f/gi,'/').replace(/&quot;|&#34;/gi,'"').replace(/&amp;/gi,'&');}
function variants(html){const out=[];let v=String(html||'');for(let i=0;i<5;i++){if(!out.includes(v))out.push(v);v=decode(v);}return out;}
function balanced(text,start){let depth=0,q='',str=false,esc=false;for(let i=start;i<text.length;i++){const c=text[i];if(str){if(esc){esc=false;continue;}if(c==='\\'){esc=true;continue;}if(c===q){str=false;q='';}continue;}if(c==='"'||c==="'"){str=true;q=c;continue;}if(c==='{')depth++;else if(c==='}'&&--depth===0)return text.slice(start,i+1);}return null;}

function extractUserId(html,username){
  const hits=[];
  const wanted=username.toLowerCase();
  const add=(id,method)=>{id=String(id||'');if(/^\d{5,30}$/.test(id)&&!hits.some(x=>x.id===id&&x.method===method))hits.push({id,method});};
  for(const input of variants(html)){
    const marker=/["'](?:owner|user|profile_user|profileUser)["']\s*:\s*\{/gi;
    let m;
    while((m=marker.exec(input))){
      const start=input.indexOf('{',m.index),raw=start>=0?balanced(input,start):null;
      if(!raw)continue;
      try{
        const o=JSON.parse(raw),u=String(o?.username||o?.user_name||'').toLowerCase(),id=o?.id??o?.pk??o?.pk_id;
        if(u===wanted)add(id,'named_object_json');
      }catch{
        const um=raw.match(/["'](?:username|user_name)["']\s*:\s*["']([^"']+)["']/i);
        const im=raw.match(/["'](?:id|pk|pk_id)["']\s*:\s*["']?(\d{5,30})["']?/i);
        if(um?.[1]?.toLowerCase()===wanted)add(im?.[1],'named_object_regex');
      }
    }
    const esc=username.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const up=new RegExp(`["']username["']\\s*:\\s*["']${esc}["']`,'gi');
    while((m=up.exec(input))){
      const w=input.slice(Math.max(0,m.index-260),Math.min(input.length,m.index+360));
      const ids=[...w.matchAll(/["'](?:id|pk|pk_id)["']\s*:\s*["']?(\d{5,30})["']?/gi)].map(x=>x[1]);
      if(ids.length===1)add(ids[0],'username_window_unique_id');
    }
  }
  const grouped=new Map();
  for(const h of hits){const g=grouped.get(h.id)||{id:h.id,methods:[]};if(!g.methods.includes(h.method))g.methods.push(h.method);grouped.set(h.id,g);}
  const list=[...grouped.values()].sort((a,b)=>b.methods.length-a.methods.length);
  const selected=list[0]||null;
  return{id:selected?.id||null,method:selected?.methods?.join('+')||null,candidateCount:list.length,candidates:list.slice(0,12)};
}

async function fetchStoryOnce(username,userId,headers,attempts){
  const url=`https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`;
  const t=Date.now();
  try{
    const r=await fetch(url,{redirect:'follow',headers,signal:AbortSignal.timeout(10000)}),text=await r.text();
    let p=null;try{p=text?JSON.parse(text):{};}catch{}
    attempts.push({name:'stories_www_reel_ids_once',kind:'api',status:r.status,ok:r.ok,durationMs:Date.now()-t,bodyLength:text.length,contentType:r.headers.get('content-type')||null,payloadKeys:p&&typeof p==='object'?Object.keys(p).slice(0,30):[],upstreamMessage:safeMessage(p)});
    return{response:r,payload:p};
  }catch(e){attempts.push({name:'stories_www_reel_ids_once',kind:'api',status:'ERROR',ok:false,durationMs:Date.now()-t,error:e?.message||String(e)});return{response:null,payload:null};}
}

function storyContainer(p,id){
  if(!p||typeof p!=='object')return null;
  if(p.reels&&typeof p.reels==='object'&&!Array.isArray(p.reels))return p.reels[id]||Object.values(p.reels).find(Boolean)||null;
  if(Array.isArray(p.reels_media))return p.reels_media.find(x=>String(x?.id??x?.user?.pk??'')===String(id))||p.reels_media[0]||null;
  if(Array.isArray(p.reels))return p.reels.find(x=>String(x?.id??x?.user?.pk??'')===String(id))||p.reels[0]||null;
  return null;
}
function bestImage(i){const c=[...(i?.image_versions2?.candidates||[]),...(i?.image_versions?.candidates||[])].filter(x=>x?.url).sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0));return c[0]?.url||null;}
function bestVideo(i){const c=[...(i?.video_versions||[])].filter(x=>x?.url).sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0));return c[0]?.url||null;}
function iso(v){const n=Number(v||0);return Number.isFinite(n)&&n>0?new Date(n*1000).toISOString():null;}
function mapStory(i,index){const videoUrl=bestVideo(i),imageUrl=bestImage(i);return{index,id:String(i?.pk??i?.id??''),code:i?.code||null,type:Number(i?.media_type)===2||videoUrl?'video':imageUrl?'image':'unknown',takenAt:iso(i?.taken_at),expiringAt:iso(i?.expiring_at),width:Number(i?.original_width||i?.image_versions2?.candidates?.[0]?.width||0)||null,height:Number(i?.original_height||i?.image_versions2?.candidates?.[0]?.height||0)||null,imageUrl,videoUrl,hasAudio:typeof i?.has_audio==='boolean'?i.has_audio:null};}
function fail(res,status,error,extra={}){res.status(status).json({ok:false,error,...extra});}

export default async function handler(req,res){
  res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('Pragma','no-cache');
  if(req.method!=='GET')return fail(res,405,'GETのみ対応しています。');
  const configuredKey=String(process.env.STORY_DIAGNOSTIC_KEY||'');
  if(!configuredKey)return fail(res,503,'STORY_DIAGNOSTIC_KEY が未設定です。Vercel Environment Variablesに設定してください。',{setupRequired:true});
  if(headerValue(req.headers?.['x-story-diagnostic-key'])!==configuredKey)return fail(res,401,'Story診断キーが一致しません。');
  let username;try{username=normalizeUsername(req.query?.username);}catch(e){return fail(res,400,e.message);}
  const auth=authConfig();
  if(!auth.sessionid)return fail(res,503,'INSTAGRAM_SESSIONID が未設定です。Vercel Environment Variablesにログイン済みセッションを設定してください。',{setupRequired:true});

  const attempts=[];
  const embed=await fetchEmbed(username,attempts);
  if(!embed.response?.ok||!embed.html)return fail(res,502,'公開プロフィールEmbed HTMLを取得できませんでした。Story APIは実行していません。',{username,diagnostic:'instagram_story_embed_id_probe_v2',storyApiExecuted:false,attempts});

  const probe=extractUserId(embed.html,username);
  if(!probe.id)return fail(res,422,'Embed HTMLからInstagramユーザーIDを抽出できませんでした。Story APIは実行していません。',{username,diagnostic:'instagram_story_embed_id_probe_v2',storyApiExecuted:false,embedProbe:{iframeUrl:embed.url,htmlLength:embed.html.length,...probe},attempts});

  const user={id:probe.id,username};
  const story=await fetchStoryOnce(username,user.id,storyHeaders(username,auth),attempts);
  if(!story.response?.ok||!story.payload)return fail(res,502,'Embed HTMLからユーザーIDは取得できましたが、1回だけ実行したStory APIが失敗しました。',{username,diagnostic:'instagram_story_embed_id_probe_v2',user,userResolveSource:`embed_html:${probe.method}`,storyApiExecuted:true,storyApiCallCount:1,embedProbe:{iframeUrl:embed.url,htmlLength:embed.html.length,...probe},attempts});

  const container=storyContainer(story.payload,user.id),keys=Object.keys(story.payload||{}).sort().slice(0,80);
  if(!container&&story.payload?.status!=='ok'&&!keys.includes('reels')&&!keys.includes('reels_media'))return fail(res,502,'Story APIはHTTP成功しましたが、Storyレスポンスとして解釈できませんでした。',{username,user,storyApiExecuted:true,storyApiCallCount:1,attempts});
  const items=Array.isArray(container?.items)?container.items:[],stories=items.slice(0,50).map(mapStory);
  return res.status(200).json({ok:true,diagnostic:'instagram_story_embed_id_probe_v2',checkedAt:new Date().toISOString(),username,user,userResolveSource:`embed_html:${probe.method}`,storyApiExecuted:true,storyApiCallCount:1,storySource:'stories_www_reel_ids_once',activeStory:stories.length>0,storyCount:stories.length,stories,embedProbe:{iframeUrl:embed.url,htmlLength:embed.html.length,...probe},shape:{payloadKeys:keys,containerKeys:container?Object.keys(container).sort().slice(0,80):[]},authConfigured:{sessionid:true,csrftoken:Boolean(auth.csrftoken),dsUserId:Boolean(auth.dsUserId)},notes:['ID解決では web_profile_info / username feed API を使用していません。','公開プロフィール /username/embed/ HTMLからIDを抽出できた場合だけStory APIを1回実行します。'],attempts});
}
