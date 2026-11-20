export function parseRobots(raw, userAgent = 'aivisibilityaudit') {
  const groups=[]; const sitemaps=[]; let group=null; let hasRules=false;
  for (const original of raw.split(/\r?\n/)) {
    const line=original.split('#')[0].trim(); const separator=line.indexOf(':');
    if(separator<0) continue;
    const key=line.slice(0,separator).trim().toLowerCase(), value=line.slice(separator+1).trim();
    if(key==='sitemap') {if(value) sitemaps.push(value);continue;}
    if(key==='user-agent') {
      if(!group || hasRules) {group={agents:[],rules:[]};groups.push(group);hasRules=false;}
      group.agents.push(value.toLowerCase());
    } else if(group && ['allow','disallow'].includes(key)) {
      hasRules=true;
      if(value) group.rules.push({allow:key==='allow',path:value});
    }
  }
  const agent=String(userAgent).toLowerCase(); let best=-1; const rules=[];
  for(const g of groups) {
    const specificity=Math.max(-1,...g.agents.map(a=>a==='*'?0:agent.includes(a)?a.length:-1));
    if(specificity<0 || specificity<best) continue;
    if(specificity>best) {rules.length=0;best=specificity;}
    rules.push(...g.rules);
  }
  return {rules,sitemaps:[...new Set(sitemaps)],disallowedPaths:rules.filter(r=>!r.allow).map(r=>r.path)};
}

export function robotsAllows(url,rules) {
  const parsed=new URL(url), target=parsed.pathname+parsed.search;
  const matches=rules.filter(rule=>{
    const end=rule.path.endsWith('$');
    const pattern=(end?rule.path.slice(0,-1):rule.path).split('*').map(p=>p.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*');
    return new RegExp('^'+pattern+(end?'$':'')).test(target);
  }).sort((a,b)=>b.path.replace(/[*$]/g,'').length-a.path.replace(/[*$]/g,'').length || Number(b.allow)-Number(a.allow));
  return matches.length ? matches[0].allow : true;
}
