// Deterministic evidence from one downloaded document. No network or model calls.
const WORDS = {
  en: {stop:'the a an and or of to in on for with from is are this that your our you we it as at by be', question:'what|how|why|when|where|who|which', definition:['means','refers to','is defined as'], informational:['guide','tutorial','learn'], commercial:['pricing','cost','compare','features'], transactional:['buy','order','book','sign up'], trust:['contact','about','support','security']},
  ur: {stop:'اور یا کے کی کا کو سے میں پر ہے ہیں تھا ایک یہ وہ آپ ہم ہمارے لیے بھی نہیں اس ہو',question:'کیا|کیسے|کیوں|کب|کہاں|کون|کتنا|کتنی',definition:['سے مراد','کا مطلب','کہتے ہیں'],informational:['رہنمائی','طریقہ','سیکھیں'],commercial:['قیمت','لاگت','موازنہ','خصوصیات'],transactional:['خریدیں','آرڈر','بک کریں','رجسٹر'],trust:['رابطہ','تعارف','مدد','حفاظت']},
  ps: {stop:'او یا د دا دی ده په له ته چې یو یوه کې لپاره هم نه تاسو موږ هغه دغه سره',question:'څه|څنګه|ولې|کله|چېرته|څوک|څومره',definition:['معنا لري','څخه موخه','ویل کېږي'],informational:['لارښود','طریقه','زده'],commercial:['بیه','لګښت','پرتله','ځانګړنې'],transactional:['واخلئ','پېرود','غوښتنه','نوم لیکنه'],trust:['اړیکه','پېژندنه','مرسته','خوندیتوب']},
  ar: {stop:'و أو في من إلى على عن هو هي هذا هذه ذلك التي الذي مع أن لا ما كل لك نحن',question:'ما|كيف|لماذا|متى|أين|من|كم|هل',definition:['يعني','يشير إلى','هو عبارة عن'],informational:['دليل','تعلم','شرح'],commercial:['سعر','تكلفة','مقارنة','ميزات'],transactional:['اشتر','اطلب','احجز','تسجيل'],trust:['اتصل','حول','دعم','أمان']}
};
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/gu,' ').trim();
const escapeRE = value => value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function includesTerm(text, term) {
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escapeRE(clean(term).toLowerCase())}(?![\\p{L}\\p{M}\\p{N}])`,'u').test(clean(text).toLowerCase());
}
export function languageProfile(language='', text='') {
  let tag=null;
  try {tag=Intl.getCanonicalLocales(clean(language))[0] || null;} catch {}
  const letters=String(text).match(/\p{L}/gu) || [];
  const latinShare=letters.length?letters.filter(x=>/\p{Script=Latin}/u.test(x)).length/letters.length:0;
  // Undeclared Latin text is not automatically English.
  const base=tag?.split('-')[0] || null;
  return {declared:clean(language)||null,tag,base,supported:Boolean(WORDS[base]),direction:['ur','ps','ar','fa','he','sd','ug'].includes(base)?'rtl':'ltr',latinShare,assumed:false};
}
export function words(text, language='') {
  const locale=languageProfile(language,text).tag || 'und';
  const tokens=[];
  for(const item of new Intl.Segmenter(locale,{granularity:'word'}).segment(clean(text))) if(item.isWordLike)tokens.push(item.segment.toLowerCase());
  return tokens;
}
export function keywordEvidence(text, language='', limit=15) {
  const profile=languageProfile(language,text);
  const stop=new Set(Object.values(WORDS).flatMap(x=>x.stop.split(' ')));
  const freq=new Map();
  for(const word of words(String(text).slice(0,200000),language)) {
    if([...word].length<2 || stop.has(word) || /^\p{N}+$/u.test(word)) continue;
    freq.set(word,(freq.get(word)||0)+1);
  }
  return {language:profile,method:'Unicode frequency on at most 200000 text characters; not search demand or semantic understanding.',terms:[...freq].sort((a,b)=>b[1]-a[1] || (a[0]<b[0]?-1:a[0]>b[0]?1:0)).slice(0,limit).map(([term,count])=>({term,count}))};
}
export function lexicalSignals(language,text) {
  const profile=languageProfile(language,text), dict=WORDS[profile.base];
  if(!dict) return {available:false,questions:[],definitions:[],clusters:[],coveragePercent:null};
  const questions=dict.question.split('|').filter(t=>includesTerm(text,t));
  const definitions=dict.definition.filter(t=>includesTerm(text,t));
  const clusters=[['Informational','informational'],['Commercial','commercial'],['Transactional','transactional'],['Trust','trust']].map(([name,key])=>{
    const matches=dict[key].filter(t=>includesTerm(text,t));
    return {name,status:matches.length?'Active':'No match',coverageCount:matches.length,matchedQueries:matches,available:true,method:'Small language-specific phrase dictionary; absence is not a topic gap.'};
  });
  return {available:true,questions,definitions,clusters,coveragePercent:Math.round(clusters.filter(c=>c.coverageCount).length/clusters.length*100)};
}
export function isQuestion(text,language) {
  const value=clean(text), dict=WORDS[languageProfile(language,text).base];
  return /[?؟]\s*$/u.test(value) || Boolean(dict && new RegExp(`^(?:${dict.question})(?=$|[\\s،,:؟?])`,'u').test(value.toLowerCase()));
}
function safeUrl(href,base) {
  try {if(typeof href!=='string'||href.length>2048)return null;const u=new URL(href,base);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;} catch {return null;}
}
export function analyzeContentEvidence($,page) {
  const url=page.resolvedUrl, locale=languageProfile(page.language,page.visibleText);
  const source=$('main,article,[role="main"]').first();
  const root=source.length?source:$('body');
  const clone=root.clone();clone.find('nav,footer,header,script,style,noscript,template,[hidden],[aria-hidden="true"]').remove();
  clone.find('p,li,h1,h2,h3,div,td,section,br').prepend(' ').append(' ');
  const rawBody=clean(clone.text());
  const body=rawBody.slice(0,200000);
  const terms=keywordEvidence(body,page.language);
  const findings=[];
  const add=(code,priority,observed,params={})=>findings.length<80&&findings.push({code,priority,params:Object.fromEntries(Object.entries(params).map(([k,v])=>[k,typeof v==='string'?v.slice(0,2048):v])),evidence:{url,observed:clean(observed).slice(0,600)},basis:'Observed HTML; editorial recommendation, not a ranking or citation guarantee.'});
  const h1s=page.headings?.h1s || [];
  if(!h1s.length) add('missingH1','High',page.title||url,{topic:page.title||url});
  else if(h1s.length>1) add('multipleH1','Medium',h1s.join(' | '),{count:h1s.length});
  if(!locale.tag) add('missingLanguage','High',page.language || '<html> has no valid lang');
  const titleDraft=!page.title&&h1s[0]?{text:clean(h1s[0]).slice(0,160),source:'Observed first H1',reviewRequired:true}:null;
  if(!page.title) add('missingTitle','High',h1s[0]||url,{topic:h1s[0]||url});
  const paragraphs=clone.find('p').map((_,el)=>clean($(el).text())).get().filter(x=>x.length>=50);
  const descriptionDraft=!page.metaDescription&&paragraphs[0]?{text:[...paragraphs[0]].slice(0,160).join(''),source:'Observed first content paragraph; excerpt may be truncated',reviewRequired:true}:null;
  if(!page.metaDescription) add('missingDescription','Medium',descriptionDraft?.text||page.title||url);
  const answers=[];
  root.find('h2,h3').slice(0,60).each((_,el)=>{
    const heading=clean($(el).text()).slice(0,250);if(!heading)return;
    const next=$(el).next();const answer=next.clone();answer.find('script,style,[hidden],[aria-hidden="true"]').remove();const excerpt=next.is('p,ul,ol,table')&&!next.is('[hidden],[aria-hidden="true"]')?clean(answer.text()):'';
    const question=isQuestion(heading,page.language);
    answers.push({heading:heading.slice(0,250),excerpt:excerpt.slice(0,600),format:excerpt?next.prop('tagName').toLowerCase():null,question,answerObserved:Boolean(excerpt),wordCount:words(excerpt,page.language).length});
    if(question&&!excerpt) add('answerHeading','Medium',heading,{heading});
  });
  const headingTerms=new Set(keywordEvidence([...h1s,...(page.headings?.h2s||[])].join(' '),page.language,40).terms.map(x=>x.term));
  const bodyOnlyTerms=terms.terms.filter(x=>x.count>=3&&!headingTerms.has(x.term)).slice(0,5);
  // These are observed terms to review, not alleged missing topics or demanded keywords.
  const internalLinkOpportunities=[];
  const generic=['click here','read more','learn more','یہاں کلک کریں','مزید پڑھیں','دلته کلیک','نور ولولئ','اضغط هنا','اقرأ المزيد'];
  root.find('a[href]').slice(0,200).each((_,el)=>{
    const anchor=clean($(el).text()).slice(0,250), target=safeUrl($(el).attr('href'),url);
    if(target&&generic.includes(anchor.toLowerCase()))add('linkAnchor','Low',`${anchor} → ${target}`,{anchor,target});
  });
  const inContent=new Set(root.find('a[href]').map((_,el)=>safeUrl($(el).attr('href'),url)).get());
  const seen=new Set();
  $('a[href]').slice(0,400).each((_,el)=>{
    const anchor=clean($(el).text()).slice(0,250),target=safeUrl($(el).attr('href'),url);
    if(!target||new URL(target).origin!==new URL(url).origin||target===url||inContent.has(target)||seen.has(target)||internalLinkOpportunities.length>=8)return;
    const matchedTerms=terms.terms.filter(x=>includesTerm(anchor,x.term)).map(x=>x.term);
    if(matchedTerms.length){seen.add(target);internalLinkOpportunities.push({url:target,anchor,matchedTerms,source:'Observed link outside the content region; target content and availability unverified.'});}
  });
  (page.images||[]).filter(x=>!x.alt && x.role!=='presentation' && x.ariaHidden!==true).slice(0,12).forEach(img=>add('imageAlt','Medium',img.src,{src:img.src}));
  const entityNames=(page.entityDetails?.knowledgeGraphCandidates||[]).filter(x=>x.source==='Schema').map(x=>x.name).filter(Boolean);
  // Use only names in actual JSON-LD. Do not treat self-published names as verified facts.
  const declaredNames=new Set(entityNames);
  function walk(value,depth=0){if(depth>12||!value||typeof value!=='object')return;if(typeof value.name==='string'&&value['@type'])declaredNames.add(value.name);for(const v of Object.values(value)){if(Array.isArray(v))v.slice(0,100).forEach(x=>walk(x,depth+1));else if(v&&typeof v==='object')walk(v,depth+1);}}
  $('script[type="application/ld+json"]').slice(0,30).each((_,el)=>{try{const v=JSON.parse($(el).text());(Array.isArray(v)?v:[v]).forEach(x=>walk(x));}catch{}});
  const declaredEntities=[...declaredNames].slice(0,50).map(name=>{const label=clean(name).slice(0,200);return {name:label,mentionedInContent:includesTerm(body,label),source:'JSON-LD declaration; not independently verified'};});
  const englishCalibration=locale.base==='en'&&locale.latinShare>=0.95;
  return {version:1,url,locale,scope:'One downloaded page with bounded element samples;  no live rankings, query demand, external entity verification or actual AI citations.',contentSource:source.length?'main/article landmark':'body fallback',topic:h1s[0]||page.title||null,
    vocabulary:terms,lexical:lexicalSignals(page.language,body),answers,findings,titleDraft,descriptionDraft,bodyOnlyTerms,internalLinkOpportunities,declaredEntities,
    reading:{textTruncated:rawBody.length>body.length,textCharacterLimit:200000,wordCount:words(body,page.language).length,sentenceCount:body.split(/[.!?؟۔。！？]+/u).filter(x=>x.trim()).length,englishCalibrationAvailable:englishCalibration},
    provider:{used:false,name:null,reason:'Deterministic HTML evidence; no LLM API called.'}};
}
