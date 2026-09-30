'use strict';
const {randomBytes,createHash,createHmac,scrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const script=readFileSync(path.join(__dirname,'state.lua'),'utf8');
const derive=promisify(scrypt),sha=x=>createHash('sha256').update(x).digest('hex');
const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
const circuits=['monza','silverstone','monaco'];
function createHandler({env=process.env,fetchImpl=fetch,now=Date.now,production=true,store}={}){
  const cookieName=production?'__Host-apex_session':'apex_session';let hashes=0;
  async function call(op,data,token){
    const payload={op,data,token,now:now()};let result;
    if(store)result=await store(payload);
    else{
      const url=env.UPSTASH_REDIS_REST_URL||env.KV_REST_API_URL,secret=env.UPSTASH_REDIS_REST_TOKEN||env.KV_REST_API_TOKEN;
      if(!url||!secret)fail(503,'Vercel에서 Upstash Redis 저장소를 연결하고 다시 배포해 주세요.');
      if(!/^https:\/\//.test(url))fail(503,'저장소 주소는 HTTPS로 설정해 주세요.');
      const stage=env.VERCEL_ENV||'production';
      const key=env.APEX_STORAGE_KEY||('apex:f1:v1:'+stage);
      const response=await fetchImpl(url.replace(/\/$/,''),{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify(['EVAL',script,1,key,JSON.stringify(payload)]),signal:AbortSignal.timeout(6500)});
      const value=await response.json();if(!response.ok||value.error)fail(503,'공유 저장소 연결에 실패했습니다. Vercel 저장소 설정을 확인해 주세요.');
      result=JSON.parse(value.result);
    }
    if(result.data?.rooms&&!Array.isArray(result.data.rooms))result.data.rooms=Object.values(result.data.rooms);
    if(result.data?.players&&!Array.isArray(result.data.players))result.data.players=Object.values(result.data.players);
    return result;
  }
  async function pinHash(pin,salt){
    if(typeof env.AUTH_PEPPER!=='string'||env.AUTH_PEPPER.length<32)fail(503,'Vercel 환경변수 AUTH_PEPPER에 무작위 비밀값 32자 이상을 설정해 주세요.');
    if(hashes>=4)fail(503,'접속이 몰리고 있어요. 잠시 후 다시 시도해 주세요.');hashes++;
    try{return(await derive(createHmac('sha256',env.AUTH_PEPPER).update(pin).digest('hex'),salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024})).toString('hex');}finally{hashes--;}
  }
  async function body(req){
    if(!String(req.headers['content-type']||'').startsWith('application/json'))fail(415,'JSON 요청이 필요합니다.');
    let value=req.body;
    if(value===undefined){const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4096)fail(413,'요청이 너무 큽니다.');chunks.push(chunk);}value=Buffer.concat(chunks).toString('utf8');}
    try{if(typeof value==='string')value=JSON.parse(value);if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'올바르지 않은 요청입니다.');if(Buffer.byteLength(JSON.stringify(value))>4096)fail(413,'요청이 너무 큽니다.');return value;}catch(e){if(e.status)throw e;fail(400,'올바르지 않은 요청입니다.');}
  }
  return async function handler(req,res){
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    try{
      const parsed=new URL(req.url,'http://internal'),scope=req.query?.scope||parsed.searchParams.get('scope'),action=req.query?.action||parsed.searchParams.get('action');
      const op=scope==='health'?'health':scope+'/'+action;
      const allowed=['health','auth/me','auth/register','auth/login','auth/logout','time-trial/leaders','time-trial/start','time-trial/finish','rooms/list','rooms/create','rooms/join','rooms/leave','rooms/start','rooms/ready','rooms/sync'];
      if(!allowed.includes(op))fail(404,'찾을 수 없습니다.');
      const isGet=['health','auth/me','time-trial/leaders'].includes(op);if(req.method!==(isGet?'GET':'POST'))fail(405,'허용하지 않는 요청입니다.');
      if(!isGet){
        const source=req.headers.origin;let valid=false;
        try{const u=new URL(source);valid=u.origin===source&&u.protocol===(production?'https:':'http:')&&u.host===req.headers.host;}catch{}
        if(env.APP_ORIGIN)valid=valid&&source===env.APP_ORIGIN;
        if(!valid)fail(403,'다른 사이트에서 보낸 요청은 허용하지 않습니다.');
      }
      const token=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
      const tokenHash=sha(token);let data=isGet?{}:await body(req);let newToken=null,remember=false;
      if(['auth/register','auth/login'].includes(op)){
        const name=typeof data.nickname==='string'?data.nickname.normalize('NFKC').trim():'';
        if(!/^[\p{L}\p{N}_-]{2,14}$/u.test(name))fail(400,'닉네임은 2~14자, 한글·영문·숫자·밑줄·하이픈만 사용할 수 있어요.');
        if(typeof data.pin!=='string'||!/^\d{6}$/.test(data.pin))fail(400,'PIN은 숫자 6자리로 입력해 주세요.');
        const key=name.toLowerCase();remember=data.remember===true;newToken=randomBytes(32).toString('hex');
        const session={newToken:sha(newToken),expires:now()+(remember?30*86400:12*3600)*1000};
        if(op==='auth/register'){
          const salt=randomBytes(16).toString('hex'),pin_hash=await pinHash(data.pin,salt);
          data={key,...session,user:{id:randomBytes(16).toString('hex'),nickname:name,salt,pin_hash,created:now()}};
        }else{
          const record=(await call('lookup',{key},tokenHash)).data.record;
          const hash=await pinHash(data.pin,record?.salt||'00000000000000000000000000000000');
          if(!record||!timingSafeEqual(Buffer.from(sha(hash)),Buffer.from(sha(record.pin_hash))))fail(401,'닉네임 또는 PIN이 올바르지 않습니다.');
          data={id:record.id,expectedHash:record.pin_hash,...session};
        }
      }
      if(op==='time-trial/start'){if(!circuits.includes(data.circuit))fail(400,'올바르지 않은 서킷입니다.');data={circuit:data.circuit,runId:randomBytes(24).toString('hex')};}
      if(op==='time-trial/finish'&&(typeof data.runId!=='string'||!Number.isSafeInteger(data.timeMs)||data.timeMs<1000||data.timeMs>86400000))fail(400,'올바르지 않은 기록입니다.');
      if(['rooms/create','rooms/join'].includes(op)){
        if(!Number.isInteger(data.team)||data.team<0||data.team>9)fail(400,'팀을 선택해 주세요.');
        const code=typeof data.code==='string'?data.code.trim().toUpperCase():'';if(!/^[A-Z0-9]{4,12}$/.test(code))fail(400,'입장 코드는 영문·숫자 4~12자로 입력해 주세요.');data={...data,code};
        if(op==='rooms/create'){
          const name=typeof data.name==='string'?data.name.normalize('NFKC').trim():'';
          if(name.length<2||name.length>30||/[\u0000-\u001f\u007f<>]/u.test(name))fail(400,'방 이름은 2~30자로 입력해 주세요.');
          if(!Number.isInteger(data.circuit)||data.circuit<0||data.circuit>2)fail(400,'서킷을 선택해 주세요.');data={...data,name,roomId:randomBytes(6).toString('hex')};
        }else if(typeof data.roomId!=='string')fail(400,'방을 선택해 주세요.');
      }
      if(op==='rooms/sync'){
        if(data.pose!==undefined&&(!Array.isArray(data.pose)||data.pose.length!==5||data.pose.some(v=>!Number.isFinite(v)||Math.abs(v)>100000)))fail(400,'차량 좌표 오류');
        if(data.progress!==undefined&&!Number.isFinite(data.progress))fail(400,'진행률 오류');
        data={...(data.pose?{pose:data.pose}:{}),...(data.progress!==undefined?{progress:data.progress}:{}),finished:data.finished===true};
      }
      const result=await call(op,data,tokenHash);
      if(result.status<400&&(newToken||op==='auth/logout'))res.setHeader('Set-Cookie',`${cookieName}=${newToken||''}; Path=/; HttpOnly; SameSite=Lax${production?'; Secure':''}${op==='auth/logout'?'; Max-Age=0':remember?'; Max-Age='+30*86400:''}`);
      send(result.status,result.data);
    }catch(e){if(!res.headersSent)send(e.status||503,{error:e.status?e.message:'서버 연결이 늦습니다. 잠시 후 다시 시도해 주세요.'});else res.end();}
  };
}
module.exports={createHandler,script};
