(function () {
  const state = { projects: [], projectId: '', performance: null, reports: [], reportsLoaded: false,
    comparison: null, tab: 'performance', busy: false, error: '', status: '', epoch: 0, projectRequest: 0,
    exportCursor: null, exportCount: null, exportMore: false, exportResource: 'projects', sourceMode: 'csv',
    googleStatus: null, googleProperties: [] };
  let previousFocus = null;
  const byId = id => document.getElementById(id);
  const e = value => escapeHtml(String(value ?? ''));
  function t(key, params = {}) {
    const locale = window.ReportLanguage?.get() || 'en';
    const copy = window.FreeWorkflowCopy[locale] || window.FreeWorkflowCopy.en;
    const value = Object.hasOwn(copy, key) ? copy[key] : Object.hasOwn(window.FreeWorkflowCopy.en, key)
      ? window.FreeWorkflowCopy.en[key] : window.ReportLanguage?.t(key, params) || key;
    return String(value).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
  }
  const label = key => `<span data-workflow-i18n="${key}">${e(t(key))}</span>`;
  const number = (value, percent = false, sign = false) => typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(window.ReportLanguage?.get() || 'en', { maximumFractionDigits: 2,
      ...(percent ? { style: 'percent' } : {}), ...(sign ? { signDisplay: 'exceptZero' } : {}) }).format(value) : t('unavailable');
  const date = value => value ? new Intl.DateTimeFormat(window.ReportLanguage?.get() || 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : t('unavailable');
  function showError(error) { state.error = error?.code || error?.payload?.code || 'featureRequestFailed'; localize(); }
  function setBusy(value) {
    state.busy = value;
    byId('growthModalOverlay')?.querySelectorAll('input,select,button:not(.modal-close-btn)').forEach(el => { el.disabled = value; });
    if (!value && byId('growthNextExport')) byId('growthNextExport').disabled = !state.exportCursor;
    renderGoogle();
    if (byId('growthStatus')) byId('growthStatus').textContent = value ? t('working') : state.status ? t(state.status) : '';
  }
  async function request(path, method = 'GET', body) {
    const token = getStoredToken();
    let response, data;
    try {
      response = await fetch(`${window.API_BASE}${path}`, { method, headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {})
      }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(path.includes('/integrations/gsc') || path.endsWith('/search-performance/google') ? 60000 : 30000) });
      data = await response.json();
    } catch { throw { code: 'featureRequestFailed' }; }
    if (!response.ok || data?.success !== true) throw { code: data?.code || 'featureRequestFailed' };
    return data;
  }

  function modal() {
    if (byId('growthModalOverlay')) return byId('growthModalOverlay');
    const overlay = document.createElement('div');
    overlay.id = 'growthModalOverlay'; overlay.className = 'modal-overlay';
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-labelledby', 'growthTitle');
    overlay.innerHTML = `<div class="modal-panel modal-panel-xl workflow-panel">
      <div class="modal-header"><h2 id="growthTitle">${label('growth')}</h2><label class="workflow-language">${label('language')}<select id="growthLanguage"><option value="en">English</option><option value="ur">اردو</option><option value="ps">پښتو</option><option value="ar">العربية</option></select></label><button type="button" class="modal-close-btn" id="growthClose" aria-label="${e(t('close'))}">✕</button></div>
      <div class="workflow-tabs" role="tablist">
        ${['performance', 'comparison', 'export'].map((tab, index) => `<button type="button" id="growthTab-${tab}" role="tab" data-growth-tab="${tab}" aria-controls="growthPane-${tab}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${label(tab === 'performance' ? 'performanceTab' : tab === 'comparison' ? 'comparisonTab' : 'exportTab')}</button>`).join('')}
      </div>
      <p id="growthError" class="workflow-error" role="alert"></p><p id="growthStatus" role="status" aria-live="polite"></p>
      <section id="growthPane-performance" role="tabpanel" aria-labelledby="growthTab-performance">
        <label class="workflow-project">${label('project')}<select id="growthProject"></select></label>
        <p id="growthNoProjects" hidden>${label('noProjects')} <button type="button" id="growthCreateProject">${label('createProject')}</button></p>
        <div class="workflow-source" role="group" aria-label="${e(t('gscDataSource'))}">
          <label><input type="radio" name="growthSource" value="csv" checked>${label('gscCsvMode')}</label>
          <label><input type="radio" name="growthSource" value="google">Google Search Console</label>
        </div>
        <section id="growthGoogle" class="workflow-section" hidden>
          <h3>Google Search Console</h3><p id="growthGoogleStatus" role="status"></p>
          <div class="workflow-toolbar"><button type="button" id="growthGoogleConnect">${label('gscConnect')}</button>
          <button type="button" id="growthGoogleProperties" class="workflow-secondary">${label('gscLoadProperties')}</button>
          <button type="button" id="growthGoogleDisconnect" class="workflow-secondary">${label('gscDisconnect')}</button></div>
          <p class="workflow-note">${label('gscReadOnly')}</p>
          <div id="growthGoogleSelection" class="workflow-form-grid" hidden>
            <label>${label('gscProperty')}<select id="growthGoogleProperty"></select></label>
            <label>${label('gscDimension')}<select id="growthGoogleKind"><option value="queries" data-workflow-i18n="gscQueries">${e(t('gscQueries'))}</option><option value="pages" data-workflow-i18n="gscPages">${e(t('gscPages'))}</option></select></label>
          </div><p class="workflow-note">${label('gscDatesNotice')}</p>
        </section>
        <form id="growthImportForm" class="workflow-form">
          <div class="workflow-form-grid">
            <label>${label('slot')}<select id="growthSlot"><option value="current" data-workflow-i18n="current">${e(t('current'))}</option><option value="baseline" data-workflow-i18n="baseline">${e(t('baseline'))}</option></select></label>
            <label>${label('start')}<input type="date" id="growthStart" required></label>
            <label>${label('end')}<input type="date" id="growthEnd" required></label>
            <label>${label('device')}<select id="growthDevice">${['all', 'mobile', 'desktop', 'tablet'].map(value => `<option value="${value}" data-workflow-i18n="${value}">${e(t(value))}</option>`).join('')}</select></label>
            <label>${label('country')}<input id="growthCountry" maxlength="3" value="all" dir="ltr"></label>
          </div>
          <label class="workflow-file" id="growthCsvLabel">${label('csv')}<input id="growthCsv" type="file" accept=".csv,text/csv" required></label>
          <div class="workflow-toolbar"><button type="submit" id="growthImportButton">${label('importCsv')}</button><button type="button" id="growthClearButton" class="workflow-secondary">${label('clearImports')}</button></div>
        </form>
        <div id="growthPerformanceResults"></div>
      </section>
      <section id="growthPane-comparison" role="tabpanel" aria-labelledby="growthTab-comparison" hidden>
        <p>${label('compareNotice')}</p>
        <div class="workflow-form-grid"><label>${label('before')}<select id="growthBefore"></select></label><label>${label('after')}<select id="growthAfter"></select></label></div>
        <button type="button" id="growthCompare">${label('compare')}</button><div id="growthComparisonResults"></div>
      </section>
      <section id="growthPane-export" role="tabpanel" aria-labelledby="growthTab-export" hidden>
        <p>${label('exportNotice')}</p><label>${label('exportResource')}<select id="growthExportType"><option value="projects" data-workflow-i18n="projects">${e(t('projects'))}</option><option value="reports" data-workflow-i18n="reports">${e(t('reports'))}</option></select></label>
        <div class="workflow-toolbar"><button type="button" id="growthExportButton">${label('download')}</button><button type="button" id="growthNextExport" class="workflow-secondary" disabled>${label('nextBatch')}</button></div><p id="growthExportStatus" role="status"></p>
      </section>
    </div>`;
    document.body.append(overlay);
    byId('growthClose').onclick = close;
    byId('growthLanguage').value = window.ReportLanguage.get();
    byId('growthLanguage').onchange = () => window.ReportLanguage.set(byId('growthLanguage').value);
    overlay.onclick = event => { if (event.target === overlay) close(); };
    overlay.querySelectorAll('[data-growth-tab]').forEach(button => { button.onclick = () => switchTab(button.dataset.growthTab); });
    overlay.querySelector('[role="tablist"]').onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = [...overlay.querySelectorAll('[role="tab"]')];
      let index = tabs.indexOf(document.activeElement);
      index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault(); tabs[index].focus(); void switchTab(tabs[index].dataset.growthTab);
    };
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const focusable = [...overlay.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    byId('growthProject').onchange = () => { state.projectId = byId('growthProject').value; void loadPerformance(); };
    byId('growthCreateProject').onclick = () => { close(); void openProjectsModal(); };
    byId('growthImportForm').onsubmit = importCsv;
    byId('growthClearButton').onclick = clearImports;
    byId('growthCompare').onclick = compare;
    overlay.querySelectorAll('[name="growthSource"]').forEach(input => { input.onchange = () => { state.sourceMode = input.value; renderGoogle(); }; });
    byId('growthGoogleConnect').onclick = connectGoogle;
    byId('growthGoogleProperties').onclick = loadGoogleProperties;
    byId('growthGoogleDisconnect').onclick = disconnectGoogle;
    for (const id of ['growthBefore', 'growthAfter']) byId(id).onchange = () => { state.comparison = null; renderComparison(); };
    byId('growthExportType').onchange = () => { state.exportCursor = null; state.exportCount = null; state.exportResource = byId('growthExportType').value; byId('growthNextExport').disabled = true; localize(); };
    byId('growthExportButton').onclick = () => downloadExport(null);
    byId('growthNextExport').onclick = () => downloadExport(state.exportCursor);
    return overlay;
  }

  function close() { byId('growthModalOverlay')?.classList.remove('open'); previousFocus?.focus?.(); }
  window.openGrowthModal = async function openGrowthModal() {
    if (!requireLoginOrPrompt()) return;
    previousFocus = document.activeElement;
    document.querySelectorAll('.modal-overlay.open').forEach(el => el.classList.remove('open'));
    modal().classList.add('open'); byId('growthClose').focus();
    state.error = ''; state.status = ''; state.reportsLoaded = false;
    const epoch = state.epoch;
    setBusy(true);
    try {
      const data = await request('/projects');
      if (epoch !== state.epoch) return;
      state.projects = data.projects;
      if (!state.projects.some(project => project.id === state.projectId)) state.projectId = state.projects[0]?.id || '';
      byId('growthProject').innerHTML = state.projects.map(project => `<option value="${e(project.id)}">${e(project.name)}</option>`).join('');
      byId('growthProject').value = state.projectId;
      byId('growthNoProjects').hidden = Boolean(state.projects.length);
      byId('growthImportForm').hidden = !state.projects.length;
      if (state.tab === 'performance') await loadPerformance();
      else if (state.tab === 'comparison') await loadReports();
      if (epoch !== state.epoch) return;
      await loadGoogleStatus();
      localize();
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  };

  async function switchTab(tab) {
    if (state.busy || !['performance', 'comparison', 'export'].includes(tab)) return;
    state.tab = tab; state.error = ''; state.status = '';
    for (const value of ['performance', 'comparison', 'export']) {
      byId(`growthPane-${value}`).hidden = value !== tab;
      byId(`growthTab-${value}`).setAttribute('aria-selected', String(value === tab));
      byId(`growthTab-${value}`).tabIndex = value === tab ? 0 : -1;
    }
    if (tab === 'performance') await loadPerformance();
    if (tab === 'comparison' && !state.reportsLoaded) await loadReports();
    localize();
  }
  async function loadPerformance() {
    state.performance = null; state.error = ''; state.status = '';
    renderPerformance();
    if (!state.projectId) return;
    const projectId = state.projectId, sequence = ++state.projectRequest, epoch = state.epoch;
    setBusy(true);
    try {
      const data = await request(`/projects/${encodeURIComponent(projectId)}/search-performance`);
      if (sequence === state.projectRequest && epoch === state.epoch) { state.performance = data.performance; renderPerformance(); }
    } catch (error) { if (sequence === state.projectRequest && epoch === state.epoch) showError(error); }
    finally { if (sequence === state.projectRequest && epoch === state.epoch) setBusy(false); }
  }
  async function importCsv(event) {
    event.preventDefault();
    if (state.busy) return;
    if (state.sourceMode === 'google') return pullGoogle();
    if (!state.projectId) return showError({ code: 'selectProject' });
    const file = byId('growthCsv').files[0];
    if (!file) return showError({ code: 'selectFile' });
    if (file.size > 512 * 1024) return showError({ code: 'importTooLarge' });
    const epoch = state.epoch, projectId = state.projectId;
    state.error = ''; state.status = ''; setBusy(true);
    try {
      const body = { csv: await file.text(), slot: byId('growthSlot').value, start: byId('growthStart').value,
        end: byId('growthEnd').value, device: byId('growthDevice').value, country: byId('growthCountry').value };
      if (epoch !== state.epoch) return;
      const data = await request(`/projects/${encodeURIComponent(projectId)}/search-performance`, 'POST', body);
      if (epoch !== state.epoch) return;
      state.performance = data.performance; state.status = 'importSaved'; byId('growthCsv').value = ''; renderPerformance();
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  async function clearImports() {
    if (state.busy || !state.projectId || !confirm(t('clearConfirm'))) return;
    const epoch = state.epoch;
    state.error = ''; setBusy(true);
    try {
      const data = await request(`/projects/${encodeURIComponent(state.projectId)}/search-performance`, 'DELETE');
      if (epoch === state.epoch) { state.performance = data.performance; renderPerformance(); }
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }

  function metric(name, value, percent = false, sign = false) { return `<div><dt>${e(t(name))}</dt><dd dir="auto">${e(number(value, percent, sign))}</dd></div>`; }
  function renderPerformance() {
    const output = byId('growthPerformanceResults'); if (!output) return;
    const data = state.performance;
    if (!data || !data.current && !data.baseline) { output.innerHTML = `<p>${e(t('noImports'))}</p>`; return; }
    const summary = (key, snapshot) => !snapshot ? '' : `<section class="workflow-section"><h3>${e(t(key))}: <bdi>${e(snapshot.period.start)} – ${e(snapshot.period.end)}</bdi></h3>
      <p class="workflow-note">${e(t(snapshot.source === 'google-search-console-api' ? 'gscSourceNotice' : 'sourceNotice'))}${snapshot.scope.property ? ` <bdi>${e(snapshot.scope.property)}</bdi>` : ''}</p>
      <p>${e(t('rows'))}: ${number(snapshot.rowCount)} · ${e(t(snapshot.scope.device))} · <bdi>${e(snapshot.scope.country)}</bdi></p>
      <dl class="workflow-metrics">${metric('clicks', snapshot.totals.clicks)}${metric('impressions', snapshot.totals.impressions)}${metric('ctr', snapshot.totals.ctr, true)}${metric('position', snapshot.totals.position)}</dl></section>`;
    output.innerHTML = `<p class="workflow-note">${e(t('coverageNotice'))}</p>
      ${summary('baseline', data.baseline)}${summary('current', data.current)}
      ${data.comparisonReason ? `<p role="status">${e(t(data.comparisonReason))}</p>` : ''}
      ${data.comparison ? `<section class="workflow-section"><h3>${e(t('delta'))}</h3><dl class="workflow-metrics">${metric('clicksChange', data.comparison.clicksPerDayDelta, false, true)}${metric('impressionsPerDay', data.comparison.impressionsPerDayDelta, false, true)}${metric('ctrChange', data.comparison.ctrDelta, true, true)}${metric('positionChange', data.comparison.positionDelta, false, true)}</dl><p>${e(t('unmatched', data.unmatched))}</p></section>` : ''}
      ${data.current ? `<section class="workflow-section"><h3>${e(t('opportunities'))}</h3><p class="workflow-note">${e(t('estimateNotice'))}</p>
      ${data.opportunities.length ? `<div class="table-scroll-wrap"><table><thead><tr><th>${e(t('rowKey'))}</th><th>${e(t('observations'))}</th><th>${e(t('actions'))}</th></tr></thead><tbody>
      ${data.opportunities.map(item => `<tr><td dir="auto">${e(item.key)}</td><td><dl class="workflow-evidence"><dt>${e(t('clicks'))}</dt><dd>${e(number(item.evidence.clicks))}</dd><dt>${e(t('impressions'))}</dt><dd>${e(number(item.evidence.impressions))}</dd><dt>${e(t('position'))}</dt><dd>${e(number(item.evidence.position))}</dd>
      ${item.evidence.benchmarkCtr != null ? `<dt>${e(t('ctr'))}</dt><dd>${e(number(item.evidence.ctr, true))}</dd><dt>${e(t('peerBenchmark'))}</dt><dd>${e(number(item.evidence.benchmarkCtr, true))}</dd><dt>${e(t('peers'))}</dt><dd>${e(number(item.evidence.peerCount))}</dd>` : ''}
      ${item.evidence.clicksPerDayDelta != null ? `<dt>${e(t('previousClicks'))}</dt><dd>${e(number(item.evidence.beforeClicks))}</dd><dt>${e(t('clicksChange'))}</dt><dd>${e(number(item.evidence.clicksPerDayDelta, false, true))}</dd>` : ''}</dl></td>
      <td><strong>${e(t(item.priority))} · ${e(t(item.basis === 'heuristic' ? 'heuristic' : 'observedChange'))}</strong><p>${e(t(item.code, { key: item.key }))}</p>${item.estimatedAdditionalClicks != null ? `<p>${e(t('additionalClicks'))}: ${e(number(item.estimatedAdditionalClicks))}</p>` : ''}</td></tr>`).join('')}</tbody></table></div>` : `<p>${e(t('noOpportunities'))}</p>`}</section>` : ''}`;
  }
  async function loadReports() {
    const epoch = state.epoch; setBusy(true);
    try {
      const data = await request('/reports?limit=100');
      if (epoch !== state.epoch) return;
      state.reports = data.reports.filter(report => report.snapshotStatus === 'complete'); state.reportsLoaded = true; renderReportOptions();
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  function renderReportOptions() {
    for (const id of ['growthBefore', 'growthAfter']) {
      const select = byId(id); if (!select) continue;
      const selected = select.value;
      select.innerHTML = `<option value="">${e(t(state.reports.length ? 'chooseReport' : 'noReports'))}</option>` + state.reports.map(report => `<option value="${e(report.id)}">${e(date(report.scanDate))} · ${e((report.title || report.url).slice(0, 100))}</option>`).join('');
      select.value = selected;
    }
  }
  async function compare() {
    if (state.busy) return;
    const before = byId('growthBefore').value, after = byId('growthAfter').value;
    if (!before || !after) return showError({ code: 'invalidReportSelection' });
    const epoch = state.epoch; state.error = ''; setBusy(true);
    try {
      const data = await request(`/reports/compare?${new URLSearchParams({ before, after })}`);
      if (epoch === state.epoch) { state.comparison = data.comparison; renderComparison(); }
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  function renderComparison() {
    const output = byId('growthComparisonResults'); if (!output) return;
    const data = state.comparison; if (!data) { output.innerHTML = ''; return; }
    const observation = value => value == null ? t('unavailable') : String(value);
    const findings = (key, items) => `<h3>${e(t(key))}</h3>${items.length ? `<ul>${items.map(item => `<li>${e(window.ReportLanguage.t(item.code, item.params))}<blockquote dir="auto">${e(item.evidence?.observed)}</blockquote></li>`).join('')}</ul>` : `<p>${e(t('noChanges'))}</p>`}`;
    output.innerHTML = `<section class="workflow-section"><p dir="auto">${e(data.url)}</p>
      <p>${e(t('before'))}: ${e(date(data.before.savedAt))} · ${e(t('after'))}: ${e(date(data.after.savedAt))}</p>
      ${!data.before.observedAt || !data.after.observedAt ? `<p class="workflow-note">${e(t('unknownObservation'))}</p>` : `<p>${e(t('observedAt'))}: ${e(date(data.before.observedAt))} → ${e(date(data.after.observedAt))}</p>`}
      ${!data.comparable ? `<p role="status">${e(t('methodMismatch'))}</p>` : ''}
      <div class="table-scroll-wrap"><table><thead><tr><th>${e(t('score'))}</th><th>${e(t('before'))}</th><th>${e(t('after'))}</th><th>${e(t('delta'))}</th></tr></thead><tbody>${data.scores.map(score => `<tr><td>${e(t(score.key))}</td><td>${e(number(score.before))}</td><td>${e(number(score.after))}</td><td>${e(number(score.delta, false, true))}</td></tr>`).join('')}</tbody></table></div>
      <h3>${e(t('observations'))}</h3>${data.observations.length ? `<div class="table-scroll-wrap"><table><thead><tr><th>${e(t('observations'))}</th><th>${e(t('before'))}</th><th>${e(t('after'))}</th></tr></thead><tbody>${data.observations.map(item => `<tr><td>${e(t(item.field))}</td><td dir="auto">${e(observation(item.before))}</td><td dir="auto">${e(observation(item.after))}</td></tr>`).join('')}</tbody></table></div>` : `<p>${e(t('noChanges'))}</p>`}
      ${data.findingsAvailable ? findings('resolved', data.resolved) + findings('added', data.added) : ''}</section>`;
  }
  async function downloadExport(cursor) {
    if (state.busy) return;
    const epoch = state.epoch; state.error = ''; setBusy(true);
    try {
      const query = new URLSearchParams({ resource: byId('growthExportType').value, ...(cursor ? { cursor } : {}) });
      const data = await request(`/account/export?${query}`);
      if (epoch !== state.epoch) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `aegis-${data.resource}-${new Date().toISOString().slice(0, 10)}${cursor ? '-next' : ''}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      state.exportCursor = data.nextCursor; state.exportCount = data.items.length; state.exportMore = Boolean(data.nextCursor); localize();
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  function localize() {
    const overlay = byId('growthModalOverlay'); if (!overlay) return;
    overlay.querySelectorAll('[data-workflow-i18n]').forEach(el => { el.textContent = t(el.dataset.workflowI18n); });
    byId('growthClose').setAttribute('aria-label', t('close'));
    byId('growthLanguage').value = window.ReportLanguage.get();
    byId('growthError').textContent = state.error ? t(state.error) : '';
    byId('growthStatus').textContent = state.busy ? t('working') : state.status ? t(state.status) : '';
    byId('growthExportStatus').textContent = state.exportCount === null ? '' : t(state.exportMore ? 'exportMore' : 'exportDone', { count: state.exportCount });
    renderPerformance(); renderComparison(); renderReportOptions(); renderGoogle();
  }
  function renderGoogle() {
    if (!byId('growthGoogle')) return;
    const google = state.sourceMode === 'google', connected = state.googleStatus?.connected === true;
    const configured = state.googleStatus?.configured === true;
    byId('growthGoogle').hidden = !google;
    byId('growthCsvLabel').hidden = google; byId('growthCsv').required = !google;
    byId('growthImportButton').textContent = t(google ? 'gscPull' : 'importCsv');
    byId('growthImportButton').disabled = state.busy || google && (!connected || !configured);
    byId('growthGoogleStatus').textContent = t(!configured ? 'gscNotConfigured' : connected ? 'gscConnected' : 'gscDisconnected');
    byId('growthGoogleConnect').disabled = state.busy || !configured;
    byId('growthGoogleProperties').disabled = state.busy || !configured || !connected;
    byId('growthGoogleDisconnect').disabled = state.busy || !connected;
    byId('growthGoogleSelection').hidden = !connected || !configured;
    const select = byId('growthGoogleProperty'), selected = select.value;
    select.innerHTML = `<option value="">${e(t(state.googleProperties.length ? 'gscChooseProperty' : 'gscNoProperties'))}</option>`
      + state.googleProperties.map(site => `<option value="${e(site.siteUrl)}">${e(site.siteUrl)}</option>`).join('');
    select.value = selected;
    byId('growthGoogle').closest('[role="tabpanel"]')?.querySelector('[role="group"]')?.setAttribute('aria-label', t('gscDataSource'));
  }
  async function loadGoogleStatus() {
    const epoch = state.epoch;
    try {
      const data = await request('/integrations/gsc/status');
      if (epoch !== state.epoch) return;
      state.googleStatus = { configured: data.configured === true, connected: data.connected === true };
      if (!data.connected) state.googleProperties = [];
      renderGoogle();
    } catch (error) { if (epoch === state.epoch) showError(error); }
  }
  async function connectGoogle() {
    if (state.busy) return;
    const epoch = state.epoch; state.error = ''; setBusy(true);
    try {
      const data = await request('/integrations/gsc/start', 'POST', {});
      if (epoch !== state.epoch) return;
      const url = new URL(data.authorizationUrl);
      if (url.origin !== 'https://accounts.google.com') throw { code: 'gscAuthorizationFailed' };
      window.location.assign(url.href);
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  async function loadGoogleProperties() {
    if (state.busy) return;
    const epoch = state.epoch; state.error = ''; setBusy(true);
    try {
      const data = await request('/integrations/gsc/properties');
      if (epoch === state.epoch) { state.googleProperties = data.properties; renderGoogle(); }
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  async function disconnectGoogle() {
    if (state.busy || !confirm(t('gscDisconnectConfirm'))) return;
    const epoch = state.epoch; state.error = ''; setBusy(true);
    try {
      const data = await request('/integrations/gsc', 'DELETE');
      if (epoch === state.epoch) {
        state.googleStatus = { ...state.googleStatus, connected: false }; state.googleProperties = [];
        state.status = data.revoked ? 'gscDisconnected' : 'gscRevocationPending';
      }
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  async function pullGoogle() {
    if (!state.projectId) return showError({ code: 'selectProject' });
    const epoch = state.epoch, projectId = state.projectId;
    state.error = ''; state.status = ''; setBusy(true);
    try {
      await request(`/projects/${encodeURIComponent(projectId)}/search-performance/google`, 'POST', {
        slot: byId('growthSlot').value, property: byId('growthGoogleProperty').value, kind: byId('growthGoogleKind').value,
        start: byId('growthStart').value, end: byId('growthEnd').value, device: byId('growthDevice').value,
        country: byId('growthCountry').value.trim().toLowerCase() || 'all' });
      if (epoch !== state.epoch) return;
      await loadPerformance(); if (epoch === state.epoch) state.status = 'gscLoaded';
    } catch (error) { if (epoch === state.epoch) showError(error); }
    finally { if (epoch === state.epoch) setBusy(false); }
  }
  const callback = new URLSearchParams(window.location.hash.slice(1));
  if (callback.has('gscCode') || callback.has('gscError')) {
    const code = callback.get('gscCode'), oauthState = callback.get('gscState');
    history.replaceState(null, '', window.location.pathname + window.location.search);
    Promise.resolve(window.authReady).then(async () => {
      if (!currentUser) { showToast(t('gscLoginAgain'), 'error'); return; }
      const epoch = state.epoch;
      let failure = null;
      try {
        if (!code || !oauthState) throw { code: 'gscAuthorizationFailed' };
        await request('/integrations/gsc/complete', 'POST', { code, state: oauthState });
      } catch (error) { failure = error; }
      if (epoch !== state.epoch) return;
      await window.openGrowthModal();
      if (epoch !== state.epoch) return;
      state.sourceMode = 'google';
      byId('growthModalOverlay')?.querySelector('[name="growthSource"][value="google"]')?.click();
      if (failure) showError(failure); else { state.status = 'gscConnected'; localize(); }
    }).catch(() => showToast(t('gscAuthorizationFailed'), 'error'));
  }
  window.addEventListener('report-language-change', localize);
  window.addEventListener('account-session-cleared', () => {
    state.epoch++; state.projectRequest++; state.projects = []; state.projectId = ''; state.performance = null;
    state.reports = []; state.reportsLoaded = false; state.comparison = null; state.error = ''; state.status = '';
    state.exportCursor = null; state.exportCount = null; state.busy = false;
    state.googleStatus = null; state.googleProperties = []; state.sourceMode = 'csv';
    byId('growthModalOverlay')?.remove(); previousFocus = null;
  });
})();
