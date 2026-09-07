console.log("[VRM Manager] starting");

import type * as AstraSDK from "astra-plugin-sdk";
const { plugin, tool, s } = require("astra-plugin-sdk") as typeof AstraSDK;
import { promises as fs } from "node:fs";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const ROOT = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Astra", "VRMManager");
const LIB = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "astra", "astra", "config", "companion", "pack", "models");
const ACC = join(ROOT, "accessories");
const STATE = join(ROOT, "state.json");
const API = "https://hub.vroid.com";
const API_VERSION = "11";
interface State { accessToken?:string; refreshToken?:string; expiresAt?:number; user?:{id:string;name:string;icon?:string}; clientId?:string; clientSecret?:string; redirectUri?:string; scope?:string; favorites?:string[]; recent?:string[]; recentMeta?:Record<string,{preview?:string;sourceId?:string;sourceName?:string}> }
let oauthState="";
let oauthServer: ReturnType<typeof createServer> | null = null;
let state:State={};
async function ensure(){await fs.mkdir(LIB,{recursive:true});await fs.mkdir(ACC,{recursive:true});try{state=JSON.parse(await fs.readFile(STATE,"utf8"));}catch{state={};}}
async function saveState(){await fs.mkdir(ROOT,{recursive:true});await fs.writeFile(STATE,JSON.stringify(state,null,2));}
function ps(command:string){return new Promise<string>((resolve,reject)=>{const p=spawn("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-Command",command],{windowsHide:true});let o="",e="";p.stdout.on("data",d=>o+=d);p.stderr.on("data",d=>e+=d);p.on("close",c=>c===0?resolve(o.trim()):reject(new Error(e||`PowerShell exit ${c}`)));});}
async function openUrl(url:string){await ps(`Start-Process -FilePath ${JSON.stringify(url)}`);}
function authHeaders(){return {"X-Api-Version":API_VERSION,"Authorization":`Bearer ${state.accessToken}`};}
async function refreshAccessToken(){
 if(!state.refreshToken||!state.clientId||!state.clientSecret) return false;
 const body=new URLSearchParams({client_id:state.clientId,client_secret:state.clientSecret,grant_type:"refresh_token",refresh_token:state.refreshToken});
 const r=await fetch(API+"/oauth/token",{method:"POST",headers:{"X-Api-Version":API_VERSION,"Content-Type":"application/x-www-form-urlencoded"},body});
 const text=await r.text();
 if(!r.ok){state.accessToken=undefined;state.refreshToken=undefined;state.expiresAt=undefined;state.user=undefined;await saveState();return false;}
 const token=JSON.parse(text);state.accessToken=token.access_token;state.refreshToken=token.refresh_token||state.refreshToken;state.expiresAt=Date.now()+Math.max(60,Number(token.expires_in||3600)-120)*1000;await saveState();return true;
}
async function ensureAuth(){
 if(!state.accessToken && state.refreshToken) await refreshAccessToken();
 if(state.accessToken && state.expiresAt && Date.now()>=state.expiresAt) await refreshAccessToken();
 return Boolean(state.accessToken);
}
async function api(path:string,init:RequestInit={}){
 await ensureAuth();
 const doFetch=()=>fetch(API+path,{...init,headers:{...authHeaders(),...(init.headers||{})}});
 let r=await doFetch();
 if(r.status===401 && state.refreshToken){if(await refreshAccessToken()) r=await doFetch();}
 const text=await r.text();if(!r.ok)throw new Error(`VRoid Hub ${r.status}: ${text.slice(0,500)}`);return text?JSON.parse(text):{};
}
function b64url(b:Buffer){return b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");}
async function beginOAuth(clientId:string,redirectUri:string,scope:string){state.clientId=clientId;state.redirectUri=redirectUri;state.scope=scope;const verifier=b64url(randomBytes(48));const challenge=b64url(createHash("sha256").update(verifier).digest());oauthState=b64url(randomBytes(24));await fs.writeFile(join(ROOT,"oauth.json"),JSON.stringify({verifier,createdAt:Date.now()}));const u=new URL(API+"/oauth/authorize");u.searchParams.set("response_type","code");u.searchParams.set("client_id",clientId);u.searchParams.set("redirect_uri",redirectUri);u.searchParams.set("scope",scope);u.searchParams.set("state",oauthState);u.searchParams.set("code_challenge",challenge);u.searchParams.set("code_challenge_method","S256");await openUrl(u.toString());return u.toString();}
async function startOAuthCallback(){
 const port=32198;
 if(oauthServer)return;
 oauthServer=createServer(async(req,res)=>{
  try{
   const u=new URL(req.url||"/",`http://127.0.0.1:${port}`);
   if(u.pathname!=="/oauth/callback"){res.writeHead(404);res.end();return;}
   const code=u.searchParams.get("code")||"";
   const gotState=u.searchParams.get("state")||"";
   if(!code||!oauthState||gotState!==oauthState)throw new Error("OAuth state mismatch");
   const raw=JSON.parse(await fs.readFile(join(ROOT,"oauth.json"),"utf8"));
   const body=new URLSearchParams({client_id:state.clientId||"",client_secret:state.clientSecret||"",redirect_uri:state.redirectUri||`http://127.0.0.1:${port}/oauth/callback`,grant_type:"authorization_code",code,code_verifier:raw.verifier});
   const tokenRes=await fetch(API+"/oauth/token",{method:"POST",headers:{"X-Api-Version":API_VERSION,"Content-Type":"application/x-www-form-urlencoded"},body});
   const tokenText=await tokenRes.text();
   if(!tokenRes.ok)throw new Error(`Token exchange ${tokenRes.status}: ${tokenText.slice(0,400)}`);
   const token=JSON.parse(tokenText);
   state.accessToken=token.access_token; state.refreshToken=token.refresh_token; state.expiresAt=Date.now()+Math.max(60,Number(token.expires_in||3600)-120)*1000;
   const profile=await api("/api/account");
   const udata=profile?.data?.user_detail?.user;
   state.user=udata?{id:udata.id,name:udata.name,icon:udata.icon?.sq170?.url}:undefined;
   await saveState();
   res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
   res.end(`<html><body style="font-family:Segoe UI;background:#10131b;color:white;padding:40px"><h2>VRM Manager</h2><p>Вход в VRoid Hub выполнен. Можно закрыть это окно.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`);
  }catch(e){
   res.writeHead(400,{"Content-Type":"text/html; charset=utf-8"});
   res.end(`<h3>VRM Manager: ошибка входа</h3><pre>${String(e).replace(/[<>&]/g,"_")}</pre>`);
  }
 });
 await new Promise<void>((resolve,reject)=>oauthServer!.listen(port,"127.0.0.1",()=>resolve()));
}
async function extractThumbnail(filePath:string){
 try{
  const {json,bin}=parseGlb(await fs.readFile(filePath));
  const meta=json.extensions?.VRMC_vrm?.meta || json.extensions?.VRM?.meta || null;
  let imageIndex:number|undefined=meta?.thumbnailImage;
  if(imageIndex===undefined && meta?.texture!==undefined){
   const tex=json.textures?.[meta.texture]; imageIndex=tex?.source;
  }
  const im=imageIndex!==undefined?json.images?.[imageIndex]:null;
  if(!im || !bin || im.bufferView===undefined) return null;
  const bv=json.bufferViews?.[im.bufferView]; if(!bv) return null;
  const start=Number(bv.byteOffset||0), end=start+Number(bv.byteLength||0);
  const data=bin.subarray(start,end);
  if(!data.length || data.length>4*1024*1024) return null;
  const mime=im.mimeType || (data[0]===0x89&&data[1]===0x50?'image/png':data[0]===0xff&&data[1]===0xd8?'image/jpeg':null);
  return mime?`data:${mime};base64,${data.toString('base64')}`:null;
 }catch{return null;}
}
async function walkVrmFiles(dir:string):Promise<string[]>{
 const out:string[]=[];
 try{
  for(const e of await fs.readdir(dir,{withFileTypes:true})){
   const p=join(dir,e.name);
   if(e.isDirectory()){out.push(...await walkVrmFiles(p));}
   else if(extname(e.name).toLowerCase()===".vrm") out.push(p);
  }
 }catch{}
 return out;
}
async function listModels(){
 const paths=await walkVrmFiles(LIB);
 const result=await Promise.all(paths.map(async path=>{
  const st=await fs.stat(path);
  let preview=state.recentMeta?.[path]?.preview;
  if(!preview){
   preview=await extractThumbnail(path)||undefined;
   state.recentMeta=state.recentMeta||{};
   state.recentMeta[path]={...(state.recentMeta[path]||{}),preview};
  }
  return{name:basename(path),path,size:st.size,modified:st.mtime.toISOString(),preview};
 }));
 await saveState();
 return result;
}

function parseGlb(buf:Buffer){if(buf.toString("ascii",0,4)!=="glTF")throw new Error("Файл не похож на GLB/VRM");const length=buf.readUInt32LE(8);let off=12,json:any=null,bin:Buffer|null=null;while(off+8<=Math.min(length,buf.length)){const len=buf.readUInt32LE(off),type=buf.readUInt32LE(off+4),chunk=buf.subarray(off+8,off+8+len);if(type===0x4E4F534A)json=JSON.parse(chunk.toString("utf8").replace(/\u0000+$/g," ").trim());if(type===0x004E4942)bin=chunk;off+=8+len;}if(!json)throw new Error("В GLB отсутствует JSON chunk");return{json,bin};}
function buildGlb(json:any,bin:Buffer|null){const j=Buffer.from(JSON.stringify(json));const jp=Buffer.concat([j,Buffer.alloc((4-j.length%4)%4,0x20)]);const b=bin?Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)]):Buffer.alloc(0);const total=12+8+jp.length+(b.length?8+b.length:0);const out=Buffer.alloc(total);out.write("glTF",0);out.writeUInt32LE(2,4);out.writeUInt32LE(total,8);let o=12;out.writeUInt32LE(jp.length,o);out.writeUInt32LE(0x4E4F534A,o+4);jp.copy(out,o+8);o+=8+jp.length;if(b.length){out.writeUInt32LE(b.length,o);out.writeUInt32LE(0x004E4942,o+4);b.copy(out,o+8);}return out;}
function nodeLabel(n:any,i:number){return n.name||`Объект ${i+1}`;}
function classifyNode(name:string, meshName:string=''){
 const x=(name+' '+meshName).toLowerCase().replace(/[_\-.]+/g,' ');
 const has=(...w:string[])=>w.some(k=>x.includes(k));
 if(has('head','skull','face','eye','mouth','nose','ear','jaw','facial')) return 'Лицо / голова';
 if(has('hair','bang','ponytail','髪')) return 'Волосы';
 if(has('shirt','top','jacket','coat','hoodie','sweater','blouse','dress','onepiece','uniform','upper','chest','torso','clothes','cloth')) return 'Верхняя одежда';
 if(has('pants','skirt','shorts','bottom','trousers','waist','lower')) return 'Нижняя одежда';
 if(has('shoe','boot','sandal','foot','sock')) return 'Обувь';
 if(has('hand','arm','glove','wrist')) return 'Руки';
 if(has('leg','thigh','knee','calf')) return 'Ноги';
 if(has('body','skin','bodymesh','body mesh')) return 'Тело';
 if(has('accessory','glasses','hat','cap','horn','wing','tail','ribbon','jewel','necklace','earring','bag','weapon','helmet')) return 'Аксессуар';
 if(has('bone','joint','hips','spine','shoulder','neck')) return 'Скелет / кость';
 return 'Прочее';
}
function classifyNodes(json:any){
 const nodes=Array.isArray(json.nodes)?json.nodes:[]; const meshes=Array.isArray(json.meshes)?json.meshes:[];
 return nodes.map((n:any,i:number)=>({index:i,name:nodeLabel(n,i),category:classifyNode(n.name||'',n.mesh!=null&&meshes[n.mesh]?meshes[n.mesh].name||'':''),mesh:n.mesh??null,type:n.mesh!=null?'mesh':'node',children:n.children||[],scale:n.scale||[1,1,1],hidden:n.extras?.astraHidden===true}));
}
async function inspectModel(filePath:string){const buf=await fs.readFile(filePath);const {json}=parseGlb(buf);return{path:filePath,name:basename(filePath),nodes:classifyNodes(json),meshes:(json.meshes||[]).map((m:any,i:number)=>({index:i,name:m.name||`Mesh ${i+1}`,primitives:(m.primitives||[]).length})),extensions:Object.keys(json.extensionsUsed||{}),categories:[...new Set(classifyNodes(json).map((n:any)=>n.category))]};}
async function setNodeVisible(filePath:string,index:number,visible:boolean){const buf=await fs.readFile(filePath);const p=parseGlb(buf);if(!p.json.nodes?.[index])throw new Error("Объект не найден");p.json.nodes[index].scale=visible?[1,1,1]:[0,0,0];p.json.nodes[index].extras={...(p.json.nodes[index].extras||{}),astraHidden:!visible};const out=filePath.replace(/\.vrm$/i,".edited.vrm");await fs.writeFile(out,buildGlb(p.json,p.bin));return out;}

async function listAccessories(){const files=await fs.readdir(ACC);return Promise.all(files.filter(f=>['.glb','.vrm'].includes(extname(f).toLowerCase())).map(async f=>{const st=await fs.stat(join(ACC,f));return{name:f,path:join(ACC,f),size:st.size,modified:st.mtime.toISOString()};}));}
async function mergeAccessory(modelPath:string, accessoryPath:string, boneIndex:number){
 const base=parseGlb(await fs.readFile(modelPath));
 const acc=parseGlb(await fs.readFile(accessoryPath));
 if(!acc.json.meshes?.length) throw new Error('Аксессуар не содержит mesh. Нужен GLB/VRM с геометрией.');
 if(!base.json.nodes?.[boneIndex]) throw new Error('Кость/узел не найден.');
 const b=base.json, a=acc.json;
 const arr=(x:any,k:string)=>Array.isArray(x?.[k])?x[k]:[];
 const baseBin=base.bin||Buffer.alloc(0), accBin=acc.bin||Buffer.alloc(0);
 const pad=(n:number)=> (4-n%4)%4;
 const binOffset=baseBin.length+pad(baseBin.length);
 const mergedBin=Buffer.concat([baseBin,Buffer.alloc(pad(baseBin.length)),accBin]);
 const bvs=arr(a,'bufferViews'); const accs=arr(a,'accessors'); const meshes=arr(a,'meshes'); const mats=arr(a,'materials'); const tex=arr(a,'textures'); const imgs=arr(a,'images'); const sam=arr(a,'samplers'); const nodes=arr(a,'nodes'); const skins=arr(a,'skins'); const anims=arr(a,'animations');
 const bvBase=arr(b,'bufferViews').length, accBase=arr(b,'accessors').length, meshBase=arr(b,'meshes').length, matBase=arr(b,'materials').length, texBase=arr(b,'textures').length, imgBase=arr(b,'images').length, samBase=arr(b,'samplers').length, nodeBase=arr(b,'nodes').length, skinBase=arr(b,'skins').length;
 for(const v of bvs){ if(v.buffer===undefined)v.buffer=0; v.buffer=0; v.byteOffset=(v.byteOffset||0)+binOffset; }
 for(const x of accs){ if(x.bufferView!==undefined)x.bufferView+=bvBase; }
 for(const m of meshes){ for(const pr of (m.primitives||[])){ if(pr.indices!==undefined)pr.indices+=accBase; if(pr.attributes)for(const k of Object.keys(pr.attributes))pr.attributes[k]+=accBase; if(pr.targets)for(const t of pr.targets)for(const k of Object.keys(t))t[k]+=accBase; if(pr.material!==undefined)pr.material+=matBase; } }
 for(const im of imgs){ if(im.bufferView!==undefined)im.bufferView+=bvBase; }
 for(const t of tex){ if(t.sampler!==undefined)t.sampler+=samBase; if(t.source!==undefined)t.source+=imgBase; }
 for(const sk of skins){ if(sk.inverseBindMatrices!==undefined)sk.inverseBindMatrices+=accBase; if(sk.skeleton!==undefined)sk.skeleton+=nodeBase; if(sk.joints)sk.joints=sk.joints.map((i:number)=>i+nodeBase); }
 for(const n of nodes){ if(n.mesh!==undefined)n.mesh+=meshBase; if(n.skin!==undefined)n.skin+=skinBase; if(n.children)n.children=n.children.map((i:number)=>i+nodeBase); }
 for(const an of anims){ for(const ch of (an.channels||[])){ if(ch.target?.node!==undefined)ch.target.node+=nodeBase; } }
 if(imgs.some((im:any)=>typeof im.uri==='string' && !im.uri.startsWith('data:'))) throw new Error('Аксессуар содержит внешние изображения. Экспортируй его как GLB с встроенными текстурами.');
 const roots:number[]=[];
 const scene=a.scenes?.[a.scene||0];
 if(scene?.nodes?.length) roots.push(...scene.nodes.map((i:number)=>i+nodeBase)); else nodes.forEach((n:any,i:number)=>{ if(!nodes.some((q:any)=>q.children?.includes(i))) roots.push(i+nodeBase); });
 const bone=b.nodes[boneIndex];
 bone.children=[...(bone.children||[]),...roots];
 b.bufferViews=[...arr(b,'bufferViews'),...bvs];
 b.accessors=[...arr(b,'accessors'),...accs];
 b.samplers=[...arr(b,'samplers'),...sam];
 b.images=[...arr(b,'images'),...imgs];
 b.textures=[...arr(b,'textures'),...tex];
 b.materials=[...arr(b,'materials'),...mats];
 b.meshes=[...arr(b,'meshes'),...meshes];
 b.nodes=[...arr(b,'nodes'),...nodes];
 if(skins.length)b.skins=[...arr(b,'skins'),...skins];
 if(anims.length)b.animations=[...arr(b,'animations'),...anims];
 b.scenes=arr(b,'scenes'); if(!b.scenes.length)b.scenes=[{nodes:[]}];
 b.buffers=[{byteLength:mergedBin.length}];
 const out=modelPath.replace(/\.vrm$/i,'.with-accessories.vrm'); await fs.writeFile(out,buildGlb(b,mergedBin)); return out;
}
async function getModelData(path:string){
 const buf=await fs.readFile(path);
 if(buf.length>120*1024*1024) throw new Error("Модель слишком большая для встроенного предпросмотра (>120 МБ).");
 return {name:basename(path),base64:buf.toString("base64")};
}
async function importAccessory(path:string){const ext=extname(path).toLowerCase();if(!['.glb','.vrm'].includes(ext))throw new Error('Поддерживаются GLB и VRM.');const dst=join(ACC,basename(path));await fs.copyFile(path,dst);return{path:dst};}

async function searchAccessories(keyword:string){
 if(!await ensureAuth()) throw new Error('Сначала подключите VRoid Hub.');
 const q=new URLSearchParams({keyword:keyword.trim(),count:'50',sort:'_score',has_booth_items:'true'});
 q.append('booth_part_categories[]','accessory');
 const result=await api(`/api/search/character_models?${q.toString()}`);
 const models=Array.isArray(result?.data)?result.data:[];
 const items:any[]=[]; const seen=new Set<string>();
 for(const m of models){
   for(const x of (m.character_model_booth_items||[])){
     const id=String(x.booth_item_id||''); if(!id||seen.has(id)) continue; seen.add(id);
     items.push({id,partCategory:x.part_category||'accessory',modelId:m.id,modelName:m.name||m.id,preview:m.portrait_image?.sq300?.url||m.portrait_image?.w300?.url||null,boothUrl:`https://booth.pm/items/${encodeURIComponent(id)}`});
   }
 }
 return {ok:true,data:items.slice(0,100),count:Math.min(items.length,100),modelsFound:models.length};
}
function base32Id(bytes:Buffer){
 const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits=""; for(const b of bytes) bits+=b.toString(2).padStart(8,"0"); let out=""; for(let i=0;i+5<=bits.length;i+=5) out+=alphabet[parseInt(bits.slice(i,i+5),2)]; return out;
}
async function findCompanionRoot(){
 const appdata=process.env.APPDATA||join(homedir(),"AppData","Roaming");
 const localappdata=process.env.LOCALAPPDATA||join(homedir(),"AppData","Local");
 const explicit=(process.env.ASTRA_COMPANION_DIR||"").trim();
 const candidates:string[]=[];
 const add=(p:string)=>{if(p&&!candidates.includes(p))candidates.push(p);};
 if(explicit)add(explicit);
 for(const root of [appdata,localappdata]){
  for(const name of ["astra","Astra"]){
   add(join(root,name,"astra","config","companion"));
   add(join(root,name,"config","companion"));
   add(join(root,name,"config","companion","pack"));
  }
 }
 const looksLikeCompanion=async(p:string)=>{
  try{
   const st=await fs.stat(p); if(!st.isDirectory())return false;
   const lib=join(p,"library.json"), models=join(p,"pack","models"), chars=join(p,"pack","characters");
   const [a,b,c]=await Promise.all([fs.stat(lib),fs.stat(models),fs.stat(chars)]);
   return a.isFile()&&b.isDirectory()&&c.isDirectory();
  }catch{return false;}
 };
 for(const p of candidates){if(await looksLikeCompanion(p))return p;}
 // Last resort: Astra has changed its config layout between builds. Search only inside
 // the user's Astra folders, with a small depth limit, and never scan the whole disk.
 const roots=[join(appdata,"astra"),join(appdata,"Astra"),join(localappdata,"astra"),join(localappdata,"Astra")];
 const queue:{p:string,d:number}[]=roots.map(p=>({p,d:0}));
 const seen=new Set<string>();
 while(queue.length){
  const {p,d}=queue.shift()!; const key=p.toLowerCase(); if(seen.has(key)||d>6)continue; seen.add(key);
  if(await looksLikeCompanion(p))return p;
  try{
   const entries=await fs.readdir(p,{withFileTypes:true});
   for(const e of entries){
    if(!e.isDirectory()||e.name.startsWith("."))continue;
    if(["node_modules","cache","caches","logs","temp","tmp"].includes(e.name.toLowerCase()))continue;
    queue.push({p:join(p,e.name),d:d+1});
   }
  }catch{}
 }
 throw new Error("Не найден каталог Astra Character Library. Плагин автоматически проверил стандартные каталоги AppData и Astra. Если Astra установлена в нестандартной конфигурации, задайте переменную ASTRA_COMPANION_DIR.");
}
async function atomicWrite(path:string,data:string){
 const tmp=path+`.vrm-manager-${process.pid}-${Date.now()}.tmp`;
 await fs.writeFile(tmp,data,"utf8");
 let last:any;
 for(let attempt=0;attempt<8;attempt++){
  try{await fs.rename(tmp,path);return;}catch(e){last=e;await new Promise(r=>setTimeout(r,150*(attempt+1)));}
 }
 try{await fs.rm(tmp,{force:true});}catch{}
 throw last||new Error("Не удалось обновить library.json.");
}
function cloneJson<T>(x:T):T{return JSON.parse(JSON.stringify(x));}
async function installToAstraLibrary(filePath:string){
 const src=String(filePath||"");
 if(!src)throw new Error("Не указан путь к VRM.");
 if(extname(src).toLowerCase()!==".vrm")throw new Error("В Character Library Astra можно импортировать только .vrm.");
 await fs.access(src);
 const companion=await findCompanionRoot();
 const modelsDir=join(companion,"pack","models");
 const charsDir=join(companion,"pack","characters");
 const libraryPath=join(companion,"library.json");
 await fs.mkdir(modelsDir,{recursive:true}); await fs.mkdir(charsDir,{recursive:true});
 let library:any={characters:[]};
 try{library=JSON.parse(await fs.readFile(libraryPath,"utf8"));}catch{}
 if(!library||typeof library!=="object"||Array.isArray(library))library={characters:[]};
 if(!Array.isArray(library.characters))library.characters=[];
 const sourceStat=await fs.stat(src);
 // Astra's imported VRM model IDs observed in the Character Library are uppercase base32-like names.
 let modelId=""; let modelDst="";
 for(let attempt=0;attempt<20;attempt++){
  modelId=base32Id(randomBytes(20)); modelDst=join(modelsDir,modelId+".vrm");
  try{await fs.access(modelDst);}catch{break;}
 }
 if(!modelId||!modelDst)throw new Error("Не удалось выбрать уникальное имя VRM-модели.");
 let charId=modelId.toLowerCase(); let charDir=join(charsDir,charId); let n=1;
 while(true){try{await fs.access(charDir);n++;charDir=join(charsDir,`${modelId.toLowerCase()}-${n}`);}catch{break;}}
 const charToml=join(charDir,"character.toml");
 // Keep the library schema Astra itself created: clone an existing VRM record and only replace identity/path fields.
 let template:any=null;
 for(const c of library.characters){if(c&&c.kind==="vrm"){template=cloneJson(c);break;}}
 if(!template){
  template={kind:"vrm",dir:charDir,model:{ref:`models/${modelId}.vrm`}};
 } else {
  template.dir=charDir;
  if(template.model&&typeof template.model==="object") template.model.ref=`models/${modelId}.vrm`;
  if(template.ref!==undefined) template.ref=`models/${modelId}.vrm`;
  if(template.model!==undefined && typeof template.model==="string") template.model=`models/${modelId}.vrm`;
  if(template.id!==undefined) template.id=charId;
  if(template.character_id!==undefined) template.character_id=charId;
  if(template.uuid!==undefined) template.uuid=modelId;
 }
 // character.toml is intentionally simple and matches Astra's own imported VRM structure.
 const toml=[
  "# This file is YOURS: edit it freely, or delete the character to remove it.",
  "# The body is REFERENCED through `model` below rather than copied.",
  "",
  "[character]",
  'kind = "vrm"',
  `model = "models/${modelId}.vrm"`,
  ""
 ].join("\\n");
 await fs.mkdir(charDir,{recursive:true});
 try{
  await fs.copyFile(src,modelDst);
  await fs.writeFile(charToml,toml,"utf8");
  library.characters.push(template);
  const backup=libraryPath+`.bak-${Date.now()}`;
  try{await fs.copyFile(libraryPath,backup);}catch{}
  await atomicWrite(libraryPath,JSON.stringify(library,null,2));
 }catch(e){
  try{await fs.rm(charDir,{recursive:true,force:true});}catch{}
  try{await fs.rm(modelDst,{force:true});}catch{}
  throw e;
 }
 // Give Astra/indexer a moment to observe the atomic library update.
 await new Promise(r=>setTimeout(r,700));
 return {ok:true,path:modelDst,characterDir:charDir,characterId:charId,modelId,sourceSize:sourceStat.size,message:`VRM добавлен в Character Library Astra. Найдено хранилище: ${companion}. Откройте библиотеку персонажей или перезапустите Astra, если список ещё не обновился.`};
}


const app=plugin({
 id:"denchik-vroid-manager",
 tools:{
  vrm_library:tool({description:"Показывает локальную библиотеку VRM.",input:s.object({}),run:async()=>JSON.stringify(await listModels())}),
  vrm_search:tool({description:"Ищет модели в VRoid Hub.",input:s.object({keyword:s.string({minLength:1}),downloadable:s.boolean().optional()}),run:async({keyword,downloadable})=>{if(!await ensureAuth())return"Не выполнен вход в VRoid Hub. Откройте VRoid Hub и выполните подключение.";const q=new URLSearchParams({keyword,count:"20",is_downloadable:String(downloadable??true)});return JSON.stringify(await api(`/api/search/character_models?${q}`));}}),
  vrm_model_info:tool({description:"Показывает состав VRM: nodes, meshes и extensions.",input:s.object({path:s.string()}),run:async({path})=>JSON.stringify(await inspectModel(path))}),
  vrm_hide_element:tool({description:"Создаёт копию VRM и скрывает node по индексу.",input:s.object({path:s.string(),nodeIndex:s.integer({minimum:0})}),run:async({path,nodeIndex})=>setNodeVisible(path,nodeIndex,false)}),
  vrm_show_element:tool({description:"Создаёт копию VRM и показывает node по индексу.",input:s.object({path:s.string(),nodeIndex:s.integer({minimum:0})}),run:async({path,nodeIndex})=>setNodeVisible(path,nodeIndex,true)}),
  vrm_accessories:tool({description:"Показывает локальные аксессуары GLB/VRM.",input:s.object({}),run:async()=>JSON.stringify(await listAccessories())}),
  vrm_accessory_search:tool({description:"Ищет на VRoid Hub модели, связанные с BOOTH-аксессуарами.",input:s.object({keyword:s.string({minLength:1})}),run:async({keyword})=>JSON.stringify(await searchAccessories(keyword))}),
  vrm_use_in_astra:tool({description:"Передаёт локальную VRM-модель Astra как активную модель и просит Astra использовать её.",input:s.object({path:s.string()}),run:async({path},ctx)=>{await ctx.setVariable("vrm.active_model",path,"session");try{const stream=ctx.sendChatMessage(`Используй VRM-модель из локального пути: ${path}. Если Astra поддерживает загрузку/смену VRM, загрузи именно этот файл и сделай его активным аватаром.`);for await(const _ of stream){break;}}catch{}return `Модель передана Astra: ${path}`;}})
 },
 ui:{contributions:[{id:"vroid-manager",slot:"page.custom",label:"VRM Manager",icon_svg:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="3"/><path d="M5 21c.8-4.2 3.2-6.3 7-6.3s6.2 2.1 7 6.3"/><path d="M4 4h16v16H4z"/></svg>',url:"index.html",width:0,height:0,transparent:true}],onCall:{
  getState:async()=>{await ensureAuth();return({loggedIn:Boolean(state.accessToken),user:state.user||null,clientConfigured:Boolean(state.clientId&&state.clientSecret),redirectUri:state.redirectUri||"http://127.0.0.1:32198/oauth/callback",recentMeta:state.recentMeta||{}});},
  listModels:async()=>listModels(),
  listAccessories:async()=>listAccessories(),
  searchAccessories:async(p:any)=>searchAccessories(String(p.keyword||"").trim()),
  getModelData:async(p:any)=>getModelData(p.path),
  importAccessory:async(p:any)=>importAccessory(p.path),
  attachAccessory:async(p:any)=>({path:await mergeAccessory(p.modelPath,p.accessoryPath,p.boneIndex)}),
  inspectModel:async(p:any)=>inspectModel(p.path),
  hideNode:async(p:any)=>({path:await setNodeVisible(p.path,p.nodeIndex,false)}),
  showNode:async(p:any)=>({path:await setNodeVisible(p.path,p.nodeIndex,true)}),
  openFile:async()=>{const script=`Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.OpenFileDialog; $d.Filter='VRM (*.vrm)|*.vrm|GLB (*.glb)|*.glb|All files (*.*)|*.*'; if($d.ShowDialog() -eq 'OK'){Write-Output $d.FileName}`;return{path:await ps(script)};},
  importFile:async(p:any)=>{const dst=join(LIB,basename(p.path));await fs.copyFile(p.path,dst);return{path:dst};},
  importToAstra:async(p:any,ctx:any)=>{return await installToAstraLibrary(String(p.path||""));},
  useInAstra:async(p:any,ctx:any)=>{const path=String(p.path||"");if(!path)throw new Error("Не указан путь к VRM.");await ctx.setVariable("vrm.active_model",path,"session");try{const stream=ctx.sendChatMessage(`Выбран VRM-файл для Astra: ${path}. Если в этой сборке Astra доступен инструмент смены VRM-аватара, используй именно этот файл.`);for await(const _ of stream){break;}}catch{}return{ok:true,message:`VRM выбран: ${basename(path)}`};},
  setClient:async(p:any)=>{state.clientId=p.clientId;state.clientSecret=p.clientSecret;state.redirectUri=p.redirectUri||"http://127.0.0.1:32198/oauth/callback";state.scope=p.scope||"default";await saveState();return{ok:true};},
  startLogin:async()=>{if(!state.clientId||!state.clientSecret)throw new Error("Сначала сохраните Client ID и Client Secret VRoid Hub в настройках.");if(!state.redirectUri)state.redirectUri="http://127.0.0.1:32198/oauth/callback";await startOAuthCallback();return{url:await beginOAuth(state.clientId,state.redirectUri,state.scope||"default")};},
  testConnection:async()=>{if(!await ensureAuth())return{ok:false,message:"Авторизация не выполнена или истекла."};const profile=await api("/api/account");const udata=profile?.data?.user_detail?.user||profile?.data?.user||null;if(udata)state.user={id:udata.id,name:udata.name,icon:udata.icon?.sq170?.url};await saveState();return{ok:true,user:state.user||null};},
  logout:async()=>{try{if(state.accessToken&&state.clientId&&state.clientSecret){await fetch(API+"/oauth/revoke",{method:"POST",headers:{"X-Api-Version":API_VERSION,"Content-Type":"application/x-www-form-urlencoded","Authorization":`Bearer ${state.accessToken}`},body:new URLSearchParams({client_id:state.clientId,client_secret:state.clientSecret,token:state.accessToken})});}}catch{} state.accessToken=undefined;state.refreshToken=undefined;state.expiresAt=undefined;state.user=undefined;await saveState();return{ok:true};},
  search:async(p:any)=>{
   if(!await ensureAuth()) throw new Error("Сначала подключите VRoid Hub. Откройте «Настройки» и выполните вход.");
   const keyword=String(p.keyword||"").trim();
   if(!keyword) throw new Error("Введите запрос для поиска.");
   const RU:any={
    "девушка":["girl","female","woman"],"девушки":["girl","female","woman"],"парень":["boy","male","man"],"мужчина":["man","male"],"женщина":["woman","female"],
    "волосы":["hair","hairstyle"],"прическа":["hair","hairstyle"],"одежда":["clothes","outfit","dress"],"платье":["dress"],"костюм":["suit","outfit"],
    "аксессуар":["accessory"],"аксессуары":["accessory"],"очки":["glasses"],"уши":["ears","animal ears"],"кошачьи уши":["cat ears"],"хвост":["tail"],"крылья":["wings"],"шлем":["helmet"],"меч":["sword"],
    "робот":["robot","android"],"киберпанк":["cyberpunk"],"аниме":["anime"],"фэнтези":["fantasy"],"воин":["warrior"],"маг":["mage","wizard"],"ведьма":["witch"],"вампир":["vampire"],
    "милый":["cute"],"красивый":["beautiful"],"готика":["gothic"],"готический":["gothic"],"школьница":["schoolgirl"],"школьник":["schoolboy"],
    "красный":["red"],"синий":["blue"],"голубой":["light blue","cyan"],"зеленый":["green"],"зелёный":["green"],"черный":["black"],"чёрный":["black"],"белый":["white"],"розовый":["pink"],"фиолетовый":["purple"],"желтый":["yellow"],"жёлтый":["yellow"],
    "кот":["cat"],"кошка":["cat"],"лиса":["fox"],"заяц":["rabbit"],"кролик":["rabbit"],"дракон":["dragon"]
   };
   const normalized=keyword.toLowerCase().replace(/ё/g,"е");
   const tokens=normalized.split(/\s+/).filter(Boolean);
   const variants:string[]=[]; const add=(x:string)=>{if(x&&!variants.includes(x))variants.push(x)};
   if(/^[a-z0-9\s_-]+$/i.test(keyword)) add(keyword);
   for(const token of tokens){ for(const v of (RU[token]||[])) add(v); }
   if(tokens.length>1){ const translated=tokens.flatMap((t:string)=>RU[t]||[]); if(translated.length) add(translated.join(" ")); }
   add(keyword);
   // VRoid Hub search is keyword-based, so for Russian queries run separate English synonyms too.
   const terms=variants.slice(0,10);
   const batches=await Promise.all(terms.map(async(term)=>{
     const q=new URLSearchParams(); q.set("keyword",term); q.set("count","50"); q.set("sort","_score");
     if(p.downloadable===true) q.set("is_downloadable","true");
     const result=await api(`/api/search/character_models?${q.toString()}`);
     return Array.isArray(result?.data)?result.data:[];
   }));
   const seen=new Set<string>(); const data:any[]=[];
   for(const batch of batches) for(const item of batch){const id=String(item.id||item.character_model_id||"");if(id&&!seen.has(id)){seen.add(id);data.push(item);}}
   return {ok:true,data:data.slice(0,100),count:Math.min(data.length,100),query:keyword,variants:terms};
  },
  modelDetail:async(p:any)=>api(`/api/character_models/${encodeURIComponent(p.id)}`),
  downloadModel:async(p:any)=>{if(!await ensureAuth())throw new Error("Сначала подключите VRoid Hub.");const lic=await api("/api/download_licenses",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({character_model_id:p.id})});const r=await fetch(`${API}/api/download_licenses/${lic.data.id}/download`,{headers:authHeaders(),redirect:"manual"});const loc=r.headers.get("location");if(!loc)throw new Error(`Не получена ссылка скачивания (${r.status})`);const file=await fetch(loc);if(!file.ok)throw new Error(`S3 download ${file.status}`);const arr=Buffer.from(await file.arrayBuffer());const safe=(p.name||`vroid-${p.id}`).replace(/[^a-zA-Z0-9а-яА-Я _.-]/g,"_");const path=join(LIB,`${safe}.vrm`);await fs.writeFile(path,arr);state.recent=[path,...(state.recent||[]).filter(x=>x!==path)].slice(0,50);state.recentMeta=state.recentMeta||{};state.recentMeta[path]={preview:p.preview||p.thumbnail||p.image||undefined,sourceId:String(p.id),sourceName:p.name||String(p.id)};await saveState();return{path,size:arr.length,preview:state.recentMeta[path].preview||null};}
 }},
 onStart:async()=>{await ensure();},
 healthCheck:()=>({healthy:true,status:"ok"})
});
export{app};

if(require.main===module)app.run();
