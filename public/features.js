/* Extend the existing vanilla interface and reuse its API/error/loading helpers. */
function toggleMoreCompetitors() {
  const grid = document.getElementById('extraCompetitorsGrid');
  grid.style.display = grid.style.display === 'none' ? 'grid' : 'none';
  document.getElementById('toggleMoreCompetitorsBtn').setAttribute('aria-expanded', String(grid.style.display !== 'none'));
}

async function compareMultiSite() {
  const urls = ['url','competitorUrl','competitorUrl2','competitorUrl3','competitorUrl4']
    .map(id => document.getElementById(id).value.trim()).filter(Boolean);
  if (urls.length < 2) { showToast('Enter your site and at least one competitor.', 'error'); return; }
  showLoading('Comparing websites...', 'Each website consumes one usage unit.');
  try {
    const data = await apiFetch(`/compare-multi?${new URLSearchParams({ urls: urls.join(',') })}`);
    if (!data.success) throw new Error(data.reason || 'Comparison unavailable.');
    const card = document.getElementById('competitorCard');
    card.style.display = 'block';
    document.getElementById('comparisonDetails').innerHTML = `
      <p>${escapeHtml(data.scopeNote)}</p>
      <p>${escapeHtml(data.executiveSummary.winnerReason)}</p>
      <div class="table-scroll-wrap"><table><thead><tr><th>Metric</th>${data.labels.map(x => `<th>${escapeHtml(x)}</th>`).join('')}</tr></thead>
      <tbody>${data.dimensions.map(d => `<tr><th>${escapeHtml(d.label)}</th>${d.values.map(v => `<td>${escapeHtml(v.display)}${v.rank ? ` (#${v.rank})` : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <h4>Prioritized improvements</h4><ul>${data.executiveSummary.topActionsToBeatLeader.map(a => `<li>${escapeHtml(a.priority)}: ${escapeHtml(a.action)}</li>`).join('') || '<li>No measured deficit against the overall leader.</li>'}</ul>
      ${data.pairwiseGaps.map(g => `<details><summary>Observed gaps versus ${escapeHtml(g.url)}</summary>${['headingGaps','keywordGaps','entityGaps','schemaGaps'].map(k => `<p><strong>${escapeHtml(k)}</strong>: ${escapeHtml((g[k] || []).join(', ') || 'None observed')}</p>`).join('')}</details>`).join('')}
      ${data.executiveSummary.perSiteAnalysis.map(s => `<details><summary>${escapeHtml(s.label)}: strengths and weaknesses</summary><ul>${[...s.strengths, ...s.weaknesses].map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul></details>`).join('')}`;
    const canvas = document.getElementById('comparisonChart');
    if (typeof Chart !== 'undefined') {
      if (comparisonChart) comparisonChart.destroy();
      comparisonChart = new Chart(canvas, { type: 'bar', data: { labels: data.labels,
        datasets: data.dimensions.filter(d => ['seo','geo','aeo'].includes(d.key)).map((d,i) => ({ label: d.label, data: d.values.map(v => v.value), backgroundColor: ['#3b82f6','#8b5cf6','#10b981'][i] })) },
        options: { responsive: true, scales: { y: { beginAtZero: true, max: 100 } } } });
    }
  } catch (error) { showToast(error.message, 'error'); }
  finally { hideLoading(); }
}

async function runContentOptimizer() {
  const url = getUrlValue();
  if (!url) { showToast('Enter a website URL.', 'error'); return; }
  showLoading('Analyzing content...', 'Reusing the existing page audit engine.');
  try {
    const data = await apiFetch(`/content-optimizer?${new URLSearchParams({ url })}`);
    if (!data.success) throw new Error(data.reason || 'Content analysis unavailable.');
    const optimizer = data.contentOptimizer;
    document.getElementById('contentOptimizerCard').style.display = 'block';
    document.getElementById('contentOptimizerResults').innerHTML = `
      <p>Page-level heuristics. Readability uses English language syllable patterns. Suggestions require editorial review; no search volumes or rankings were measured.</p>
      <div class="grid-3">${Object.entries(optimizer.scores).map(([name,value]) => `<div class="metric-box"><div class="metric-value">${value ?? 'Unavailable'}</div><div class="metric-label">${escapeHtml(name)}</div></div>`).join('')}</div>
      <h4>Prioritized actions</h4><ul>${optimizer.priorityRoadmap.map(r => `<li><strong>${escapeHtml(r.priority)}: ${escapeHtml(r.item)}</strong> — ${escapeHtml(r.evidence)}</li>`).join('') || '<li>No gaps detected by these checks.</li>'}</ul>
      ${Object.entries(optimizer.suggestions).filter(([,v]) => v.length).map(([name,values]) => `<details><summary>${escapeHtml(name)}</summary><ul>${values.map(v => `<li>${escapeHtml(v)}</li>`).join('')}</ul></details>`).join('')}`;
  } catch (error) { showToast(error.message, 'error'); }
  finally { hideLoading(); }
}

function renderTechnicalMonitor(report) {
  if (!report) return;
  document.getElementById('technicalMonitorCard').style.display = 'block';
  document.getElementById('technicalMonitorResults').innerHTML = `<p>${escapeHtml(report.scopeNote)}</p>
    <p>Technical score: ${report.technicalSeoScore ?? 'Unavailable'}/100; ${report.criticalIssueCount} critical, ${report.warningCount} warnings.</p>
    ${report.issues.map(issue => `<details><summary>${escapeHtml(issue.severity)}: ${escapeHtml(issue.issueName)}</summary><p>${escapeHtml(issue.technicalExplanation)}</p><p>${escapeHtml(issue.recommendedFix)}</p></details>`).join('') || '<p>No issues found by the available checks.</p>'}`;
}

function renderPageEvidence(report) {
  const card = document.getElementById('pageEvidenceCard');
  card.style.display = report ? 'block' : 'none';
  if (!report) return;
  const locale = report.locale;
  document.getElementById('pageEvidenceResults').innerHTML = `
    <p>${escapeHtml(report.scope)}</p>
    <p>Declared language: ${escapeHtml(locale.language || 'Missing')}; document direction: ${escapeHtml(locale.direction || 'Missing')}. Script does not identify a language.</p>
    <h4>AI access policy</h4><p>${escapeHtml(report.crawlerPolicies.scope)}</p>
    <div style="overflow-x:auto"><table><thead><tr><th>Agent / token</th><th>Purpose</th><th>Declared policy</th></tr></thead><tbody>
      ${report.crawlerPolicies.bots.map(bot => `<tr><td>${escapeHtml(bot.agent)}</td><td>${escapeHtml(bot.purpose)}${bot.note ? `<br>${escapeHtml(bot.note)}` : ''}</td><td>${escapeHtml(bot.policy)}</td></tr>`).join('')}
    </tbody></table></div>
    <h4>Prioritized evidence</h4>
    ${report.findings.map(item => `<details><summary>${escapeHtml(item.priority)}: ${escapeHtml(item.check)}</summary><p>${escapeHtml(item.evidence)}</p><p>${escapeHtml(item.action)}</p></details>`).join('') || '<p>No issues found by these checks.</p>'}
    <h4>Extractable answer samples</h4><p>Observed heading/answer pairs, not measured AI citations.</p>
    ${report.answerBlocks.map(block => `<details><summary>${escapeHtml(block.heading)}</summary><p>${escapeHtml(block.excerpt)}</p><small>${escapeHtml(block.format)}</small></details>`).join('') || '<p>No adjacent answer blocks observed.</p>'}
    <h4>Language alternatives</h4><ul>${report.alternates.map(item => `<li>${escapeHtml(item.language)}: ${escapeHtml(item.url || 'Invalid URL')} (${item.valid ? 'syntax valid; target unverified' : 'invalid'})</li>`).join('') || '<li>No hreflang declarations observed. A single-language page may not need them.</li>'}</ul>`;
}

document.addEventListener('click', event => {
  const rescan = event.target.closest('[data-rescan-url]');
  if (rescan) rescanFromReport(rescan.dataset.rescanUrl);
  const project = event.target.closest('[data-project-scan]');
  if (project) scanProject(project.dataset.projectScan, project.dataset.projectUrl);
});

function projectModal() {
  let overlay = document.getElementById('projectsModalOverlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'projectsModalOverlay'; overlay.className = 'modal-overlay';
  overlay.innerHTML = '<div class="modal-panel modal-panel-wide" role="dialog" aria-modal="true" aria-label="Projects"><button type="button" class="modal-close-btn" id="projectsClose">✕</button><h3>Projects</h3><div id="projectsContent"></div></div>';
  document.body.append(overlay);
  document.getElementById('projectsClose').onclick = () => overlay.classList.remove('open');
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.classList.remove('open'); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.classList.remove('open'); });
  return overlay;
}

async function openProjectsModal() {
  if (!requireLoginOrPrompt()) return;
  projectModal().classList.add('open');
  const content = document.getElementById('projectsContent');
  content.textContent = 'Loading projects…';
  try {
    const data = await apiFetch('/projects');
    content.innerHTML = '<label>Project name<input id="newProjectName" maxlength="100"></label><label>Website URLs (one per line)<textarea id="newProjectUrls" rows="3"></textarea></label><button type="button" id="createProjectButton">Create Project</button><div id="projectList"></div>';
    document.getElementById('createProjectButton').onclick = createProject;
    const list = document.getElementById('projectList');
    data.projects.forEach(project => {
      const section = document.createElement('section');
      const heading = document.createElement('h4'); heading.textContent = project.name; section.append(heading);
      const summary = document.createElement('p'); summary.textContent = `${project.reportCount} saved reports`; section.append(summary);
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit project';
      edit.dataset.editProject = project.id; edit.onclick = () => editProject(project); section.append(edit);
      project.urls.forEach(url => {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = `Scan ${url}`;
        button.dataset.projectScan = project.id; button.dataset.projectUrl = url; section.append(button);
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete project';
      remove.onclick = async () => { if (!confirm('Delete this project? Reports will be retained.')) return;
        try { await accountRequest(`/projects/${project.id}`, 'DELETE'); await openProjectsModal(); } catch (e) { showToast(e.message, 'error'); } };
      section.append(remove); list.append(section);
    });
    if (!data.projects.length) list.textContent = 'No projects yet.';
  } catch (error) { content.textContent = error.message; }
}

function editProject(project) {
  const content = document.getElementById('projectsContent');
  content.innerHTML = '<form id="editProjectForm"><label>Project name<input id="editProjectName" maxlength="100" required></label><label>Website URLs (one per line)<textarea id="editProjectUrls" rows="4"></textarea></label><button type="submit" id="saveProjectButton">Save project</button><button type="button" id="cancelProjectEdit">Cancel</button><p id="projectEditError" role="alert"></p></form>';
  document.getElementById('editProjectName').value = project.name;
  document.getElementById('editProjectUrls').value = project.urls.join('\n');
  document.getElementById('cancelProjectEdit').onclick = openProjectsModal;
  document.getElementById('editProjectForm').onsubmit = async event => {
    event.preventDefault();
    const name = document.getElementById('editProjectName').value.trim();
    const urls = document.getElementById('editProjectUrls').value.split('\n').map(v => v.trim()).filter(Boolean);
    const button = document.getElementById('saveProjectButton'); button.disabled = true;
    try { await accountRequest(`/projects/${encodeURIComponent(project.id)}`, 'PUT', {name, urls}); await openProjectsModal(); }
    catch (error) { document.getElementById('projectEditError').textContent = error.message; button.disabled = false; }
  };
}

async function accountRequest(path, method, body) {
  const token = getStoredToken();
  const response = await fetch(`${window.API_BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Request failed.');
  return result;
}

async function createProject() {
  const name = document.getElementById('newProjectName').value.trim();
  const urls = document.getElementById('newProjectUrls').value.split('\n').map(v => v.trim()).filter(Boolean);
  try { await accountRequest('/projects', 'POST', { name, urls }); await openProjectsModal(); }
  catch (error) { showToast(error.message, 'error'); }
}

async function scanProject(id, url) {
  projectModal().classList.remove('open');
  showLoading('Scanning project URL...', 'The saved report will belong to this project.');
  try {
    const data = await apiFetch(`/scan?${new URLSearchParams({ url, projectId: id })}`);
    if (!data.success) throw new Error(data.reason || 'Scan failed.');
    lastScanData = data; renderAllResults(data); saveLocalHistory(url, data);
    showToast(data.reportId ? 'Project scan saved.' : 'Scan completed; the report could not be saved.', data.reportId ? 'success' : 'error');
  } catch (error) { showToast(error.message, 'error'); }
  finally { hideLoading(); }
}

async function requestPasswordReset() {
  const email = document.getElementById('authEmail').value.trim();
  if (!email) { showAuthError('Enter your account email first.'); return; }
  try { const data = await accountRequest('/auth/forgot-password', 'POST', {email}); showAuthError(data.message); }
  catch (error) { showAuthError(error.message); }
}

function securityForm(title, fields) {
  return new Promise(resolve => {
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay open';
    const panel = document.createElement('form'); panel.className = 'modal-panel';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal','true');
    const heading = document.createElement('h3'); heading.textContent = title; panel.append(heading);
    const inputs = {};
    for (const [key,label,type] of fields) {
      const wrapper = document.createElement('label'); wrapper.className = 'auth-form-group'; wrapper.textContent = label;
      const input = document.createElement('input'); input.type = type; input.required = true; input.maxLength = 100;
      input.autocomplete = key === 'newPassword' ? 'new-password' : type === 'password' ? 'current-password' : 'off';
      wrapper.append(input); panel.append(wrapper); inputs[key] = input;
    }
    const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = 'Continue';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    const finish = value => { overlay.remove(); resolve(value); };
    cancel.onclick = () => finish(null);
    panel.onsubmit = event => { event.preventDefault(); finish(Object.fromEntries(Object.entries(inputs).map(([k,v]) => [k,v.value]))); };
    panel.append(submit,cancel); overlay.append(panel); document.body.append(overlay);
    Object.values(inputs)[0].focus();
  });
}

async function changeAccountPassword() {
  if (!requireLoginOrPrompt()) return;
  const values = await securityForm('Change password', [['currentPassword','Current password','password'], ['newPassword','New password (8–72 UTF-8 bytes)','password']]);
  if (!values) return;
  const {currentPassword,newPassword} = values;
  try { const result = await accountRequest('/auth/change-password', 'POST', {currentPassword,newPassword}); logoutUser(true); showToast(result.message, 'success'); }
  catch (error) { showToast(error.message, 'error'); }
}

async function deleteAccount() {
  if (!requireLoginOrPrompt()) return;
  const values = await securityForm('Permanently delete account and associated data', [['confirmation','Type DELETE to confirm','text'],['password','Current password','password']]);
  if (!values || values.confirmation !== 'DELETE') return;
  const {confirmation,password} = values;
  try {
    await accountRequest('/auth/account', 'DELETE', {password,confirmation});
    localStorage.removeItem(historyStorageKey()); logoutUser(true); showToast('Account deleted.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
}

const settings = document.getElementById('settingsModalOverlay')?.querySelector('.modal-body') || document.getElementById('settingsModalOverlay')?.querySelector('.modal-panel');
if (settings) {
  const actions = document.createElement('div');
  actions.innerHTML = '<h4>Account Security</h4><button type="button" id="changePasswordAction">Change Password</button><button type="button" id="deleteAccountAction">Delete Account</button><p>Billing is disabled for this beta. Password recovery requires service-owner SMTP configuration.</p>';
  settings.append(actions);
  document.getElementById('changePasswordAction').onclick = changeAccountPassword;
  document.getElementById('deleteAccountAction').onclick = deleteAccount;
}

// Recovery secrets are in the URL fragment, which is not sent to the server.
// Remove it from the address bar before prompting or making requests.
if (location.hash.startsWith('#reset-token=')) {
  const token = location.hash.slice('#reset-token='.length);
  history.replaceState(null, '', location.pathname + location.search);
  setTimeout(async () => {
    const values = await securityForm('Reset password', [['newPassword','New password (8 characters minimum)','password']]);
    if (!values) return;
    const {newPassword} = values;
    try { const result = await accountRequest('/auth/reset-password', 'POST', {token,newPassword}); showToast(result.message, 'success'); openAuthModal('login'); }
    catch (error) { showToast(error.message, 'error'); }
  }, 0);
}
