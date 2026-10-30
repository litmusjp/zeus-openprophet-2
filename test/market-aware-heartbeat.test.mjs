import test from 'node:test';
import assert from 'node:assert/strict';
import { marketSession, marketSessionPhase, nextMarketReview, validateMarketCalendar } from '../agent/market-aware-scheduler.js';
import { AgentHarness } from '../agent/harness.js';

const calendar = [
  { date:'2026-10-30', open:'09:30', close:'16:00' },
  { date:'2026-11-02', open:'09:30', close:'16:00' },
];
const et = (date, time) => {
  const [y,m,d] = date.split('-').map(Number), [h,min] = time.split(':').map(Number);
  // Test fixture values use the known offset for each supplied date.
  return Date.UTC(y,m-1,d,h,min) + (date < '2026-11-01' ? 4 : 5) * 3600000;
};

test('broker calendar dates convert with New York DST and skip weekend', () => {
  assert.equal(marketSession(calendar, '2026-10-30').open, et('2026-10-30','09:30'));
  assert.equal(marketSession(calendar, '2026-11-02').open, et('2026-11-02','09:30'));
  assert.equal(nextMarketReview(calendar, et('2026-11-01','12:00')).at, et('2026-11-02','09:15'));
  assert.equal(validateMarketCalendar(calendar), true);
  assert.equal(validateMarketCalendar([{date:'2026-11-02',open:'09:30',close:'16:00'},{date:'2026-10-30',open:'09:30',close:'16:00'}]), false);
  assert.equal(validateMarketCalendar([{date:'2026-10-30',open:'24:00',close:'16:00'}]), false);
});

test('pre-open, regular cadence, early close and post-close reviews use actual session rows', () => {
  const fri = marketSession(calendar, '2026-10-30');
  assert.equal(nextMarketReview(calendar, et('2026-10-30','08:00')).at, et('2026-10-30','09:15'));
  const clock = time => ({ is_open:true, timestamp:new Date(et('2026-10-30',time)).toISOString() });
  assert.equal(nextMarketReview(calendar, et('2026-10-30','09:35'), clock('09:35')).at, et('2026-10-30','09:40'));
  assert.equal(nextMarketReview(calendar, et('2026-10-30','10:31'), clock('10:31')).at, et('2026-10-30','10:50'));
  assert.equal(nextMarketReview(calendar, et('2026-10-30','14:50'), clock('14:50')).at, et('2026-10-30','15:00'));
  assert.equal(nextMarketReview(calendar, et('2026-10-30','15:42'), clock('15:42')).at, et('2026-10-30','15:50'));
  assert.equal(nextMarketReview(calendar, et('2026-10-30','15:59')+59999, clock('15:59')).at, fri.close + 15*60000);
  const early = [{ date:'2026-10-30', open:'09:30', close:'13:00' }];
  assert.equal(nextMarketReview(early, et('2026-10-30','12:45'), clock('12:45')).at, et('2026-10-30','12:50'));
  assert.equal(nextMarketReview(calendar, fri.close + 5*60000).at, fri.close + 15*60000);
  assert.equal(marketSessionPhase(marketSession(early, '2026-10-30'), et('2026-10-30','12:30')), 'market_close');
  assert.equal(nextMarketReview(calendar, et('2026-10-30','11:00'), {is_open:false,timestamp:new Date(et('2026-10-30','11:00')).toISOString()}), null);
});

test('Harness start in a closed session checks backend readiness and schedules without an AI beat', async t => {
  const now = et('2026-10-30','08:00');
  let ready = 0, calls = 0;
  const harness = new AgentHarness({
    sandboxId:'sbx_test', accountId:'account',
    getSandbox: () => ({ id:'sbx_test', accountId:'account', heartbeat:{ mode:'market_aware', forceHeartbeatIntervals:true } }),
    getAccount: () => ({ id:'account', paper:true }), getAgent: () => ({ id:'agent', model:'test/model', name:'test' }),
    getResolvedAgent: () => ({ id:'agent', model:'test/model', heartbeatOverrides:{} }),
    checkCliAuthFn: () => true,
    getMarketCalendarFn: async () => ({ sessions:calendar, clock:{is_open:false,timestamp:new Date(now).toISOString()} }),
    ensureBackendReadyFn: async () => { ready++; },
    nowFn: () => now,
  });
  t.after(async () => { await harness.stop(); });
  harness.reloadConfig = async () => {
    harness._sandboxConfig = { id:'sbx_test', accountId:'account', heartbeat:{ mode:'market_aware', forceHeartbeatIntervals:true } };
    harness._agentConfig = { id:'agent', model:'test/model', name:'test' };
    harness.state.activeModel = 'test/model'; harness.state.activeAccountId = 'account';
  };
  harness._beat = async () => { calls++; };
  await harness.start();
  assert.equal(ready, 1);
  assert.equal(calls, 0);
  assert.equal(harness.state.nextReviewAt, new Date(et('2026-10-30','09:15')).toISOString());
  assert.equal(Date.parse(harness.state.nextBeatTime) > now, true);
  await harness.stop();
  assert.equal(harness.state.nextReviewAt, null);
});

test('Harness starts with an in-session review and timer joins the anchored ten-minute grid', async t => {
  let now = et('2026-10-30','09:35'), calls = 0, delay = 0, timerFn, timerId = 0;
  const harness = new AgentHarness({
    sandboxId:'sbx_session', accountId:'account',
    getSandbox:() => ({ id:'sbx_session', accountId:'account', heartbeat:{ mode:'market_aware' } }),
    getAccount:() => ({ id:'account', paper:true }), getAgent:() => ({ id:'agent', model:'test/model', name:'test' }),
    getResolvedAgent:() => ({ id:'agent', model:'test/model', heartbeatOverrides:{} }), checkCliAuthFn:() => true,
    ensureBackendReadyFn:async()=>{}, getMarketCalendarFn:async()=>({ sessions:calendar, clock:{is_open:true,timestamp:new Date(now).toISOString()} }), nowFn:()=>now,
    setTimeoutFn:(fn, ms)=>{ timerFn=fn; delay=ms; return ++timerId; }, clearTimeoutFn:()=>{},
  });
  t.after(async()=>{ await harness.stop(); });
  harness.reloadConfig = async()=>{ harness._sandboxConfig={id:'sbx_session',accountId:'account',heartbeat:{mode:'market_aware'}}; harness._agentConfig={id:'agent',model:'test/model',name:'test'}; harness.state.activeModel='test/model'; };
  harness._beat=async()=>{ calls++; };
  await harness.start();
  assert.equal(calls, 1);
  assert.equal(delay, 5*60_000);
  assert.equal(harness.state.nextReviewAt, new Date(et('2026-10-30','09:40')).toISOString());
  now = et('2026-10-30','09:40');
  await timerFn();
  assert.equal(calls, 2);
  assert.equal(harness.state.nextReviewAt, new Date(et('2026-10-30','09:50')).toISOString());
});


test('Harness fails closed on unavailable calendar and retries without AI inference', async t => {
  const now = et('2026-10-30','08:00');
  let calls = 0;
  const harness = new AgentHarness({
    sandboxId:'sbx_unavailable', accountId:'account',
    getSandbox:() => ({ id:'sbx_unavailable', accountId:'account', heartbeat:{ mode:'market_aware' } }),
    getAccount:() => ({ id:'account', paper:true }), getAgent:() => ({ id:'agent', model:'test/model', name:'test' }),
    getResolvedAgent:() => ({ id:'agent', model:'test/model', heartbeatOverrides:{} }), checkCliAuthFn:() => true,
    ensureBackendReadyFn:async()=>{}, getMarketCalendarFn:async()=>{ throw new Error('calendar unavailable'); }, nowFn:()=>now,
  });
  t.after(async()=>{ await harness.stop(); });
  harness.reloadConfig = async()=>{ harness._sandboxConfig={id:'sbx_unavailable',accountId:'account',heartbeat:{mode:'market_aware'}}; harness._agentConfig={id:'agent',model:'test/model',name:'test'}; harness.state.activeModel='test/model'; };
  harness._beat=async()=>{ calls++; };
  await harness.start();
  assert.equal(calls, 0);
  assert.equal(harness.state.scheduleStatus, 'unavailable');
  assert.equal(harness.state.nextReviewAt, null);
  assert.equal(Date.parse(harness.state.nextBeatTime), now + 60_000);
});

test('actual heartbeat input uses the early-close calendar phase with a stub model', async () => {
  const early=[{date:'2026-10-30',open:'09:30',close:'13:00'}],now=et('2026-10-30','12:30'),prompts=[];
  const harness=new AgentHarness({sandboxId:'sbx_phase',accountId:'account',getSandbox:()=>({id:'sbx_phase',accountId:'account',heartbeat:{mode:'market_aware'}}),getAccount:()=>({id:'account',paper:true}),getResolvedAgent:()=>({id:'agent',name:'test',model:'test/model'}),nowFn:()=>now});
  harness._sandboxConfig={id:'sbx_phase',accountId:'account',heartbeat:{mode:'market_aware'}};harness._agentConfig={id:'agent',name:'test'};harness.state.running=true;harness.state.activeAccountId='account';harness.state.activeModel='test/model';harness.state.activeSandboxId='sbx_phase';harness._marketSession=marketSession(early,'2026-10-30');
  harness._runClaude=async prompt=>{prompts.push(prompt);return{text:'stub'};};await harness._beat();
  assert.equal(prompts.length,1);assert.match(prompts[0],/Phase: Market Close/);assert.equal(harness.state.phase,'market_close');
  await harness.stop();
});

test('manual message beat preserves the anchored market grid', async t => {
  let now=et('2026-10-30','09:35'),modelCalls=0;
  const harness=new AgentHarness({sandboxId:'sbx_manual',accountId:'account',getSandbox:()=>({id:'sbx_manual',accountId:'account',heartbeat:{mode:'market_aware'}}),getAccount:()=>({id:'account',paper:true}),getAgent:()=>({id:'agent',model:'test/model',name:'test'}),getResolvedAgent:()=>({id:'agent',model:'test/model',name:'test',heartbeatOverrides:{}}),checkCliAuthFn:()=>true,ensureBackendReadyFn:async()=>{},getMarketCalendarFn:async()=>({sessions:calendar,clock:{is_open:true,timestamp:new Date(now).toISOString()}}),nowFn:()=>now,setTimeoutFn:()=>1,clearTimeoutFn:()=>{}});
  t.after(async()=>{await harness.stop();});harness.reloadConfig=async()=>{harness._sandboxConfig={id:'sbx_manual',accountId:'account',heartbeat:{mode:'market_aware'}};harness._agentConfig={id:'agent',name:'test',model:'test/model',heartbeatOverrides:{}};harness.state.activeModel='test/model';harness.state.activeAccountId='account';harness.state.activeSandboxId='sbx_manual';};
  harness._runClaude=async()=>{modelCalls++;return{text:'stub'};};await harness.start();const scheduled=harness.state.nextReviewAt;await harness._fireAdHocBeat('operator message');
  assert.equal(modelCalls,2);assert.equal(harness.state.nextReviewAt,scheduled);assert.equal(scheduled,new Date(et('2026-10-30','09:40')).toISOString());
});

test('stop, pause or market-mode deactivation during an awaited calendar read prevents review and rearm', async t => {
  for(const terminal of ['stopped','paused','deactivated']){
    let now=et('2026-10-30','09:35'),calls=0,timerFn,timerCount=0,calendarCalls=0,release,mode='market_aware';
    const harness=new AgentHarness({sandboxId:`sbx_${terminal}`,accountId:'account',getSandbox:()=>({id:`sbx_${terminal}`,accountId:'account',heartbeat:{mode}}),getAccount:()=>({id:'account',paper:true}),getAgent:()=>({id:'agent',model:'test/model',name:'test'}),getResolvedAgent:()=>({id:'agent',model:'test/model',name:'test',heartbeatOverrides:{}}),checkCliAuthFn:()=>true,ensureBackendReadyFn:async()=>{},getMarketCalendarFn:async()=>{calendarCalls++;if(calendarCalls===1)return{sessions:calendar,clock:{is_open:true,timestamp:new Date(now).toISOString()}};return new Promise(resolve=>{release=resolve;});},nowFn:()=>now,setTimeoutFn:(fn)=>{timerFn=fn;timerCount++;return timerCount;},clearTimeoutFn:()=>{}});
    t.after(async()=>{await harness.stop();});harness.reloadConfig=async()=>{harness._sandboxConfig={id:`sbx_${terminal}`,accountId:'account',heartbeat:{mode:'market_aware'}};harness._agentConfig={id:'agent',model:'test/model',name:'test',heartbeatOverrides:{}};harness.state.activeModel='test/model';harness.state.activeAccountId='account';harness.state.activeSandboxId=`sbx_${terminal}`;};harness._beat=async()=>{calls++;};
    await harness.start();now=et('2026-10-30','09:40');const pending=timerFn();await new Promise(resolve=>setImmediate(resolve));
    if(terminal==='paused')harness.state.paused=true;else if(terminal==='stopped')harness.state.running=false;else{mode='legacy';harness._sandboxConfig.heartbeat.mode='legacy';harness._marketScheduleEpoch++;if(harness._timer){harness.clearTimeoutFn(harness._timer);harness._timer=null;}}
    const timersAfterTransition=timerCount;
    release({sessions:calendar,clock:{is_open:true,timestamp:new Date(now).toISOString()}});await pending;
    assert.equal(calls,1,`${terminal} callback did not run a second model beat`);assert.equal(timerCount,timersAfterTransition,`${terminal} callback did not rearm`);
  }
});
