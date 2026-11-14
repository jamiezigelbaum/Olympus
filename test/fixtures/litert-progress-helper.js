// A stand-in LiteRT helper (litert-helper.ts) that answers a batch with a
// picture item by item, as the real one does, for the liveness tests in
// test/built-in-embedding.test.ts. Its pauses stand for slow native work in
// the helper's own process, done as computation as the real helper's are;
// the tests themselves never wait on the clock.
const fs = require('node:fs');

function compute(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) Math.sqrt(Math.random());
}

exports.run = (behaviour, log) => {
  const answer = (id, items) => {
    const vectors = new Float32Array(items.length * 2);
    items.forEach((item, index) => vectors.set([item.text.length, item.image ? 7 : 1], index * 2));
    console.log(JSON.stringify({ id, dimension: 2, vectors: Buffer.from(vectors.buffer).toString('base64') }));
  };
  const one = (item) => Buffer.from(new Float32Array([item.text.length, item.image ? 7 : 1]).buffer).toString('base64');
  const first = !fs.existsSync(log);
  console.log(JSON.stringify({ ready: true, device: 'cpu', vision: true }));
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('close', () => process.exit(0));
  lines.on('line', (line) => {
    const request = JSON.parse(line);
    const items = request.items ?? request.texts.map((text) => ({ text }));
    fs.appendFileSync(log, `${items.map((item) => item.text).join(',')}\n`);
    if (behaviour === 'busy-then-answer') {
      // Computing, with nothing answered, for longer than the window.
      compute(700);
      answer(request.id, items);
      return;
    }
    for (const [index, item] of items.entries()) {
      // Each picture takes most of a window; the batch, several windows.
      if (behaviour === 'slow-pictures') compute(150);
      console.log(JSON.stringify({ id: request.id, progress: index, vector: one(item) }));
      if (behaviour === 'die-after-first-picture' && first && index === 0) process.exit(137);
    }
    answer(request.id, items);
  });
};
