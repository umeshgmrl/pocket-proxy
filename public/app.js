const $ = id => document.getElementById(id);
let state, rules = [], requests = [], selectedId, selectedRequest, detailTab = 'response', editingId = null, activePage = 'traffic';
let events, trafficTimer, busy = false, setupWork = '', lastSetupCheck = 0;
const pageCopy = {
  traffic: ['Live traffic', 'See what’s going over the wire. Change what comes back.'],
  rules: ['Mock rules', 'Build the response you need, without touching your backend.'],
  setup: ['Connection setup', 'A local proxy. A personal certificate. You’re in control.']
};
function notice(message) { $('notice-text').textContent = message; $('notice').hidden = false; }
async function api(url, data) {
  const res = await fetch(`/api/${url}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pocket-Proxy': '1' }, body: JSON.stringify(data) });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
async function action(button, fn) {
  if (busy) return; busy = true;
  const original = button.textContent; button.disabled = true; button.textContent = 'Working…';
  try { await fn(); await refreshState(); }
  catch (error) { notice(error.message); }
  finally { busy = false; button.disabled = false; button.textContent = original; if (state) renderState(); }
}
function page(name) {
  activePage = name;
  for (const key of Object.keys(pageCopy)) $(`page-${key}`).hidden = key !== name;
  document.querySelectorAll('[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  $('page-title').textContent = pageCopy[name][0]; $('page-subtitle').textContent = pageCopy[name][1]; $('breadcrumb').textContent = pageCopy[name][0].toUpperCase();
}
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function renderState() {
  $('capture-state').replaceChildren(el('i'), document.createTextNode(state.running ? 'Capturing' : 'Paused'));
  $('capture-state').classList.toggle('on', state.running);
  $('capture-toggle').textContent = state.running ? 'Pause capture' : 'Start capture';
  $('proxy-dot').classList.toggle('green', state.running);
  $('proxy-address').textContent = `127.0.0.1:${state.proxyPort}`;
  $('system-label').textContent = state.systemProxy ? 'Mac proxy enabled' : 'Mac proxy off';
  $('quick-setup').textContent = state.systemProxy ? 'Manage ↗' : 'Configure ↗';
  $('system-toggle').textContent = state.systemProxy ? 'Stop interception' : 'Start interception…';
  $('cert-path').textContent = state.certPath;
  const chosen = [...$('services').querySelectorAll('input:checked')].map(input => input.value);
  const previouslyRendered = $('services').dataset.loaded === 'true';
  $('services').replaceChildren();
  for (const service of state.services) {
    const label = el('label', 'checkbox-label'); const input = el('input'); input.type = 'checkbox'; input.value = service;
    input.checked = state.systemProxy ? state.selectedServices.includes(service) : previouslyRendered ? chosen.includes(service) : service === 'Wi-Fi' || /Ethernet/.test(service);
    input.disabled = state.systemProxy; label.append(input, document.createTextNode(service)); $('services').append(label);
  }
  $('services').dataset.loaded = 'true';
  if (!state.services.length) $('services').append(el('p', 'fine-print', state.systemError || 'No network services found. Use manual proxy configuration.'));
  $('system-toggle').disabled = !state.systemProxy && (!state.services.length || state.httpsSetup?.phase !== 'ready');
  renderSetup();
  const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
  $('curl-example').textContent = `curl --noproxy '' --proxy http://127.0.0.1:${state.proxyPort} \\\n  --cacert ${quote(state.certPath)} \\\n  https://example.com`;
  $('rules-count').textContent = rules.filter(rule => rule.enabled).length;
}
function renderSetup() {
  const setup = state.httpsSetup || { phase: 'unchecked' };
  const ready = setup.phase === 'ready';
  $('cert-name').textContent = state.certificate?.name || '';
  $('cert-fingerprint').textContent = state.certificate?.fingerprint || '';
  $('https-step').textContent = ready ? '01 · HTTPS VERIFIED' : '01 · HTTPS SETUP';
  $('https-step').classList.toggle('verified', ready);
  $('network-step').textContent = state.systemProxy ? '02 · INTERCEPTING' : '02 · MAC PROXY';
  $('network-step').classList.toggle('verified', state.systemProxy);
  $('https-title').textContent = ready ? 'HTTPS is ready' : 'Set up HTTPS';
  $('https-message').textContent = setupWork === 'approval' ? 'Approve the macOS prompt. We’ll verify HTTPS automatically afterward.' : setupWork ? 'Testing HTTPS through the local proxy…' : setup.message;
  $('trust-cert').textContent = ready ? 'HTTPS verified ✓' : 'Set up HTTPS…';
  $('trust-cert').disabled = ready || !state.running || !!setupWork;
  $('verify-https').disabled = !state.running || !!setupWork;
  $('network-message').textContent = state.systemProxy ? 'Selected network services are routed through Pocket Proxy.' : ready ? 'Select the network you use, then start interception.' : 'Finish HTTPS setup first. Then you can start interception.';
  $('setup-progress').textContent = setupWork ? $('https-message').textContent : !state.running ? 'Capture is paused. Start capture to continue setup.' : ready && state.systemProxy ? 'Ready — HTTPS is verified and your Mac proxy is enabled.' : ready ? 'HTTPS verified. Next: select your network and start interception.' : 'Step 1 of 2 — approve this app’s HTTPS certificate.';
  if (setup.fallback) $('certificate-fallback').open = true;
}
async function checkHttps(mode = 'verify') {
  if (busy || !state?.running) return;
  const button = mode === 'https' ? $('trust-cert') : $('verify-https');
  await action(button, async () => {
    setupWork = mode === 'https' ? 'approval' : 'checking'; renderSetup();
    try {
      state.httpsSetup = await api(`setup/${mode}`, {});
      lastSetupCheck = Date.now();
    } finally { setupWork = ''; renderSetup(); }
  });
}
async function refreshState() { state = await api('status'); renderState(); }
function pretty(value) { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
async function selectRequest(id) {
  selectedId = id;
  try { const row = await api(`requests/${encodeURIComponent(id)}`); if (selectedId !== id) return; selectedRequest = row; renderDetail(); renderTraffic(); }
  catch (error) { if (selectedId === id) { selectedId = null; selectedRequest = null; renderDetail(); notice(error.message); } }
}
function renderDetail() {
  $('inspector-empty').hidden = !!selectedRequest; $('request-detail').hidden = !selectedRequest;
  if (!selectedRequest) return;
  const row = selectedRequest;
  $('detail-url').textContent = row.url;
  const badges = [el('span', 'pill', `${row.method} · ${row.status ?? (row.outcome === 'error' ? 'ERROR' : 'PENDING')}`)];
  if (row.mocked) badges.push(el('span', 'pill purple', `MOCKED · ${row.ruleName}`));
  $('detail-badges').replaceChildren(...badges);
  const headers = detailTab === 'response' ? row.responseHeaders : row.requestHeaders;
  const body = detailTab === 'response' ? row.responseBody : row.requestBody;
  $('detail-headers').replaceChildren();
  for (const [name, value] of Object.entries(headers || {})) $('detail-headers').append(el('dt', '', name), el('dd', '', Array.isArray(value) ? value.join('\n') : String(value)));
  $('detail-body').textContent = pretty(body?.text || '') || (row.error && detailTab === 'response' ? row.error : 'No body available.');
  $('body-note').textContent = body?.note || '';
}
function renderTraffic() {
  const query = $('search').value.toLowerCase(); const filter = $('traffic-filter').value;
  const visible = requests.filter(row => `${row.url} ${row.method} ${row.status || ''}`.toLowerCase().includes(query) && (filter !== 'mocked' || row.mocked) && (filter !== 'errors' || row.outcome === 'error' || row.status >= 400));
  $('traffic-empty').hidden = !!visible.length;
  if (!visible.length) {
    $('traffic-empty').querySelector('h2').textContent = requests.length ? 'No matching requests' : 'Ready when you are';
    $('traffic-empty').querySelector('p').textContent = requests.length ? 'Try a different filter or clear your search.' : 'Enable your Mac proxy in Connection setup, then make a request from your browser or app.';
  }
  const nodes = visible.map(row => {
    const button = el('button', `request-row${row.id === selectedId ? ' selected' : ''}`); button.setAttribute('aria-label', `${row.method} ${row.url}`);
    let hostname = row.url, pathname = '/'; try { const url = new URL(row.url); hostname = url.host; pathname = url.pathname + url.search; } catch {}
    const main = el('div', 'request-main'); const top = el('div', 'request-top');
    top.append(el('span', `method ${row.method.toLowerCase()}`, row.method), el('span', 'request-path', pathname));
    const host = el('span', 'request-host', hostname); if (row.mocked) { const dot = el('i', 'mock-dot'); dot.title = `Mocked: ${row.ruleName}`; host.append(dot); }
    main.append(top, host); button.append(main, el('span', `status${row.status >= 400 || row.outcome === 'error' ? ' error' : ''}`, row.status || (row.outcome === 'error' ? 'ERR' : '…')), el('span', 'time', row.duration == null ? '—' : `${row.duration} ms`));
    button.addEventListener('click', () => selectRequest(row.id)); return button;
  });
  $('requests').replaceChildren(...nodes); $('traffic-count').textContent = requests.length; $('shown-count').textContent = `${visible.length} request${visible.length === 1 ? '' : 's'}`;
}
async function refreshTraffic() {
  requests = await api('requests'); renderTraffic();
  if (selectedId && requests.some(row => row.id === selectedId)) await selectRequest(selectedId);
  else if (selectedId) { selectedId = null; selectedRequest = null; renderDetail(); }
}
async function saveRules(next) { rules = await api('rules', { rules: next }); renderRules(); renderState(); }
function renderRules() {
  $('rules-empty').hidden = !!rules.length; $('rules-count').textContent = rules.filter(rule => rule.enabled).length;
  $('rules-list').replaceChildren(...rules.map((rule, index) => {
    const card = el('article', `card rule-card${rule.enabled ? '' : ' disabled'}`);
    const info = el('div', 'rule-info'); info.append(el('h3', '', rule.name), el('p', '', `${rule.method} · ${rule.match} ${rule.pattern} → ${rule.status}${rule.delay ? ` · ${rule.delay} ms delay` : ''}`));
    const actions = el('div', 'rule-actions');
    const toggle = el('input', 'toggle'); toggle.type = 'checkbox'; toggle.checked = rule.enabled; toggle.setAttribute('aria-label', `Enable ${rule.name}`);
    toggle.addEventListener('change', () => action(toggle, async () => { try { await saveRules(rules.map(r => r.id === rule.id ? { ...r, enabled: toggle.checked } : r)); } finally { renderRules(); } }));
    const up = el('button', 'button', '↑'); up.title = 'Increase priority'; up.setAttribute('aria-label', `Increase priority of ${rule.name}`); up.disabled = index === 0;
    up.addEventListener('click', () => action(up, async () => { const next = [...rules]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; await saveRules(next); }));
    const edit = el('button', 'button', 'Edit'); edit.addEventListener('click', () => openRule(rule));
    const remove = el('button', 'button', 'Delete'); remove.addEventListener('click', () => action(remove, () => saveRules(rules.filter(r => r.id !== rule.id))));
    actions.append(toggle, up, edit, remove); card.append(el('span', 'row-number', String(index + 1).padStart(2, '0')), el('span', 'rule-icon', '◇'), info, actions); return card;
  }));
}
function openRule(rule = {}) {
  editingId = rule.id || null;
  $('rule-dialog-title').textContent = editingId ? 'Edit your response' : 'Create a response';
  $('rule-name').value = rule.name || '';
  $('rule-method').value = rule.method || 'ANY'; $('rule-match').value = rule.match || 'contains'; $('rule-pattern').value = rule.pattern || '';
  $('rule-status').value = rule.status || 200; $('rule-delay').value = rule.delay || 0;
  $('rule-body').value = rule.body ?? '{\n  "message": "Hello from Pocket Proxy"\n}';
  $('rule-headers').value = JSON.stringify(rule.headers || { 'content-type': 'application/json' }, null, 2);
  $('rule-enabled').checked = rule.enabled !== false; $('rule-error').hidden = true; $('rule-dialog').showModal(); $('rule-name').focus();
}
$('rule-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('save-rule'); button.disabled = true; $('rule-error').hidden = true;
  try {
    const rule = { ...(editingId ? { id: editingId } : {}), name: $('rule-name').value, method: $('rule-method').value, match: $('rule-match').value, pattern: $('rule-pattern').value, status: Number($('rule-status').value), delay: Number($('rule-delay').value), body: $('rule-body').value, headers: JSON.parse($('rule-headers').value), enabled: $('rule-enabled').checked };
    await saveRules(editingId ? rules.map(r => r.id === editingId ? rule : r) : [...rules, rule]); $('rule-dialog').close(); page('rules');
  } catch (error) { $('rule-error').textContent = error.message; $('rule-error').hidden = false; }
  finally { button.disabled = false; }
});
$('new-rule').onclick = () => openRule();
$('example-rule').onclick = () => openRule({ name: 'Example user profile', method: 'GET', match: 'exact', pattern: 'https://example.com/api/profile', body: '{\n  "id": 1,\n  "name": "Local Developer",\n  "plan": "personal"\n}' });
$('mock-request').onclick = () => {
  if (!selectedRequest) return;
  const row = selectedRequest;
  openRule({ name: `Mock ${row.method} response`, method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(row.method) ? row.method : 'ANY', match: 'exact', pattern: row.url, status: row.status || 200, body: row.responseBody?.text || '', headers: { 'content-type': String(row.responseHeaders?.['content-type'] || 'application/json') } });
  if (row.responseBody?.note) { $('rule-error').textContent = 'The captured body may be incomplete. Review the mock response before saving.'; $('rule-error').hidden = false; }
};
$('close-rule').onclick = () => $('rule-dialog').close();
document.querySelectorAll('[data-page]').forEach(button => button.onclick = () => page(button.dataset.page));
for (const id of ['quick-setup', 'empty-setup']) $(id).onclick = () => page('setup');
$('dismiss-notice').onclick = () => { $('notice').hidden = true; };
$('search').oninput = renderTraffic; $('traffic-filter').onchange = renderTraffic;
$('capture-toggle').onclick = async () => { await action($('capture-toggle'), () => api('capture', { enabled: !state.running })); if (state.running) await checkHttps(); };
$('clear-traffic').onclick = () => action($('clear-traffic'), async () => { await api('requests/clear', {}); await refreshTraffic(); });
$('trust-cert').onclick = () => checkHttps('https');
$('verify-https').onclick = () => checkHttps();
$('keychain-fallback').onclick = () => action($('keychain-fallback'), async () => { const result = await api('certificate/trust', {}); $('keychain-instructions').textContent = result.message; });
window.addEventListener('focus', () => { if (activePage === 'setup' && Date.now() - lastSetupCheck > 3000) checkHttps(); });
$('system-toggle').onclick = () => action($('system-toggle'), async () => { await api('system-proxy', { enabled: !state.systemProxy, services: [...$('services').querySelectorAll('input:checked')].map(input => input.value) }); });
document.querySelectorAll('[data-detail]').forEach(button => button.onclick = () => { detailTab = button.dataset.detail; document.querySelectorAll('[data-detail]').forEach(b => b.classList.toggle('active', b === button)); renderDetail(); });
async function init() {
  const token = location.hash.slice(1);
  if (token) { await api('session', { token }); history.replaceState(null, '', '/'); }
  [state, rules] = await Promise.all([api('status'), api('rules')]); renderState(); renderRules(); await refreshTraffic();
  if (!state.systemProxy) page('setup');
  checkHttps();
  events = new EventSource('/api/events');
  events.addEventListener('traffic', () => { if (!trafficTimer) trafficTimer = setTimeout(() => { trafficTimer = null; refreshTraffic().catch(error => notice(error.message)); }, 150); });
  events.addEventListener('state', () => refreshState().catch(error => notice(error.message)));
  events.addEventListener('notice', event => notice(JSON.parse(event.data).message));
  events.onerror = () => { $('capture-state').replaceChildren(el('i'), document.createTextNode('Reconnecting')); $('capture-state').classList.remove('on'); };
  events.onopen = () => { refreshState().catch(error => notice(error.message)); refreshTraffic().catch(error => notice(error.message)); };
}
init().catch(error => notice(error.message));
