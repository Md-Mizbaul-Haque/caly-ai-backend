// E2E: Progress-screen data flow against a RUNNING server (default :5000).
// Usage: node scripts/e2e-progress.js  (requires the API server up)
// Covers: login → weights list → create → same-day upsert → goal → meals
// range → delete → barcode lookup. Exits non-zero on any assertion failure.
require('dotenv').config();
const BASE = process.argv[2] || `http://localhost:${Number(process.env.PORT) > 0 ? process.env.PORT : 5000}`;

const EMAIL = 'test@caly.ai';
const PASSWORD = 'Test1234!';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log(`E2E against ${BASE}`);

  // 1. Health
  const health = await api('GET', '/health');
  check('health ok + db up', health.status === 200 && health.data.db === 'up', JSON.stringify(health.data));

  // 2. Login (seeded verified user)
  const login = await api('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  check('login returns token', login.status === 200 && !!login.data.token, JSON.stringify(login.data).slice(0, 120));
  if (!login.data.token) process.exit(1);
  const token = login.data.token;

  // 3. Weights list (seeded: yesterday 70.2, today 70)
  let w = await api('GET', '/api/weights', { token });
  check('GET /api/weights 200 with array', w.status === 200 && Array.isArray(w.data.weights));
  const before = w.data.weights.length;
  console.log(`        (${before} existing weight entries)`);

  // 4. Create today's weight — same-day entries UPSERT (200/updated:true),
  // new days INSERT (201/updated:false). Seed data already logs today, so
  // detect which path should apply instead of assuming.
  const dkLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayK = dkLocal(new Date());
  const hadToday = w.data.weights.some(x => dkLocal(new Date(x.loggedAt)) === todayK);
  const post1 = await api('POST', '/api/weights', { token, body: { value: 69.4 } });
  check(
    hadToday ? 'POST onto existing day → 200 + updated:true' : 'POST onto empty day → 201 + updated:false',
    post1.status === (hadToday ? 200 : 201) && post1.data.updated === hadToday && post1.data.weight.value === 69.4,
    JSON.stringify(post1.data)
  );
  const firstId = post1.data.weight.id;
  const post2 = await api('POST', '/api/weights', { token, body: { value: 69.1 } });
  check('same-day re-log returns 200 + updated:true', post2.status === 200 && post2.data.updated === true, JSON.stringify(post2.data));
  check('same-day re-log keeps one row per day (id stable)', post2.data.weight.id === firstId, `${firstId} vs ${post2.data.weight?.id}`);

  w = await api('GET', '/api/weights', { token });
  check('list count correct after re-log (upsert, not insert)', w.data.weights.length === before + (hadToday ? 0 : 1), `expected ${before + (hadToday ? 0 : 1)}, got ${w.data.weights.length}`);
  const todayRow = w.data.weights[w.data.weights.length - 1];
  check('latest entry is the re-logged value', Number(todayRow.value) === 69.1, `value=${todayRow.value}`);

  // 5. Goal round-trip
  const g1 = await api('GET', '/api/weights/goal', { token });
  check('GET goal 200', g1.status === 200 && 'goal' in g1.data, JSON.stringify(g1.data));
  const prevGoal = g1.data.goal;
  const g2 = await api('PUT', '/api/weights/goal', { token, body: { value: 68 } });
  check('PUT goal 200 + echoed value', g2.status === 200 && g2.data.goal === 68, JSON.stringify(g2.data));
  const g3 = await api('GET', '/api/weights/goal', { token });
  check('goal persisted', g3.data.goal === 68);
  if (prevGoal != null) {
    await api('PUT', '/api/weights/goal', { token, body: { value: prevGoal } });
    console.log('        (restored previous goal)');
  }

  // 6. Meals range (what the Progress screen's daily average uses)
  const end = new Date();
  const startD = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 365);
  const dk = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const m = await api('GET', `/api/meals?from=${dk(startD)}&to=${dk(end)}`, { token });
  check('GET /api/meals range 200', m.status === 200 && Array.isArray(m.data.meals), JSON.stringify(m.data).slice(0, 120));

  // 7. Validation + auth guards
  const bad = await api('POST', '/api/weights', { token, body: { value: 5 } });
  check('weight 5 rejected 400', bad.status === 400);
  const noauth = await api('GET', '/api/weights');
  check('weights without token → 401', noauth.status === 401);

  // 8. Delete the row we created/updated today
  const del = await api('DELETE', `/api/weights/${todayRow.id}`, { token });
  check('DELETE today row 200', del.status === 200 && del.data.deleted === true, JSON.stringify(del.data));

  // 9. Barcode lookup (OpenFoodFacts)
  const bc = await api('GET', '/api/scan/barcode/3017620422003', { token });
  check('barcode Nutella lookup 200 with kcal', bc.status === 200 && Number(bc.data.item?.kcal) > 0, JSON.stringify(bc.data).slice(0, 120));

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

main().catch(e => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
