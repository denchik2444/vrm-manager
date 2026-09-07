let viewer={renderer:null,camera:null,scene:null,controls:null,vrm:null,raf:0};
function viewerStatus(t){const e=document.getElementById('viewerStatus');if(e)e.textContent=t;}
function viewerDispose(){if(viewer.raf)cancelAnimationFrame(viewer.raf);if(viewer.renderer){viewer.renderer.dispose();try{viewer.renderer.forceContextLoss()}catch{}}viewer={renderer:null,camera:null,scene:null,controls:null,vrm:null,raf:0};const el=document.getElementById('vrmViewer');if(el)el.querySelectorAll('canvas').forEach(x=>x.remove());}
async function load3DModules(){
  if(window.__vrm3dModules)return window.__vrm3dModules;
  viewerStatus('⏳ Загружаю 3D-библиотеки…');
  const modules=await Promise.all([
    import('https://esm.sh/three@0.184.0'),
    import('https://esm.sh/three@0.184.0/examples/jsm/controls/OrbitControls.js?deps=three@0.184.0&bundle=false'),
    import('https://esm.sh/three@0.184.0/examples/jsm/loaders/GLTFLoader.js?deps=three@0.184.0&bundle=false'),
    import('https://esm.sh/@pixiv/three-vrm@3.4.3?deps=three@0.184.0&bundle=false')
  ]);
  window.__vrm3dModules={THREE:modules[0],OC:modules[1],GLTF:modules[2],VRM:modules[3]};
  return window.__vrm3dModules;
}
window.refresh3D=async function(path){
 const el=document.getElementById('vrmViewer');if(!el)return;
 viewerDispose();viewerStatus('⏳ Запускаю 3D…');
 try{
  const {THREE,OC,GLTF,VRM}=await load3DModules();
  const d=await astra.callBackend('getModelData',{path});
  if(!d?.base64)throw new Error('Astra не вернула данные VRM-файла.');
  const bin=Uint8Array.from(atob(d.base64),c=>c.charCodeAt(0)).buffer;
  viewerStatus('⏳ Загружаю VRM…');
  const scene=new THREE.Scene();scene.background=new THREE.Color(0x0b0f17);
  const w=Math.max(1,el.clientWidth),h=Math.max(1,el.clientHeight);
  const camera=new THREE.PerspectiveCamera(30,w/h,.01,100);camera.position.set(0,1.35,3);
  const renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));renderer.setSize(w,h);renderer.outputColorSpace=THREE.SRGBColorSpace;el.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff,0x334466,2.2));const key=new THREE.DirectionalLight(0xffffff,2.5);key.position.set(2,3,4);scene.add(key);
  const controls=new OC.OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.minDistance=.6;controls.maxDistance=8;controls.target.set(0,1.1,0);
  const loader=new GLTF.GLTFLoader();loader.register(parser=>new VRM.VRMLoaderPlugin(parser));
  const gltf=await loader.parseAsync(bin,'');const vrm=gltf.userData.vrm;if(!vrm)throw new Error('В файле не найден VRM extension.');
  if(VRM.VRMUtils?.rotateVRM0)VRM.VRMUtils.rotateVRM0(vrm);scene.add(vrm.scene);
  const box=new THREE.Box3().setFromObject(vrm.scene),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
  vrm.scene.position.sub(center);vrm.scene.position.y+=size.y/2;
  const hh=Math.max(size.y,1);camera.position.set(0,hh*.48,hh*2.1);controls.target.set(0,hh*.42,0);controls.update();
  viewer={renderer,camera,scene,controls,vrm,raf:0};viewerStatus('✅ 3D-просмотр готов');
  const clock=new THREE.Clock();const tick=()=>{viewer.raf=requestAnimationFrame(tick);const dt=clock.getDelta();viewer.vrm?.update(dt);viewer.controls?.update();viewer.renderer?.render(viewer.scene,viewer.camera)};tick();
 }catch(e){viewerStatus('❌ 3D: '+(e?.message||e));console.error('[VRM Manager 3D]',e);}
};
window.load3DNow=()=>window.state?.model?.path?window.refresh3D(window.state.model.path):viewerStatus('⚠️ Сначала открой модель.');
window.viewerReset=()=>{if(viewer.controls){viewer.camera.position.set(0,1.35,3);viewer.controls.target.set(0,1.1,0);viewer.controls.update()}};
