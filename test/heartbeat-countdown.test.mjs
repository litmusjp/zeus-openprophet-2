import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');

function productionFunction(name) {
  const match = page.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `production ${name}() exists`);
  return match[0];
}

test('one heartbeat timer updates each sandbox sidebar from its own active schedule', () => {
  const nodes = new Map([
    ['header-next', { textContent: '--' }],
    ['a-next', { textContent: '--' }],
    ['b-next', { textContent: '--' }],
    ['hb-fill', { style: {} }],
  ]);
  const statNodes = [
    { dataset: { stat: 'sandbox-a-hb-next' } },
    { dataset: { stat: 'sandbox-b-hb-next' } },
  ];
  let now = 1_000;
  let tick;
  let intervalCount = 0;
  const activeIntervals = new Set();
  const NativeDate = Date;
  class ClockDate extends NativeDate {
    static now() { return now; }
  }
  const context = {
    Date: ClockDate,
    document: {
      getElementById: id => nodes.get(id) || null,
      querySelectorAll: selector => selector === '[data-stat$="-hb-next"]' ? statNodes : [],
      querySelector: selector => {
        const stat = selector.match(/data-stat="([^"]+)"/)?.[1];
        return stat === 'sandbox-a-hb-next' ? nodes.get('a-next')
          : stat === 'sandbox-b-hb-next' ? nodes.get('b-next') : null;
      },
    },
    setInterval: (fn, ms) => { assert.equal(ms, 1000); intervalCount++; tick = fn; activeIntervals.add(intervalCount); return intervalCount; },
    clearInterval: id => activeIntervals.delete(id),
    _set: (id, value) => { const node = nodes.get(id === 'hb-next' ? 'header-next' : id); if (node) node.textContent = value; },
    _setData: (key, value) => {
      const id = key === 'sandbox-a-hb-next' ? 'a-next' : key === 'sandbox-b-hb-next' ? 'b-next' : null;
      if (id) nodes.get(id).textContent = value;
    },
    progressInterval: 0,
    nextBeatTime: null,
    heartbeatSeconds: 0,
    selectedSandboxId: 'sandbox-a',
    getEffectiveSandboxId: () => context.selectedSandboxId,
    sandboxRuntime: {
      'sandbox-a': { running: true, paused: false },
      'sandbox-b': { running: true, paused: false },
    },
    sandboxSchedule: {},
  };
  vm.createContext(context);
  vm.runInContext(`
    sandboxSchedule['sandbox-a'] = { nextBeatTime: new Date(61_000), seconds: 60 };
    sandboxSchedule['sandbox-b'] = { nextBeatTime: new Date(121_000), seconds: 60 };
    nextBeatTime = sandboxSchedule['sandbox-a'].nextBeatTime;
    heartbeatSeconds = 60;
    ${productionFunction('sandboxHeartbeatCountdown')}
    ${productionFunction('updateSandboxHeartbeatCountdowns')}
    ${productionFunction('startProgress')}
    startProgress();
  `, context);

  assert.equal(intervalCount, 1, 'the existing progress timer is reused');
  assert.equal(activeIntervals.size, 1);
  tick();
  assert.equal(nodes.get('header-next').textContent, '60s');
  assert.equal(nodes.get('a-next').textContent, '60s');
  assert.equal(nodes.get('b-next').textContent, '120s');

  context.selectedSandboxId = 'sandbox-b';
  vm.runInContext("nextBeatTime = sandboxSchedule['sandbox-b'].nextBeatTime; startProgress();", context);
  assert.equal(intervalCount, 2, 'restarting progress replaces the one active timer');
  assert.equal(activeIntervals.size, 1, 'only one progress timer remains active');
  now += 1_000;
  tick();
  assert.equal(nodes.get('header-next').textContent, '119s');
  assert.equal(nodes.get('a-next').textContent, '59s');
  assert.equal(nodes.get('b-next').textContent, '119s');

  context.sandboxRuntime['sandbox-b'].paused = true;
  now += 1_000;
  tick();
  assert.equal(nodes.get('b-next').textContent, '--', 'paused schedules are cleared');
  assert.equal(nodes.get('header-next').textContent, '--');

  context.sandboxRuntime['sandbox-b'].paused = false;
  vm.runInContext("sandboxSchedule['sandbox-b'].nextBeatTime = new Date(NaN);", context);
  tick();
  assert.equal(nodes.get('b-next').textContent, '--', 'invalid dates are cleared');

  vm.runInContext("sandboxSchedule['sandbox-b'].nextBeatTime = null;", context);
  tick();
  assert.equal(nodes.get('b-next').textContent, '--', 'missing schedules are cleared');

  context.sandboxRuntime['sandbox-a'].running = false;
  tick();
  assert.equal(nodes.get('a-next').textContent, '--', 'stopped sandboxes are cleared');
});

test('market-aware settings render effective cadence and save only the selected sandbox with lock enabled', async () => {
  const ids = ['pre_market','market_open','midday','market_close','after_hours','closed'];
  const nodes = new Map(ids.flatMap(p => [[`hb-${p}`, { value:'600', disabled:false }], [`hb-hours-${p}`, { textContent:'' }], [`hb-range-${p}`, { textContent:'' }]]));
  nodes.set('hb-force-agent', { checked:true, disabled:false });
  nodes.set('hb-market-mode', { value:'market_aware' });
  nodes.set('hb-label-pre_market', { textContent:'' }); nodes.set('hb-label-after_hours', { textContent:'' }); nodes.set('hb-label-closed', { textContent:'' });
  nodes.set('hb-market-effective', { textContent:'' });
  let save, posted, refreshed=0;
  const ctx = {
    document:{ getElementById:id => nodes.get(id) || null },
    structuredClone:value=>JSON.parse(JSON.stringify(value)),
    sandboxScoped:{ heartbeat:{ mode:'market_aware', forceHeartbeatIntervals:true, pre_market:600, market_open:600, midday:1200, market_close:600, after_hours:7200, closed:14400 }, heartbeatPhases:{market_close:{start:900,end:960,label:'Markets Close'}} },
    config:{ heartbeat:{}, sandboxes:{ 'sbx-selected':{ heartbeat:{mode:'legacy',market_open:600,midday:1200,market_close:600} } } },
    formatHeartbeatPhaseRange:()=>'range', formatHeartbeatHours:()=>'h', updateHeartbeatHours:()=>{},
    getEffectiveSandboxId:()=> 'sbx-selected',
    clearTimeout:()=>{}, setTimeout:fn=>{ save=fn; return 1; }, _hbTimer:null,
    fetch:async (url, options) => { posted={url, ...options, body:JSON.parse(options.body)}; return { ok:true }; },
    refreshSelectedSandboxConfig:async()=>{refreshed++;}, toast:()=>{},
  };
  vm.createContext(ctx);
  vm.runInContext(`${productionFunction('renderHeartbeat')}\n${productionFunction('saveHeartbeat')}`, ctx);
  ctx.renderHeartbeat();
  assert.equal(nodes.get('hb-market-effective').textContent.includes('10/20/10'), true);
  assert.deepEqual(ids.map(p=>nodes.get(`hb-range-${p}`).textContent), ['15 min before open','First actual hour','Actual session middle','Last actual hour','15 min after close','Sleep']);
  assert.equal(nodes.get('hb-pre_market').disabled, true);
  for (const p of ['market_open','midday','market_close']) assert.equal(nodes.get(`hb-${p}`).disabled, false);
  assert.equal(nodes.get('hb-after_hours').disabled, true); assert.equal(nodes.get('hb-closed').disabled, true);
  assert.equal(nodes.get('hb-force-agent').disabled, true);
  ctx.saveHeartbeat(); await save();
  assert.equal(posted.url, '/api/heartbeat');
  assert.equal(posted.body.sandboxId, 'sbx-selected');
  assert.equal(posted.body.forceHeartbeatIntervals, true);
  assert.equal(posted.body.midday, 1200);
  assert.equal(posted.body.pre_market, undefined);
  assert.equal(refreshed, 1);
});

test('heartbeat settings save handler surfaces rejected writes and does not refresh as if saved', async () => {
  let save, refreshed=0, notice='';
  const ctx = {
    document:{ getElementById:id => id === 'hb-market-mode' ? { value:'legacy' } : id === 'hb-force-agent' ? { checked:false } : { value:'600' } },
    structuredClone:value=>JSON.parse(JSON.stringify(value)), config:{sandboxes:{}}, getEffectiveSandboxId:()=> 'sbx-selected', clearTimeout:()=>{}, setTimeout:fn=>{ save=fn; return 1; }, _hbTimer:null,
    fetch:async()=>({ ok:false, json:async()=>({error:'operator authorization required'}) }),
    toast:message=>{notice=message;}, refreshSelectedSandboxConfig:async()=>{refreshed++;},
  };
  vm.createContext(ctx);
  vm.runInContext(productionFunction('saveHeartbeat'), ctx);
  ctx.saveHeartbeat(); await save();
  assert.equal(notice, 'operator authorization required');
  assert.equal(refreshed, 0);
});

test('market-mode save uses the captured sandbox, interval values and current-heartbeat CAS', async () => {
  const nodes=new Map([['hb-market-mode',{value:'legacy'}],['hb-market_open',{value:'360'}],['hb-midday',{value:'900'}],['hb-market_close',{value:'480'}]]);
  let posted,refresh=0;const ctx={document:{getElementById:id=>nodes.get(id)||null},structuredClone:value=>JSON.parse(JSON.stringify(value)),config:{sandboxes:{'sbx-a':{heartbeat:{market_open:600,midday:1200,market_close:600,forceHeartbeatIntervals:true}}}},getEffectiveSandboxId:()=> 'sbx-a',fetch:async(_url,options)=>{posted=JSON.parse(options.body);return{ok:true,json:async()=>({ok:true})};},refreshSelectedSandboxConfig:async()=>{refresh++;},renderHeartbeat:()=>{},toast:()=>{}};
  ctx.fetch=async(url,options)=>{if(options?.method==='PUT'){posted=JSON.parse(options.body);return{ok:true,json:async()=>({ok:true})};}return{ok:true,json:async()=>({sandboxes:{}})};};
  vm.createContext(ctx);vm.runInContext(`async ${productionFunction('saveMarketHeartbeatMode')}`,ctx);await ctx.saveMarketHeartbeatMode();
  assert.equal(posted.sandboxId,'sbx-a');assert.equal(posted.mode,'legacy');assert.equal(posted.intervals.market_open,360);assert.equal(posted.expectedCurrentHeartbeat.midday,1200);assert.equal(refresh,1);
});

test('market-mode operator rejection restores the rendered value and reports no save', async () => {
  const nodes=new Map([['hb-market-mode',{value:'market_aware'}],['hb-market_open',{value:'600'}],['hb-midday',{value:'1200'}],['hb-market_close',{value:'600'}]]);
  let message='',renders=0,refresh=0;const ctx={document:{getElementById:id=>nodes.get(id)||null},structuredClone:value=>JSON.parse(JSON.stringify(value)),config:{sandboxes:{'sbx-a':{heartbeat:{mode:'legacy',market_open:900,midday:1800,market_close:900}}}},getEffectiveSandboxId:()=> 'sbx-a',fetch:async()=>({ok:false,json:async()=>({error:'Heartbeat settings changed; refresh and review before saving'})}),refreshSelectedSandboxConfig:async()=>{refresh++;},renderHeartbeat:()=>{renders++;nodes.get('hb-market-mode').value='legacy';},toast:text=>{message=text;}};
  vm.createContext(ctx);vm.runInContext(`async ${productionFunction('saveMarketHeartbeatMode')}`,ctx);await ctx.saveMarketHeartbeatMode();
  assert.equal(message,'Heartbeat settings changed; refresh and review before saving');assert.equal(nodes.get('hb-market-mode').value,'legacy');assert.equal(renders,1);assert.equal(refresh,0);
});
