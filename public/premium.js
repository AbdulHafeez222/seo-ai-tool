(() => {
  'use strict';
  const byId=id=>document.getElementById(id);
  const text=(tag,value)=>{const el=document.createElement(tag);el.textContent=value;return el;};
  async function api(path,body){const response=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw new Error(data.message||'Request failed.');return data;}
  let key=null;
  function reset(){key=null;byId('aiOutput').replaceChildren();}
  byId('aiReport').onchange=reset;byId('aiKind').onchange=reset;
  async function init(){
    try{
      const plans=await api('/plans');let status=null;
      try{status=await api('/billing/status');}catch{byId('premiumStatus').textContent='Log in on the main page to manage your plan and saved reports.';}
      if(status)byId('premiumStatus').textContent=status.mode==='sandbox'?`Test checkout only — no real payment. Current plan: ${status.plan}.`:'Paid checkout and AI access are not open yet. Your current tools remain available.';
      for(const plan of plans.plans){
        const card=document.createElement('section');card.append(text('h2',plan.id[0].toUpperCase()+plan.id.slice(1)),text('p',`$${plan.monthlyUsd}/month · ${plan.dailyUnits} scan units per rolling 24 hours · up to ${plan.aiRequests} AI requests per calendar month`));
        if(plan.id!=='free'){const button=text('button','Test '+plan.id+' checkout');button.type='button';button.disabled=!status||!plans.sandboxAvailable;button.onclick=async()=>{button.disabled=true;try{const result=await api('/billing/checkout',{plan:plan.id});const url=new URL(result.url,location.origin);if(url.origin!==location.origin||url.pathname!=='/checkout.html')throw new Error('Invalid checkout URL.');location.assign(url.href);}catch(error){byId('premiumStatus').textContent=error.message;button.disabled=false;}};card.append(button);}
        byId('planList').append(card);
      }
      if(status){
        const reports=await api('/reports?limit=100');byId('aiReport').replaceChildren(text('option','Choose a complete saved report'));
        byId('aiReport').firstChild.value='';
        for(const report of reports.reports.filter(r=>r.snapshotStatus==='complete')){const option=text('option',report.title||report.url);option.value=report.id;byId('aiReport').append(option);}
        byId('aiGenerate').disabled=!status.aiAvailable||status.plan==='free';
        byId('portal').hidden=status.state==='none';
        byId('portal').onclick=async()=>{try{const result=await api('/billing/portal',{});const url=new URL(result.url);if(url.protocol!=='https:'||url.hostname!=='sandbox-customer-portal.paddle.com')throw new Error('Invalid portal URL.');location.assign(url.href);}catch(error){byId('premiumStatus').textContent=error.message;}};
      }
    }catch(error){byId('premiumStatus').textContent=error.message;}
  }
  byId('aiGenerate').onclick=async()=>{
    if(!byId('aiConsent').checked||!byId('aiReport').value){byId('aiStatus').textContent='Choose a report and agree to send its excerpts first.';return;}
    key ||= crypto.randomUUID();byId('aiGenerate').disabled=true;byId('aiStatus').textContent='Generating…';
    try{const data=await api('/ai/drafts',{reportId:byId('aiReport').value,kind:byId('aiKind').value,requestKey:key,consent:true});byId('aiOutput').replaceChildren(text('p',data.result.notice),text('p',data.result.summary));for(const draft of data.result.drafts)byId('aiOutput').append(text('p',draft.text),text('small','Source excerpts: '+draft.sourceIds.join(', ')));for(const source of data.result.sources||[])byId('aiOutput').append(text('blockquote',source.id+': '+source.observed));byId('aiStatus').textContent=data.cached?'Previously completed draft.':'Draft ready. Check every claim against the report.';}catch(error){byId('aiStatus').textContent=error.message;}finally{byId('aiGenerate').disabled=false;}
  };
  void init();
})();
