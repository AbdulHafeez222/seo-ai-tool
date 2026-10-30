import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

test('frontend renders real payload shapes, comparison and optimizer controls without script errors (DOM simulation)', async () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://app.example',runScripts:'outside-only',pretendToBeVisual:true});
  const {window}=dom; const requests=[]; const errors=[];
  window.console.error=(...args)=>errors.push(args.join(' '));
  window.HTMLCanvasElement.prototype.getContext=()=>({});
  window.Chart=class {destroy() {}};
  window.AbortSignal=AbortSignal;
  window.confirm=()=>false;
  const scan={success:true,resolvedUrl:'https://example.com',title:'Observed guide',metaDescription:'Observed text',wordCount:6,h1s:[],h2s:['Section'],h3s:[],
    seoScore:50,geoScore:60,aeoScore:55,eeatScore:40,trustScore:50,citationScore:35,overallAIVisibilityScore:49,
    seo:{deductions:[{factor:'Heading Structure',penalty:4,reason:'No H1'},{factor:'Image ALT Tags',penalty:5,reason:'1 of 1 images are missing alt text.'}]},
    coreWebVitals:{available:true,score:100,metrics:[{metric:'INP',passed:null,rawValue:null,reason:'Unavailable'}]},
    technicalMonitor:{scopeNote:'Sample only',technicalSeoScore:50,criticalIssueCount:0,warningCount:0,issues:[]}};
  const optimizer={scores:{overallContentScore:50,readabilityScore:null},priorityRoadmap:[{priority:'High',item:'Headings',evidence:'No H1'}],suggestions:{newFaqs:['Add relevant questions']}};
  window.fetch=async (path,options)=>{
    requests.push({path:String(path),options});
    let data={success:true}; let status=200;
    if (String(path).endsWith('/auth/me')) {status=401;data={success:false};}
    else if(String(path).includes('/scan?')) data=scan;
    else if(String(path).includes('/trend?')) data={points:[]};
    else if(String(path).includes('/content-optimizer?')) data={success:true,contentOptimizer:optimizer};
    else if(String(path).includes('/compare-multi?')) data={success:true,scopeNote:'Page sample',labels:['Your site','Competitor'],dimensions:[{key:'seo',label:'SEO',values:[{value:50,display:50,rank:1},{value:50,display:50,rank:1}]}],pairwiseGaps:[],executiveSummary:{winnerReason:'Tied',topActionsToBeatLeader:[],perSiteAnalysis:[]}};
    else if(String(path).endsWith('/projects')) data={success:true,projects:[{id:'project1',name:'My project',urls:['https://example.com'],reportCount:1}]};
    return {ok:status<400,status,headers:new Headers({'Content-Type':'application/json'}),text:async()=>JSON.stringify(data),json:async()=>data};
  };
  try {
    const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
    window.eval(readFileSync(new URL('../public/languages.js',import.meta.url),'utf8'));
    window.eval(inline + '\n' + readFileSync(new URL('../public/features.js',import.meta.url),'utf8'));
    await new Promise(r=>setTimeout(r,0));
    assert.equal(window.getStoredToken(),null);
    assert.equal(window.safeNumber(null),null);
    assert.ok(window.document.getElementById('changePasswordAction'));
    window.toggleMoreCompetitors();assert.equal(window.document.getElementById('extraCompetitorsGrid').style.display,'grid');
    await window.scan();
    assert.match(window.document.getElementById('imageSeoResults').textContent,/Action Needed/);
    assert.match(window.document.getElementById('headingResults').textContent,/No H1/);
    assert.equal(window.document.getElementById('technicalMonitorCard').style.display,'block');
    window.renderPageEvidence({scope:'Single page only',locale:{language:'ur',direction:null},crawlerPolicies:{scope:'Policy only',bots:[{agent:'GPTBot',purpose:'Training',policy:'disallowed',note:''}]},findings:[{priority:'High',check:'Document language',evidence:'<img src=x onerror=alert(1)>',action:'Review'}],answerBlocks:[{heading:'سوال؟',excerpt:'جواب',format:'p'}],alternates:[]});
    assert.equal(window.document.getElementById('pageEvidenceCard').style.display,'block');
    assert.match(window.document.getElementById('pageEvidenceResults').textContent,/disallowed/);
    assert.equal(window.document.querySelector('#pageEvidenceResults img'),null);
    window.renderPageEvidence(null);
    assert.equal(window.document.getElementById('pageEvidenceCard').style.display,'none');
    await window.runContentOptimizer();
    assert.ok(window.document.getElementById('contentOptimizerResults').textContent.includes(window.ReportLanguage.t('unavailable')));
    window.document.getElementById('competitorUrl').value='https://competitor.example';
    await window.compareMultiSite();
    assert.match(window.document.getElementById('comparisonDetails').textContent,/Tied/);
    window.document.getElementById('authEmail').value='test@example.com';
    window.document.getElementById('authPassword').value='test-password';
    await window.submitAuthForm();
    await window.openProjectsModal();
    assert.match(window.document.getElementById('projectsContent').textContent,/My project/);
    window.document.querySelector('[data-edit-project]').click();
    assert.equal(window.document.getElementById('editProjectName').value,'My project');
    window.document.getElementById('editProjectName').value='Updated project';
    await window.document.getElementById('editProjectForm').onsubmit({preventDefault(){}});
    assert.ok(requests.some(r=>r.path.endsWith('/projects/project1') && r.options.method==='PUT' && JSON.parse(r.options.body).name==='Updated project'));
    // Quote-bearing URLs are inert attributes, never embedded JavaScript.
    window.renderHistoryTable([{url:"https://example.com/');window.INJECTED=1;//",title:'X',score:10}]);
    const rescan=window.document.querySelector('#historyContent [data-rescan-url]') || window.document.querySelector('[data-rescan-url]');
    assert.ok(rescan);assert.equal(rescan.getAttribute('onclick'),null);assert.equal(window.INJECTED,undefined);
    assert.deepEqual(errors,[]);
    assert.ok(requests.some(r=>r.path.includes('/content-optimizer?')));
  } finally {window.close();}
});


test('scan response failures recover without another quota-charging request and never display HTML', async () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, {url:'https://app.example',runScripts:'outside-only'});
  const {window} = dom; window.AbortSignal = AbortSignal;
  const requests = [];
  const response = (body,status=200) => ({ok:status<400,status,headers:new Headers({'X-Request-Id':'a11cbfcb-c922-4240-b37b-3ad004f65bef'}),text:async()=>body,json:async()=>JSON.parse(body)});
  let mode = 'html';
  window.fetch = async url => {
    requests.push(String(url));
    if (String(url).endsWith('/auth/me')) return response('{}',401);
    if (String(url).includes('/scan-result?')) return mode === 'missing' ? response('{"message":"Result expired"}',404) : response('{"success":true,"recovered":true,"seoScore":55}');
    if (mode === 'network') throw new TypeError('Connection reset');
    return response(mode === 'empty' ? '' : '<html><body>Proxy page <script>secret</script></body></html>');
  };
  try {
    window.eval([...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n'));
    await new Promise(r=>setTimeout(r,0));
    for (mode of ['html','empty','network']) {
      const start = requests.length;
      const data = await window.apiFetch('/scan?url=https%3A%2F%2Fexample.com');
      assert.equal(data.recovered,true);
      assert.equal(requests.slice(start).filter(x=>x.includes('/scan?')).length,1);
      assert.equal(requests.slice(start).filter(x=>x.includes('/scan-result?')).length,1);
    }
    mode='missing';
    await assert.rejects(window.apiFetch('/scan?url=https%3A%2F%2Fexample.com'),err=>{
      assert.equal(err.recoverable,true);
      assert.match(err.message,/No automatic new scan/);
      window.renderScanErrorState(err);
      return true;
    });
    const result=window.document.getElementById('result');
    assert.match(result.textContent,/Recover Result \(no quota\)/);
    assert.equal(result.querySelector('[onclick="retryLastScan()"]'),null);
    assert.equal(result.querySelector('script'),null);
    // Non-scan failures carry a safe request reference, without leaking body content.
    await assert.rejects(window.apiFetch('/history'),/HTML instead of JSON.*Reference: a11cbfcb/);
    window.fetch=async()=>response('\ufeff{"success":true}');
    assert.equal((await window.apiFetch('/history')).success,true);
  } finally {window.close();}
});
