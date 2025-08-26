const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Remote Days MVP server running on http://localhost:${PORT}`);
  console.log('Use header X-User-Id with one of:', db.users.map(u => `${u.id}(${u.role})`).join(', '));
  console.log('Demo flow:');
  console.log('1) As EMPLOYEE (U1): POST /requests {start_date,end_date,type:"SET_REMOTE"}');
  console.log('2) As MANAGER (U3):   GET /requests/team -> POST /requests/:id/approve');
  console.log('3) As EMPLOYEE (U1): GET /calendar/my -> see REMOTE day');
});/**
 * Remote Days MVP — Express backend (in-memory)
 * v0.1 — single-file server you can run immediately
 *
 * How to run:
 *   1) Ensure Node.js >= 18
 *   2) npm init -y && npm i express dayjs cors
 *   3) node server.js
 *
 * Auth (very simple for demo):
 *   - Send header:  X-User-Id: <USER_ID>
 *   - Available seeded users are listed in the logs at startup
 */

import express from 'express';
import cors from 'cors';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';

dayjs.extend(utc);
dayjs.extend(isoWeek);

// ------- In-memory data (seed) -------
const db = {
  users: [
    { id: 'U1', full_name: 'Aygun Aliyeva', email: 'aygun@company.az', role: 'EMPLOYEE', department: 'Sales', manager_id: 'U3' },
    { id: 'U2', full_name: 'Kamran Gasimov', email: 'kamran@company.az', role: 'EMPLOYEE', department: 'Sales', manager_id: 'U3' },
    { id: 'U3', full_name: 'Orkhan Mammad', email: 'orkhan@company.az', role: 'MANAGER', department: 'Sales', manager_id: null },
    { id: 'U4', full_name: 'Lala Huseyn', email: 'lala@company.az', role: 'HR', department: 'HR', manager_id: null },
  ],
  policies: [
    { id: 'P1', department: 'Sales', weekly_limit: 2, monthly_limit: 8, cutoff_hours_before: 18, required_office_days: ['MON','THU'] },
  ],
  calendar_days: [], // { id, user_id, date (YYYY-MM-DD), status: 'OFFICE'|'REMOTE'|'PTO'|'SICK'|'HOLIDAY'|'OTHER', source }
  requests: [],      // { id, user_id, start_date, end_date, type, reason, status, approver_id, approver_comment, created_at, approved_at }
  audit: [],
  seq: 1,
};

// Seed: set current week OFFICE for employees
function seedWeekOffice() {
  const start = dayjs().startOf('isoWeek');
  for (const u of db.users.filter(u => u.role === 'EMPLOYEE')) {
    for (let i = 0; i < 7; i++) {
      const d = start.add(i, 'day').format('YYYY-MM-DD');
      db.calendar_days.push({ id: `C${db.seq++}`, user_id: u.id, date: d, status: 'OFFICE', source: 'policy', last_changed_at: new Date().toISOString() });
    }
  }
}
seedWeekOffice();

// ------- Helpers -------
const app = express();
app.use(cors());
app.use(express.json());

function getUser(req) {
  const id = req.header('X-User-Id');
  const user = db.users.find(u => u.id === id);
  if (!user) throw Object.assign(new Error('Unauthorized: set X-User-Id header'), { status: 401 });
  return user;
}

function findPolicyFor(user) {
  return db.policies.find(p => p.department === user.department) || { weekly_limit: 2, monthly_limit: 8, cutoff_hours_before: 18, required_office_days: [] };
}

function* eachDate(fromYmd, toYmd) {
  let d = dayjs(fromYmd);
  const end = dayjs(toYmd);
  while (d.isBefore(end) || d.isSame(end, 'day')) {
    yield d.format('YYYY-MM-DD');
    d = d.add(1, 'day');
  }
}

function weekdayCode(ymd) {
  const dow = dayjs(ymd).isoWeekday(); // 1..7 (Mon..Sun)
  return ['MON','TUE','WED','THU','FRI','SAT','SUN'][dow-1];
}

function ensureEmployee(user) { if (user.role !== 'EMPLOYEE') throw Object.assign(new Error('Only employees can create requests'), { status: 403 }); }
function ensureManager(user) { if (user.role !== 'MANAGER') throw Object.assign(new Error('Only managers can approve/reject'), { status: 403 }); }

function isPastDate(ymd) {
  return dayjs(ymd).endOf('day').isBefore(dayjs());
}

function withinCutoff(ymd, cutoffHours) {
  const startOfDay = dayjs(ymd).startOf('day');
  const diffHours = startOfDay.diff(dayjs(), 'hour');
  return diffHours >= cutoffHours;
}

function countRemoteInWeek(user_id, ymd) {
  const d = dayjs(ymd);
  const start = d.startOf('isoWeek');
  const end = d.endOf('isoWeek');
  return db.calendar_days.filter(cd => cd.user_id === user_id && dayjs(cd.date).isBetween(start, end, 'day', '[]') && cd.status === 'REMOTE').length;
}

function countRemoteInMonth(user_id, ymd) {
  const d = dayjs(ymd);
  const start = d.startOf('month');
  const end = d.endOf('month');
  return db.calendar_days.filter(cd => cd.user_id === user_id && dayjs(cd.date).isBetween(start, end, 'day', '[]') && cd.status === 'REMOTE').length;
}

function logAudit(actor_id, entity_type, entity_id, action, old_value, new_value) {
  db.audit.push({ id: `A${db.seq++}`, actor_id, entity_type, entity_id, action, old_value, new_value, ts: new Date().toISOString() });
}

// ------- API -------

// Root helper
app.get('/', (req, res) => {
  res.send('Remote Days MVP API is running. Try /health, /me, /requests, /calendar/my');
});

app.get('/me', (req, res, next) => {
  try { const me = getUser(req); res.json(me); } catch (e) { next(e); }
});

// Create request
app.post('/requests', (req, res, next) => {
  try {
    const me = getUser(req); ensureEmployee(me);
    const { start_date, end_date, type, reason } = req.body || {};

    if (!start_date || !end_date || !type) throw Object.assign(new Error('start_date, end_date, type required'), { status: 400 });
    if (dayjs(end_date).isBefore(dayjs(start_date))) throw Object.assign(new Error('end_date must be >= start_date'), { status: 400 });

    const policy = findPolicyFor(me);

    // Validate every day in range
    for (const ymd of eachDate(start_date, end_date)) {
      if (isPastDate(ymd)) throw Object.assign(new Error(`Cannot change past date: ${ymd}`), { status: 400 });
      if (!withinCutoff(ymd, policy.cutoff_hours_before)) throw Object.assign(new Error(`Cutoff ${policy.cutoff_hours_before}h not met for ${ymd}`), { status: 400 });

      const wcode = weekdayCode(ymd);
      if (policy.required_office_days.includes(wcode) && type === 'SET_REMOTE') {
        throw Object.assign(new Error(`Required office day (${wcode})`), { status: 400 });
      }

      const weekCount = countRemoteInWeek(me.id, ymd);
      const monthCount = countRemoteInMonth(me.id, ymd);
      if (type === 'SET_REMOTE') {
        if (weekCount + 1 > policy.weekly_limit) throw Object.assign(new Error(`Weekly remote limit exceeded for ${ymd}`), { status: 400 });
        if (monthCount + 1 > policy.monthly_limit) throw Object.assign(new Error(`Monthly remote limit exceeded for ${ymd}`), { status: 400 });
      }
    }

    const reqId = `R${db.seq++}`;
    const r = { id: reqId, user_id: me.id, start_date, end_date, type, reason: reason || '', status: 'PENDING', approver_id: null, approver_comment: null, created_at: new Date().toISOString(), approved_at: null };
    db.requests.push(r);
    logAudit(me.id, 'RemoteRequest', r.id, 'CREATE', null, r);
    res.status(201).json({ id: r.id, status: r.status });
  } catch (e) { next(e); }
});

// My requests
app.get('/requests/my', (req, res, next) => {
  try {
    const me = getUser(req);
    const { status } = req.query;
    let items = db.requests.filter(r => r.user_id === me.id);
    if (status) items = items.filter(r => r.status === String(status));
    res.json(items);
  } catch (e) { next(e); }
});

// Manager: list pending of your team (bonus)
app.get('/requests/team', (req, res, next) => {
  try {
    const me = getUser(req); ensureManager(me);
    const teamIds = db.users.filter(u => u.manager_id === me.id).map(u => u.id);
    const items = db.requests.filter(r => teamIds.includes(r.user_id) && r.status === 'PENDING');
    res.json(items);
  } catch (e) { next(e); }
});

// Approve
app.post('/requests/:id/approve', (req, res, next) => {
  try {
    const me = getUser(req); ensureManager(me);
    const r = db.requests.find(x => x.id === req.params.id);
    if (!r) throw Object.assign(new Error('Request not found'), { status: 404 });

    // Manager can only approve for their team
    const isMyTeam = db.users.some(u => u.id === r.user_id && u.manager_id === me.id);
    if (!isMyTeam) throw Object.assign(new Error('Not your team request'), { status: 403 });

    if (r.status !== 'PENDING') throw Object.assign(new Error('Only PENDING can be approved'), { status: 400 });

    r.status = 'APPROVED';
    r.approver_id = me.id;
    r.approver_comment = req.body?.comment || null;
    r.approved_at = new Date().toISOString();

    // Apply to calendar
    for (const ymd of eachDate(r.start_date, r.end_date)) {
      const existing = db.calendar_days.find(cd => cd.user_id === r.user_id && cd.date === ymd);
      const old = existing ? { ...existing } : null;
      if (existing) {
        existing.status = (r.type === 'SET_REMOTE') ? 'REMOTE' : existing.status;
        existing.source = 'approved_request';
        existing.last_changed_at = new Date().toISOString();
      } else {
        db.calendar_days.push({ id: `C${db.seq++}`, user_id: r.user_id, date: ymd, status: (r.type === 'SET_REMOTE') ? 'REMOTE' : 'OFFICE', source: 'approved_request', last_changed_at: new Date().toISOString() });
      }
      logAudit(me.id, 'CalendarDay', existing?.id || 'NEW', 'UPDATE_FROM_REQUEST', old, db.calendar_days.find(cd => cd.user_id === r.user_id && cd.date === ymd));
    }

    logAudit(me.id, 'RemoteRequest', r.id, 'APPROVE', null, r);
    res.json({ status: r.status });
  } catch (e) { next(e); }
});

// Reject
app.post('/requests/:id/reject', (req, res, next) => {
  try {
    const me = getUser(req); ensureManager(me);
    const r = db.requests.find(x => x.id === req.params.id);
    if (!r) throw Object.assign(new Error('Request not found'), { status: 404 });

    const isMyTeam = db.users.some(u => u.id === r.user_id && u.manager_id === me.id);
    if (!isMyTeam) throw Object.assign(new Error('Not your team request'), { status: 403 });

    if (r.status !== 'PENDING') throw Object.assign(new Error('Only PENDING can be rejected'), { status: 400 });

    r.status = 'REJECTED';
    r.approver_id = me.id;
    r.approver_comment = req.body?.comment || null;
    logAudit(me.id, 'RemoteRequest', r.id, 'REJECT', null, r);
    res.json({ status: r.status });
  } catch (e) { next(e); }
});

// My calendar
app.get('/calendar/my', (req, res, next) => {
  try {
    const me = getUser(req);
    const from = req.query.from ? String(req.query.from) : dayjs().startOf('month').format('YYYY-MM-DD');
    const to = req.query.to ? String(req.query.to) : dayjs().endOf('month').format('YYYY-MM-DD');
    const items = db.calendar_days.filter(cd => cd.user_id === me.id && dayjs(cd.date).isBetween(dayjs(from), dayjs(to), 'day', '[]'))
      .sort((a,b)=> a.date.localeCompare(b.date));
    res.json(items);
  } catch (e) { next(e); }
});

// Health
app.get('/health', (_, res) => res.json({ ok: true }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Remote Days MVP server running on http://localhost:${PORT}`);
  console.log('Use header X-User-Id with one of:', db.users.map(u => `${u.id}(${u.role})`).join(', '));
  console.log('Demo flow:');
  console.log('1) As EMPLOYEE (U1): POST /requests {start_date,end_date,type:"SET_REMOTE"}');
  console.log('2) As MANAGER (U3):   GET /requests/team -> POST /requests/:id/approve');
  console.log('3) As EMPLOYEE (U1): GET /calendar/my -> see REMOTE day');
});
