require('dotenv').config();
process.env.CALY_TEST_INBOX = '1';
process.env.AUTH_LIMIT = '1000';
process.env.API_LIMIT = '1000';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 20) {
  process.env.JWT_SECRET = 'test-only-jwt-secret-0123456789abcdef';
}

const { req, json, assert, runSuite } = require('./helpers');

const EMAIL_A = 'caly-test-a@example.com';
const EMAIL_B = 'caly-test-b@example.com';
const EMAIL_C = 'caly-test-c@example.com';
const EMAIL_D = 'caly-test-d@example.com';
const PASSWORD = 'password-123';
const NEW_PASSWORD = 'new-password-456';

function mailer() {
  return require('../src/services/mailer');
}

// Only removes the fixed test fixtures — never touches real data.
async function cleanup() {
  const User = require('../src/models/User');
  const Meal = require('../src/models/Meal');
  const Weight = require('../src/models/Weight');
  const WeightGoal = require('../src/models/WeightGoal');
  const emails = [EMAIL_A, EMAIL_B, EMAIL_C, EMAIL_D];
  const users = await User.find({ email: { $in: emails } });
  const ids = users.map(u => u._id);
  if (ids.length) {
    await Meal.deleteMany({ userId: { $in: ids } });
    await Weight.deleteMany({ userId: { $in: ids } });
    await WeightGoal.deleteMany({ userId: { $in: ids } });
  }
  await User.deleteMany({ email: { $in: emails } });
}

function latestCode() {
  const { getTestInbox, extractCode } = mailer();
  const inbox = getTestInbox();
  const last = inbox[inbox.length - 1];
  return last ? extractCode(last.text) : null;
}

async function registerVerified(base, email, name) {
  mailer().clearTestInbox();
  await req(base, '/api/auth/register', json('POST', { name, email, password: PASSWORD }));
  const code = latestCode();
  const r = await req(base, '/api/auth/verify-email', json('POST', { email, code }));
  assert(r.status === 200 && r.body.token, `auto-verified ${email}`);
  return r.body;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

runSuite(async base => {
  try {
    await cleanup();
    const day = today();

    const health = await req(base, '/health');
    assert(health.status === 200 && health.body.db === 'up', 'health: db up');

    // --- registration + email verification ---
    mailer().clearTestInbox();
    let r = await req(base, '/api/auth/register', json('POST', { name: 'Alice Test', email: EMAIL_A, password: PASSWORD }));
    assert(r.status === 201 && r.body.requiresVerification === true, 'register -> 201 requiresVerification');
    assert(mailer().getTestInbox().length === 1, 'register sends verification email');
    assert(/^\d{6}$/.test(latestCode() || ''), 'verification email contains a 6-digit code');

    r = await req(base, '/api/auth/login', json('POST', { email: EMAIL_A, password: PASSWORD }));
    assert(r.status === 403 && r.body.needsVerification === true, 'login before verify -> 403 needsVerification');
    assert(mailer().getTestInbox().length === 2, 'unverified login re-sends the code');
    const codeA = latestCode();

    r = await req(base, '/api/auth/verify-email', json('POST', { email: EMAIL_A, code: '000000' }));
    assert(r.status === 400, 'wrong verification code -> 400');

    r = await req(base, '/api/auth/verify-email', json('POST', { email: EMAIL_A, code: codeA }));
    assert(r.status === 200 && r.body.token && r.body.user, 'correct code -> 200 {token, user}');
    assert(r.body.user.email === EMAIL_A && r.body.user.passwordHash === undefined, 'user JSON strips passwordHash');
    const tokenA = r.body.token;

    // --- session / me ---
    r = await req(base, '/api/auth/me', json('GET', null, tokenA));
    assert(r.status === 200 && r.body.user.email === EMAIL_A, 'GET /me with token -> 200');
    r = await req(base, '/api/auth/me');
    assert(r.status === 401, 'GET /me without token -> 401');
    r = await req(base, '/api/auth/me', json('GET', null, 'garbage-token'));
    assert(r.status === 401, 'GET /me with garbage token -> 401');

    r = await req(base, '/api/auth/login', json('POST', { email: EMAIL_A, password: PASSWORD }));
    assert(r.status === 200 && r.body.token, 'login after verify -> 200 token');

    // --- no user enumeration on login ---
    r = await req(base, '/api/auth/login', json('POST', { email: EMAIL_A, password: 'wrong-password' }));
    assert(r.status === 401 && r.body.error === 'invalid email or password', 'wrong password -> 401');
    r = await req(base, '/api/auth/login', json('POST', { email: 'no-such-user@example.com', password: 'x'.repeat(10) }));
    assert(r.status === 401 && r.body.error === 'invalid email or password', 'unknown email -> identical 401');

    // --- duplicates + validation ---
    r = await req(base, '/api/auth/register', json('POST', { name: 'Alice Test', email: EMAIL_A, password: PASSWORD }));
    assert(r.status === 409, 'duplicate verified email -> 409');
    r = await req(base, '/api/auth/register', json('POST', { name: 'X', email: 'not-an-email', password: PASSWORD }));
    assert(r.status === 400, 'bad email -> 400');
    r = await req(base, '/api/auth/register', json('POST', { name: 'X', email: 'x@example.com', password: 'short' }));
    assert(r.status === 400, 'short password -> 400');
    r = await req(base, '/api/auth/verify-email', json('POST', { email: EMAIL_A, code: '12ab56' }));
    assert(r.status === 400, 'malformed code -> 400');

    // --- meals are private per user ---
    r = await req(base, `/api/meals?from=${day}&to=${day}`);
    assert(r.status === 401, 'meals without token -> 401');

    const bob = await registerVerified(base, EMAIL_B, 'Bob Test');
    const tokenB = bob.token;

    r = await req(base, '/api/meals', json('POST', { name: 'Oats', kcal: 320, mealType: 'Breakfast' }, tokenA));
    assert(r.status === 201 && r.body.meal, 'user A creates a meal');
    const mealA = r.body.meal;
    r = await req(base, `/api/meals?from=${day}&to=${day}`, json('GET', null, tokenA));
    assert(r.status === 200 && r.body.meals.some(m => m.id === mealA.id), 'user A sees their own meal');

    r = await req(base, '/api/meals', json('POST', { name: 'Rice bowl', kcal: 500 }, tokenB));
    assert(r.status === 201, 'user B creates a meal');
    const mealB = r.body.meal;
    r = await req(base, `/api/meals?from=${day}&to=${day}`, json('GET', null, tokenB));
    assert(
      r.status === 200 && r.body.meals.some(m => m.id === mealB.id) && !r.body.meals.some(m => m.id === mealA.id),
      'user B only sees their own meals'
    );
    r = await req(base, `/api/meals/${mealA.id}`, json('DELETE', null, tokenB));
    assert(r.status === 404, "user B cannot delete user A's meal");
    r = await req(base, `/api/meals/${mealA.id}`, json('DELETE', null, tokenA));
    assert(r.status === 200 && r.body.deleted === true, 'user A deletes their own meal');

    // --- weights are private per user ---
    r = await req(base, '/api/weights');
    assert(r.status === 401, 'weights without token -> 401');
    r = await req(base, '/api/weights', json('POST', { value: 70.5 }, tokenA));
    assert(r.status === 201 && r.body.weight, 'user A logs a weight');
    const weightA = r.body.weight;
    r = await req(base, '/api/weights', json('POST', { value: 80.2 }, tokenB));
    assert(r.status === 201, 'user B logs a weight');
    r = await req(base, '/api/weights', json('GET', null, tokenB));
    assert(
      r.status === 200 && r.body.weights.length === 1 && r.body.weights[0].id !== weightA.id,
      'user B only sees their own weights'
    );

    // --- per-user weight goal ---
    r = await req(base, '/api/weights/goal', json('GET', null, tokenB));
    assert(r.status === 200 && r.body.goal === null, 'user B has no goal yet');
    r = await req(base, '/api/weights/goal', json('PUT', { value: 75 }, tokenA));
    assert(r.status === 200 && r.body.goal === 75, 'user A sets a goal');
    r = await req(base, '/api/weights/goal', json('GET', null, tokenB));
    assert(r.body.goal === null, "user B's goal unaffected by user A's goal");

    // --- profile goal ---
    r = await req(base, '/api/auth/profile', json('PUT', { dailyGoalKcal: 2500 }, tokenA));
    assert(r.status === 200 && r.body.user.dailyGoalKcal === 2500, 'profile goal saved');
    r = await req(base, '/api/auth/me', json('GET', null, tokenA));
    assert(r.body.user.dailyGoalKcal === 2500, 'goal persists in /me');
    r = await req(base, '/api/auth/profile', json('PUT', { dailyGoalKcal: 100 }, tokenA));
    assert(r.status === 400, 'out-of-range goal -> 400');

    // --- forgot / reset password ---
    mailer().clearTestInbox();
    r = await req(base, '/api/auth/forgot-password', json('POST', { email: 'no-such-user@example.com' }));
    assert(r.status === 200 && r.body.ok === true, 'forgot unknown email -> 200 ok (no enumeration)');
    assert(mailer().getTestInbox().length === 0, 'no email sent for unknown address');
    r = await req(base, '/api/auth/forgot-password', json('POST', { email: EMAIL_A }));
    assert(r.status === 200 && r.body.ok === true, 'forgot known email -> 200 ok');
    assert(mailer().getTestInbox().length === 1, 'reset email sent');
    const resetCode = latestCode();

    r = await req(base, '/api/auth/reset-password', json('POST', { email: EMAIL_A, code: '000000', newPassword: NEW_PASSWORD }));
    assert(r.status === 400, 'wrong reset code -> 400');
    r = await req(base, '/api/auth/reset-password', json('POST', { email: EMAIL_A, code: resetCode, newPassword: NEW_PASSWORD }));
    assert(r.status === 200 && r.body.token, 'correct reset code -> 200 token');
    const tokenA2 = r.body.token;
    r = await req(base, '/api/auth/reset-password', json('POST', { email: EMAIL_A, code: resetCode, newPassword: 'another-pass-789' }));
    assert(r.status === 400, 'reset code cannot be replayed');

    r = await req(base, '/api/auth/login', json('POST', { email: EMAIL_A, password: PASSWORD }));
    assert(r.status === 401, 'old password rejected after reset');
    r = await req(base, '/api/auth/login', json('POST', { email: EMAIL_A, password: NEW_PASSWORD }));
    assert(r.status === 200 && r.body.token, 'new password logs in');
    r = await req(base, '/api/auth/me', json('GET', null, tokenA2));
    assert(r.status === 200, 'token issued by reset works');

    // --- resend-code: no enumeration ---
    mailer().clearTestInbox();
    r = await req(base, '/api/auth/resend-code', json('POST', { email: 'no-such-user@example.com' }));
    assert(r.status === 200 && r.body.ok === true, 'resend unknown email -> 200 ok');
    assert(mailer().getTestInbox().length === 0, 'no email for unknown resend');
    r = await req(base, '/api/auth/register', json('POST', { name: 'Carol Test', email: EMAIL_C, password: PASSWORD }));
    assert(r.status === 201, 'register unverified user C');
    assert(mailer().getTestInbox().length === 1, 'register C sends one email');
    r = await req(base, '/api/auth/resend-code', json('POST', { email: EMAIL_C }));
    assert(r.status === 200 && r.body.ok === true, 'resend for unverified -> 200 ok');
    assert(mailer().getTestInbox().length === 2, 'resend sends a new code');
    r = await req(base, '/api/auth/resend-code', json('POST', { email: EMAIL_A }));
    assert(r.status === 200, 'resend for verified -> 200 ok');
    assert(mailer().getTestInbox().length === 2, 'no email when already verified');

    // --- verification attempt limit ---
    r = await req(base, '/api/auth/register', json('POST', { name: 'Dan Test', email: EMAIL_D, password: PASSWORD }));
    assert(r.status === 201, 'register unverified user D');
    for (let i = 0; i < 5; i++) {
      r = await req(base, '/api/auth/verify-email', json('POST', { email: EMAIL_D, code: '000000' }));
      assert(r.status === 400, `wrong code attempt ${i + 1} -> 400`);
    }
    r = await req(base, '/api/auth/verify-email', json('POST', { email: EMAIL_D, code: '000000' }));
    assert(r.status === 429, '6th wrong attempt -> 429');

    // --- malformed JSON parity with test-core ---
    r = await req(base, '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{{not json',
    });
    assert(r.status === 400 && r.body.error === 'Invalid JSON body', 'malformed JSON -> 400 Invalid JSON body');
  } finally {
    await cleanup();
  }
}).catch(e => { console.error(e); process.exit(1); });
