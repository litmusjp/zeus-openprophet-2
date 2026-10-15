import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
const start = server.indexOf('function getPersistedSandboxOrders(sandbox)');
const after = server.indexOf('// Pooled HTTP agent', start);
const end = after < 0 ? -1 : server.lastIndexOf('\n}', after) + 2;
const definition = server.slice(start, end);

test('stopped-backend order query projects Purpose with durable assessment metadata', () => {
  const fixture = { order_id: 'broker-1', client_order_id: 'entry-1', purpose: 'entry', metadata: '{"assessment_id":"assessment-1"}' };
  class DatabaseFixture {
    constructor() {}
    prepare(sql) {
      return { all: () => {
        const projection = sql.slice(sql.indexOf('SELECT') + 6, sql.indexOf('FROM orders'));
        const projected = Object.fromEntries([...projection.matchAll(/([a-z_]+)\s+AS\s+([A-Za-z_]+)/g)].flatMap(([, column, alias]) => fixture[column] === undefined ? [] : [[alias, fixture[column]]]));
        return [projected];
      } };
    }
    close() {}
  }
  const getOrders = vm.runInNewContext(`(() => { ${definition}; return getPersistedSandboxOrders; })()`, {
    Database: DatabaseFixture, existsSync: () => true, path: { join: (...parts) => parts.join('/') }, PROJECT_ROOT: '/fixture', console,
  });
  const [order] = getOrders({ id: 'sandbox' });
  assert.equal(order.Purpose, 'entry');
  assert.equal(order.Metadata, fixture.metadata);
});
