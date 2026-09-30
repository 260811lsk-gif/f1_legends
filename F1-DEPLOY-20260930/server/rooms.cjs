'use strict';
const {randomBytes}=require('node:crypto');
module.exports=function createRooms({currentUser,body,send,origin,now}){
  const rooms=new Map(), membership=new Map();
  const fail=(status,message)=>{throw Object.assign(Error(message),{status});};
  function remove(id){const r=rooms.get(membership.get(id));membership.delete(id);if(!r)return;r.players.delete(id);if(!r.players.size)rooms.delete(r.id);else if(r.host===id)r.host=r.players.keys().next().value;}
  function sweep(){for(const [id,code] of membership){const p=rooms.get(code)?.players.get(id);if(!p||now()-p.seen>30000)remove(id);}for(const r of rooms.values()){if(r.phase==='loading'&&now()-r.changed>45000){r.phase='waiting';r.notice='로딩 시간이 초과되어 대기실로 돌아왔습니다.';}if(r.phase==='loading'&&[...r.players.values()].every(p=>p.ready)){r.phase='race';r.startAt=now()+3000;}if(r.phase==='race'&&([...r.players.values()].every(p=>p.finish)||now()-r.startAt>20*60000))r.phase='results';}}
  function snapshot(r,user){return {id:r.id,name:r.name,code:r.host===user.id?r.code:undefined,host:r.host,you:user.id,circuit:r.circuit,phase:r.phase,startAt:r.startAt,serverNow:now(),notice:r.notice||'',players:[...r.players.values()].map(p=>({id:p.id,nickname:p.nickname,team:p.team,slot:p.slot,ready:p.ready,pose:p.pose,progress:p.progress,finish:p.finish}))};}
  return async function(req,res,url){
    if(!url.pathname.startsWith('/api/rooms/'))return false;
    const user=currentUser(req);if(!user)fail(401,'로그인해 주세요.');
    sweep();const action=url.pathname.slice('/api/rooms/'.length);
    if(req.method!=='POST')fail(405,'POST 요청이 필요합니다.');
    if(req.headers.origin!==origin)fail(403,'허용되지 않은 접속입니다.');
    const data=await body(req);let r=rooms.get(membership.get(user.id));
    if(action==='list'){
      send(res,200,{serverNow:now(),rooms:[...rooms.values()].map(r=>({id:r.id,name:r.name,circuit:r.circuit,phase:r.phase,count:r.players.size,capacity:6,host:r.players.get(r.host).nickname}))});return true;
    }
    if(action==='create'||action==='join'){
      if(r)fail(409,'참가 중인 방에서 먼저 나가 주세요.');
      if(!Number.isInteger(data.team)||data.team<0||data.team>9)fail(400,'팀을 선택해 주세요.');
      if(action==='create'){
        if(!Number.isInteger(data.circuit)||data.circuit<0||data.circuit>2)fail(400,'서킷을 선택해 주세요.');
        if(rooms.size>=200)fail(503,'방이 가득 찼습니다.');
        const name=typeof data.name==='string'?data.name.normalize('NFKC').trim():'';
        if(name.length<2||name.length>30||/[\u0000-\u001f\u007f<>]/u.test(name))fail(400,'방 이름은 2~30자로 입력해 주세요.');
        const code=typeof data.code==='string'?data.code.trim().toUpperCase():'';
        if(!/^[A-Z0-9]{4,12}$/.test(code))fail(400,'입장 코드는 영문·숫자 4~12자로 설정해 주세요.');
        let id;do{id=randomBytes(6).toString('hex');}while(rooms.has(id));
        r={id,name,code,host:user.id,circuit:data.circuit,phase:'waiting',players:new Map(),changed:now()};rooms.set(id,r);
      }else{
        r=rooms.get(data.roomId);if(!r)fail(404,'방이 없어졌습니다. 목록을 새로고침해 주세요.');
        if(typeof data.code!=='string'||data.code.trim().toUpperCase()!==r.code)fail(403,'입장 코드가 맞지 않습니다.');
        if(r.phase!=='waiting')fail(409,'이미 출발한 방입니다.');if(r.players.size>=6)fail(409,'정원은 6명입니다.');
      }
      const used=new Set([...r.players.values()].map(p=>p.slot));let slot=0;while(used.has(slot))slot++;
      r.players.set(user.id,{id:user.id,nickname:user.nickname,team:data.team,slot,ready:false,seen:now(),pose:null,progress:0,finish:null});membership.set(user.id,r.id);
    }else if(action==='leave'){remove(user.id);send(res,200,{ok:true});return true;}
    else if(!r)fail(404,'방 연결이 종료되었습니다. 다시 입장해 주세요.');
    const p=r.players.get(user.id);p.seen=now();
    if(action==='start'){
      if(r.host!==user.id)fail(403,'방장만 시작할 수 있습니다.');if(r.phase!=='waiting'||r.players.size<2)fail(409,'대기실에서 2명 이상 모이면 시작할 수 있습니다.');
      r.phase='loading';r.changed=now();r.notice='';for(const q of r.players.values()){q.ready=false;q.pose=null;q.progress=0;q.finish=null;}
    }else if(action==='ready'){if(r.phase==='loading')p.ready=true;}
    else if(action==='sync'){
      if(['loading','race'].includes(r.phase)&&!p.finish&&data.pose){
        const a=data.pose;if(!Array.isArray(a)||a.length!==5||a.some(v=>!Number.isFinite(v)||Math.abs(v)>100000))fail(400,'차량 좌표 오류');
        p.pose=a;if(r.phase==='race'&&now()>=r.startAt&&Number.isFinite(data.progress))p.progress=Math.max(p.progress,Math.min(3,Math.max(0,data.progress)));
        if(data.finished&&p.progress>=2.7&&now()-r.startAt>=10000){p.finish=now()-r.startAt;p.progress=3;}
      }
    }else if(!['create','join','start','ready'].includes(action))fail(404,'없는 요청입니다.');
    sweep();send(res,200,snapshot(r,user));return true;
  };
};
