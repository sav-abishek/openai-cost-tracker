'use strict';
const { parentPort, workerData } = require('node:worker_threads');
const { Indexer } = require('./indexer');
const index = new Indexer(workerData.cachePath);
let chain = Promise.resolve();
parentPort.on('message', message => {
  chain = chain.then(async () => {
    try {
      const result = message.action === 'export' ? index.export(message.settings) : await index.scan(message.home, message.settings);
      parentPort.postMessage({ id: message.id, result });
    } catch (e) { parentPort.postMessage({ id: message.id, error: 'Accounting index failed: ' + (e.code || e.name) }); }
  });
});
