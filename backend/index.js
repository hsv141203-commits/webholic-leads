require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

async function supabaseFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const { headers: extraHeaders, ...restOpts } = opts;
  const res = await fetch(url, {
    method: restOpts.method || 'GET',
    body: restOpts.body,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
  const isSingle = opts.headers?.['Accept'] === 'application/vnd.pgrst.object+json';
  if (opts.raw) return res;
  const text = await res.text();
  if (!text) return isSingle ? null : [];
  const parsed = JSON.parse(text);
  if (res.status >= 400) throw new Error(parsed.message || parsed.msg || JSON.stringify(parsed));
  return parsed;
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

function parseURL(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.replace(/\/+$/, '').split('/');
  return { url, parts };
}

async function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

async function handleAPI(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': CORS_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const { url, parts } = parseURL(req);
  const method = req.method;
  const p = parts[2];
  const id = parts[3];

  try {
    if (p === 'stats') return method === 'GET' ? await getStats(req, res) : sendJSON(res, 404, { error: 'Not found' });
    if (p === 'daily-stats') return method === 'GET' ? await getDailyStats(req, res) : sendJSON(res, 404, { error: 'Not found' });
    if (p === 'leads') {
      if (method === 'GET' && !id) return await getLeads(req, res);
      if (method === 'GET' && id) return await getLead(req, res, id);
      if (method === 'POST' && !id) return await createLead(req, res);
      if (method === 'POST' && id && parts[4] === 'generate-dm') return await generateDM(req, res, id);
      if (method === 'PATCH' && id) return await updateLead(req, res, id);
      if (method === 'DELETE' && id) return await deleteLead(req, res, id);
    }
    if (p === 'fix-countries') return method === 'POST' ? await fixCountries(req, res) : sendJSON(res, 404, { error: 'Not found' });
    if (p === 'cities') {
      if (method === 'GET') return await getCities(req, res);
      if (method === 'POST') return await addCity(req, res);
      if (method === 'PATCH' && id) return await updateCity(req, res, id);
    }
    if (p === 'leads' && id && parts[4] === 'check-wa') return await checkWA(req, res, id);
    sendJSON(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('API Error:', e);
    sendJSON(res, 500, { error: e.message });
  }
}

async function getStats(req, res) {
  const today = new Date().toISOString().slice(0, 10);
  const leads = await supabaseFetch('/leads?select=id,country,created_at,dm_sent,phone');
  const cities = await supabaseFetch('/cities?select=id,status');

  const totalLeads = leads?.length || 0;
  const pendingCities = cities?.filter(c => c.status === 'pending').length || 0;

  const byCountry = {};
  let todayLeads = 0, todayDMs = 0, todayNoPhone = 0;
  for (const l of leads || []) {
    const c = l.country || 'Unknown';
    if (!byCountry[c]) byCountry[c] = 0;
    byCountry[c]++;
    const created = (l.created_at || '').slice(0, 10);
    if (created === today) {
      todayLeads++;
      if (l.dm_sent) todayDMs++;
      const digits = (l.phone || '').replace(/\D/g, '');
      if (!digits || digits.length < 8) todayNoPhone++;
    }
  }

  sendJSON(res, 200, { totalLeads, pendingCities, byCountry, todayLeads, todayDMs, todayNoPhone });
}

async function getDailyStats(req, res) {
  const params = parseURL(req).url.searchParams;
  const dateFrom = params.get('date_from');
  const dateTo = params.get('date_to');
  const daysParam = parseInt(params.get('days')) || 14;

  let filter = '';
  if (dateFrom) filter += `&created_at=gte.${dateFrom}`;
  if (dateTo) filter += `&created_at=lte.${dateTo}T23:59:59`;

  const leads = await supabaseFetch(`/leads?select=created_at,dm_sent,phone${filter}`);
  if (!leads) return sendJSON(res, 200, { labels: [], added: [], messaged: [], noPhone: [] });

  const days = {};
  for (const l of leads || []) {
    const d = (l.created_at || '').slice(0, 10);
    if (!d) continue;
    if (!days[d]) days[d] = { added: 0, messaged: 0, noPhone: 0 };
    days[d].added++;
    if (l.dm_sent) days[d].messaged++;
    const digits = (l.phone || '').replace(/\D/g, '');
    if (!digits || digits.length < 8) days[d].noPhone++;
  }

  const sorted = Object.keys(days).sort().slice(-daysParam);
  sendJSON(res, 200, {
    labels: sorted.map(d => d.slice(5)),
    added: sorted.map(d => days[d].added),
    messaged: sorted.map(d => days[d].messaged),
    noPhone: sorted.map(d => days[d].noPhone)
  });
}

async function getLeads(req, res) {
  const params = parseURL(req).url.searchParams;
  const country = params.get('country');
  const search = params.get('search');
  const dateFrom = params.get('date_from');
  const dateTo = params.get('date_to');
  const page = parseInt(params.get('page')) || 1;
  const limit = parseInt(params.get('limit')) || 50;

  let filter = '';
  if (country) filter += `&country=eq.${country}`;
  if (search) filter += `&or=(business_name.ilike.*${search}*,phone.ilike.*${search}*,city.ilike.*${search}*)`;
  if (dateFrom) filter += `&created_at=gte.${dateFrom}`;
  if (dateTo) filter += `&created_at=lte.${dateTo}T23:59:59`;

  const rangeEnd = page * limit - 1;
  const rangeStart = rangeEnd - limit + 1;
  const path = `/leads?select=*${filter}&order=id.desc`;
  const headers = { 'Range-Unit': 'items', 'Range': `${rangeStart}-${rangeEnd}`, 'Prefer': 'count=exact' };
  const res_ = await supabaseFetch(path, { headers, raw: true });
  const data = await res_.json();
  const cr = res_.headers.get('content-range');
  const total = cr ? parseInt(cr.split('/')[1]) : data.length;
  sendJSON(res, 200, { data, total, page, limit });
}

async function getLead(req, res, id) {
  const data = await supabaseFetch(`/leads?id=eq.${id}&select=*`, { headers: { 'Accept': 'application/vnd.pgrst.object+json' } });
  if (!data) return sendJSON(res, 404, { error: 'Not found' });
  sendJSON(res, 200, data);
}

async function createLead(req, res) {
  const body = await getBody(req);
  if (!body.business_name || !body.phone) return sendJSON(res, 400, { error: 'business_name and phone are required' });
  const data = await supabaseFetch('/leads', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify([{
      business_name: body.business_name,
      country: body.country || '',
      city: body.city || '',
      phone: body.phone,
      website: body.website || '',
      rating: body.rating ? parseFloat(body.rating) : null,
      reviews: parseInt(body.reviews) || 0,
      maps_url: body.maps_url || ''
    }])
  });
  sendJSON(res, 201, data?.[0] || data);
}

async function updateLead(req, res, id) {
  const body = await getBody(req);
  const allowed = ['business_name', 'phone', 'website', 'rating', 'reviews', 'dm_sent', 'reply_status'];
  const updates = {};
  for (const key of allowed) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  await supabaseFetch(`/leads?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates)
  });
  sendJSON(res, 200, { success: true });
}

async function deleteLead(req, res, id) {
  await supabaseFetch(`/leads?id=eq.${id}`, { method: 'DELETE' });
  sendJSON(res, 200, { success: true });
}

async function getCities(req, res) {
  const country = parseURL(req).url.searchParams.get('country');
  let filter = '';
  if (country) filter += `&country=eq.${country}`;
  const statusParam = parseURL(req).url.searchParams.get('status');
  if (statusParam) filter += `&status=eq.${statusParam}`;
  const data = await supabaseFetch(`/cities?select=*${filter}&order=id`);
  sendJSON(res, 200, data);
}

async function addCity(req, res) {
  const body = await getBody(req);
  if (!body.country || !body.city) return sendJSON(res, 400, { error: 'country and city are required' });
  const data = await supabaseFetch('/cities', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify([{ country: body.country, city: body.city, status: 'pending' }])
  });
  sendJSON(res, 201, data?.[0] || data);
}

async function updateCity(req, res, id) {
  const body = await getBody(req);
  await supabaseFetch(`/cities?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: body.status }) });
  sendJSON(res, 200, { success: true });
}

async function fixCountries(req, res) {
  const leads = await supabaseFetch('/leads?select=id,phone,country');
  if (!leads || !leads.length) return sendJSON(res, 200, { fixed: 0 });
  let fixed = 0;
  for (const lead of leads) {
    const phone = lead.phone || '';
    let correct = lead.country;
    if (/^\+?65/.test(phone)) correct = 'Singapore';
    else if (/^\+?971/.test(phone)) correct = 'UAE';
    else if (/^\+?91/.test(phone)) correct = 'India';
    else if (/^\+?1\d{10}/.test(phone)) correct = 'USA';
    else if (phone.startsWith('0') && (lead.country === 'India' || lead.country === 'UAE')) continue;
    if (correct !== lead.country) {
      await supabaseFetch(`/leads?id=eq.${lead.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ country: correct })
      });
      fixed++;
    }
  }
  sendJSON(res, 200, { fixed, total: leads.length });
}

async function checkWA(req, res, id) {
  const lead = await supabaseFetch(`/leads?id=eq.${id}&select=phone`, {
    headers: { 'Accept': 'application/vnd.pgrst.object+json' }
  });
  if (!lead) return sendJSON(res, 404, { error: 'Lead not found' });

  const digits = (lead.phone || '').replace(/\D/g, '');
  const valid = digits.length >= 10 && digits.length <= 15;

  sendJSON(res, 200, {
    exists: 'unknown',
    valid,
    phone: digits,
    wa_link: digits ? `https://wa.me/${digits}` : null,
    message: !digits
      ? 'No phone number available for this lead.'
      : valid
        ? 'Number format valid. Open WhatsApp to verify.'
        : `Phone number seems incomplete (${digits.length} digits). Opening WhatsApp anyway — you decide.`
  });
}

async function generateDM(req, res, id) {
  const lead = await supabaseFetch(`/leads?id=eq.${id}&select=business_name,city,country,phone`, {
    headers: { 'Accept': 'application/vnd.pgrst.object+json' }
  });
  if (!lead) return sendJSON(res, 404, { error: 'Lead not found' });

  const name = lead.business_name || 'there';
  const city = lead.city || 'your area';

  const templates = [
    `Hey ${name}, love your spot in ${city} — your reviews are solid!\nI noticed you don't have a website yet, and that's costing you walk-ins.\nI build restaurant websites and have already delivered 3 — rajamilitaryhotel.com, hbhuae.com, thenewsai.in.\nWould love to build one for ${name} too. Looking forward to your reply!`,

    `Hi ${name}, your place in ${city} looks great — great ratings!\nBut no website means customers can't find you online.\nI specialise in restaurant websites and have delivered rajamilitaryhotel.com, hbhuae.com, thenewsai.in.\nHappy to do the same for ${name}. Looking forward to your reply!`,

    `Hey ${name} in ${city}, big fan of what you're doing!\nOne thing though — without a website you're losing customers to competitors.\nI've built websites for restaurants like rajamilitaryhotel.com, hbhuae.com, thenewsai.in.\nLet me know if you'd like one for ${name}. Looking forward to your reply!`,

    `${name} in ${city} — your food looks amazing!\nNo website is a missed opportunity for more orders.\nI've already delivered 3 restaurant sites: rajamilitaryhotel.com, hbhuae.com, thenewsai.in.\nI'd love to build one for ${name}. Looking forward to your reply!`,

    `Hey ${name}, saw your place in ${city} and the reviews are impressive!\nWithout a website, you're missing out on a lot of online traffic.\nI build restaurant websites and have delivered rajamilitaryhotel.com, hbhuae.com, thenewsai.in.\nLet's chat about ${name}. Looking forward to your reply!`
  ];
  const message = templates[Math.floor(Math.random() * templates.length)];
  sendJSON(res, 200, { message, phone: lead.phone });
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) return handleAPI(req, res).catch(e => {
    console.error('Unhandled API error:', e);
    sendJSON(res, 500, { error: 'Internal error' });
  });
  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`);
});
