const token = 'test-token';
async function probe(label, url, opts) {
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    console.log(`${label} -> status ${res.status} | body: ${text.slice(0, 80)}`);
  } catch (err) {
    console.log(`${label} -> ERROR: ${err.message}`);
  }
}
await probe('undici POST /api/echo', 'http://localhost:5999/api/echo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
  body: '{}',
});