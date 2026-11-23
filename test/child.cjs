const { main } = require('../dist/main');
const crash = () => process.kill(process.pid, 'SIGKILL');
const target = process.env.TEST_CRASH_TARGET;
const crashPoint = process.env.TEST_CRASH_POINT;
process.on('message', message => {
  if (message === 'stop') {
    process.disconnect?.();
    process.emit('SIGTERM');
  }
});
async function run() {
  if (crashPoint === 'publish' || crashPoint === 'mark') {
    // Isolate publisher crashes so a broker receive cannot be abandoned by this process.
    const { connect } = require('../dist/database');
    const { Queues, Workers } = require('../dist/messaging');
    const { Wagering } = require('../dist/wagering');
    const db = await connect();
    const worker = new Workers(db, new Queues(), new Wagering(db), {
      beforePublish: id => { if (crashPoint === 'publish' && id === target) crash(); },
      afterPublish: id => { if (crashPoint === 'mark' && id === target) crash(); },
    });
    while (true) {
      if (!await worker.publishOne()) await Bun.sleep(250);
    }
  }
  await main({ afterCommit: id => { if (crashPoint === 'ack' && id === target) crash(); } });
}
run().catch(error => { console.error(error); process.exit(1); });
