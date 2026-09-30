-- One atomic Redis operation: all Vercel instances share the same state.
local p=cjson.decode(ARGV[1])
local raw=redis.call('GET',KEYS[1])
local s=raw and cjson.decode(raw) or cjson.decode('{"users":{},"names":{},"sessions":{},"runs":{},"bests":{},"rooms":{},"members":{}}')
local now=p.now
local function reply(status,data)
  redis.call('SET',KEYS[1],cjson.encode(s))
  return cjson.encode({status=status,data=data})
end
local function errorReply(status,message) return reply(status,{error=message}) end
local function public(u) return {id=u.id,nickname=u.nickname} end
for k,v in pairs(s.sessions) do if v.expires<=now then s.sessions[k]=nil end end
for k,v in pairs(s.runs) do if v.started<now-86400000 then s.runs[k]=nil end end
local function remove(id)
  local r=s.rooms[s.members[id] or ''];s.members[id]=nil
  if not r then return end
  r.players[id]=nil
  if not next(r.players) then s.rooms[r.id]=nil
  elseif r.host==id then local best=nil;for uid,q in pairs(r.players) do if not best or q.slot<best.slot then best=q end end;r.host=best.id end
end
local function sweep()
  local expired={};for id,rid in pairs(s.members) do local r=s.rooms[rid];local q=r and r.players[id];if not q or now-q.seen>30000 then table.insert(expired,id) end end
  for _,id in ipairs(expired) do remove(id) end
  for _,r in pairs(s.rooms) do
    if r.phase=='loading' and now-r.changed>45000 then r.phase='waiting';r.notice='로딩 시간이 초과되어 대기실로 돌아왔습니다.' end
    if r.phase=='loading' then local ready=true;for _,q in pairs(r.players) do if not q.ready then ready=false end end;if ready then r.phase='race';r.startAt=now+3000 end end
    if r.phase=='race' then local done=true;for _,q in pairs(r.players) do if not q.finish then done=false end end;if done or now-r.startAt>1200000 then r.phase='results' end end
  end
end
local function leaders()
  local result={monza=cjson.null,silverstone=cjson.null,monaco=cjson.null}
  for circuit,records in pairs(s.bests) do
    local top=nil
    for uid,b in pairs(records) do if not top or b.timeMs<top.timeMs or (b.timeMs==top.timeMs and (b.achieved<top.achieved or (b.achieved==top.achieved and uid<top.id))) then top={id=uid,timeMs=b.timeMs,achieved=b.achieved,nickname=s.users[uid].nickname} end end
    if top then result[circuit]={nickname=top.nickname,timeMs=top.timeMs} end
  end
  return result
end
sweep()
local a=p.data or {};local session=s.sessions[p.token];local user=session and s.users[session.userId]
if p.op=='health' then return reply(200,{status='ok',storage='connected'}) end
if p.op=='lookup' then local id=s.names[a.key];return reply(200,{record=id and s.users[id] or cjson.null}) end
if p.op=='auth/me' then return reply(200,{user=user and public(user) or cjson.null}) end
if p.op=='auth/logout' then s.sessions[p.token]=nil;return reply(200,{user=cjson.null}) end
if p.op=='auth/register' or p.op=='auth/login' then
  local u=nil
  if p.op=='auth/register' then
    if s.names[a.key] then return errorReply(409,'이미 사용 중인 닉네임입니다.') end
    u=a.user;s.users[u.id]=u;s.names[a.key]=u.id
  else
    u=s.users[a.id];if not u or u.pin_hash~=a.expectedHash then return errorReply(401,'닉네임 또는 PIN이 올바르지 않습니다.') end
  end
  s.sessions[p.token]=nil;s.sessions[a.newToken]={userId=u.id,expires=a.expires}
  return reply(p.op=='auth/register' and 201 or 200,{user=public(u)})
end
if p.op=='time-trial/leaders' then return reply(200,{leaders=leaders(),laps=1}) end
if not user then return errorReply(401,'로그인해 주세요.') end
if p.op=='time-trial/start' then s.runs[a.runId]={userId=user.id,circuit=a.circuit,started=now};return reply(201,{runId=a.runId}) end
if p.op=='time-trial/finish' then
  local run=s.runs[a.runId];if not run or run.userId~=user.id then return errorReply(400,'레이스 등록이 없거나 만료되었습니다.') end
  if run.finished and run.finished~=a.timeMs then return errorReply(409,'이미 제출한 레이스입니다.') end
  if a.timeMs>now-run.started+1000 then return errorReply(400,'레이스 경과 시간과 기록이 일치하지 않습니다.') end
  if not run.finished then
    run.finished=a.timeMs;s.bests[run.circuit]=s.bests[run.circuit] or {};local old=s.bests[run.circuit][user.id]
    if not old or a.timeMs<old.timeMs then s.bests[run.circuit][user.id]={timeMs=a.timeMs,achieved=now} end
  end
  return reply(200,{leaders=leaders()})
end
if p.op=='rooms/list' then
  local list={};for _,r in pairs(s.rooms) do table.insert(list,{id=r.id,name=r.name,circuit=r.circuit,phase=r.phase,count=0,capacity=6,host=r.players[r.host].nickname});for _ in pairs(r.players) do list[#list].count=list[#list].count+1 end end
  table.sort(list,function(x,y) return x.id<y.id end);return reply(200,{serverNow=now,rooms=list})
end
local r=s.rooms[s.members[user.id] or '']
if p.op=='rooms/leave' then remove(user.id);return reply(200,{ok=true}) end
if p.op=='rooms/create' or p.op=='rooms/join' then
  if r then return errorReply(409,'참가 중인 방에서 먼저 나가 주세요.') end
  if p.op=='rooms/create' then
    local count=0;for _ in pairs(s.rooms) do count=count+1 end;if count>=200 then return errorReply(503,'방이 가득 찼습니다.') end
    if s.rooms[a.roomId] then return errorReply(409,'방 생성 충돌입니다. 다시 시도해 주세요.') end
    r={id=a.roomId,name=a.name,code=a.code,host=user.id,circuit=a.circuit,phase='waiting',players={},changed=now};s.rooms[r.id]=r
  else
    r=s.rooms[a.roomId];if not r then return errorReply(404,'방이 없어졌습니다. 목록을 새로고침해 주세요.') end
    if a.code~=r.code then return errorReply(403,'입장 코드가 맞지 않습니다.') end
    if r.phase~='waiting' then return errorReply(409,'이미 출발한 방입니다.') end
  end
  local used={};local count=0;for _,q in pairs(r.players) do used[q.slot]=true;count=count+1 end;if count>=6 then return errorReply(409,'정원은 6명입니다.') end
  local slot=0;while used[slot] do slot=slot+1 end
  r.players[user.id]={id=user.id,nickname=user.nickname,team=a.team,slot=slot,ready=false,seen=now,progress=0};s.members[user.id]=r.id
elseif not r then return errorReply(404,'방 연결이 종료되었습니다. 다시 입장해 주세요.') end
local q=r.players[user.id];q.seen=now
if p.op=='rooms/start' then
  if r.host~=user.id then return errorReply(403,'방장만 시작할 수 있습니다.') end
  local count=0;for _ in pairs(r.players) do count=count+1 end;if r.phase~='waiting' or count<2 then return errorReply(409,'대기실에서 2명 이상 모이면 시작할 수 있습니다.') end
  r.phase='loading';r.changed=now;r.notice='';r.startAt=nil;for _,v in pairs(r.players) do v.ready=false;v.pose=nil;v.progress=0;v.finish=nil end
elseif p.op=='rooms/ready' then if r.phase=='loading' then q.ready=true end
elseif p.op=='rooms/sync' and (r.phase=='loading' or r.phase=='race') and not q.finish and a.pose then
  q.pose=a.pose
  if r.phase=='race' and now>=r.startAt and a.progress then q.progress=math.max(q.progress,math.min(3,math.max(0,a.progress))) end
  if a.finished and q.progress>=2.7 and r.startAt and now-r.startAt>=10000 then q.finish=now-r.startAt;q.progress=3 end
end
sweep()
local players={};for _,v in pairs(r.players) do table.insert(players,{id=v.id,nickname=v.nickname,team=v.team,slot=v.slot,ready=v.ready,pose=v.pose or cjson.null,progress=v.progress,finish=v.finish or cjson.null}) end
table.sort(players,function(x,y) return x.slot<y.slot end)
return reply(200,{id=r.id,name=r.name,code=r.host==user.id and r.code or nil,host=r.host,you=user.id,circuit=r.circuit,phase=r.phase,startAt=r.startAt,serverNow=now,notice=r.notice or '',players=players})
