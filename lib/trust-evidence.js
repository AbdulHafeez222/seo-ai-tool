import {includesTerm} from './content-intelligence.js';
const clean=x=>String(x||'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const lists={
  about:['about','about us','our story','ہمارے بارے میں','تعارف','زموږ په اړه','پېژندنه','من نحن'],
  contact:['contact','contact us','support','رابطہ','رابطہ کریں','مدد','اړیکه','مرسته','اتصل بنا','تواصل معنا'],
  privacy:['privacy','privacy policy','رازداری','محرمیت','د محرمیت تګلاره','سياسة الخصوصية','الخصوصية'],
  terms:['terms','terms of service','tos','شرائط','استعمال کی شرائط','د کارولو شرطونه','شرطونه','الشروط والأحكام','شروط الاستخدام']
};
const localTypes=new Set(['localbusiness','restaurant','store','dentist','medicalbusiness','professionalservice','automotivebusiness','hotel','lodgingbusiness','realestateagent','legalservice','homeandconstructionbusiness']);
const authoredTypes=new Set(['article','blogposting','newsarticle','scholarlyarticle','techarticle','report']);
const typeName=x=>clean(x).split(/[\/#]/).pop().toLowerCase();
function types(value){return (Array.isArray(value)?value:[value]).filter(x=>typeof x==='string').map(typeName);}
function httpUrl(value,base){try{if(typeof value!=='string'||value.length>2048)return null;const u=new URL(value,base);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u:null;}catch{return null;}}
function addressText(value){
  if(typeof value==='string')return clean(value).slice(0,400);
  if(!value||typeof value!=='object')return '';
  return ['streetAddress','addressLocality','addressRegion','postalCode','addressCountry'].map(k=>typeof value[k]==='string'?clean(value[k]):'').filter(Boolean).join(', ').slice(0,400);
}
export function observeTrustEvidence($,page) {
  const base=new URL(page.resolvedUrl),roleLinks={about:[],contact:[],privacy:[],terms:[]};
  const externalLinks=[],socialLinks=[],mapLinks=[],emails=new Set(),phones=new Set(),businesses=[];
  let authored=false,organization=false,structuredReview=false,nodes=0;
  const socialHosts=['facebook.com','linkedin.com','twitter.com','x.com','instagram.com','youtube.com','github.com','pinterest.com'];
  $('a[href]').slice(0,500).each((_,el)=>{
    const raw=clean($(el).attr('href')),label=clean($(el).text()).slice(0,250);
    if(/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+/i.test(raw))emails.add(raw.slice(7).split('?')[0].slice(0,200));
    if(/^tel:/i.test(raw)&&raw.replace(/\D/g,'').length>=6)phones.add(raw.slice(4).slice(0,100));
    const url=httpUrl(raw,base);if(!url)return;
    let path=url.pathname;try{path=decodeURIComponent(path);}catch{}
    path=path.replace(/[-_/]/g,' ');
    for(const [role,terms] of Object.entries(lists))if(roleLinks[role].length<10&&terms.some(term=>includesTerm(label,term)||includesTerm(path,term)))roleLinks[role].push({label,url:url.href,verified:false});
    if(['google.com','www.google.com','maps.google.com','maps.app.goo.gl'].includes(url.hostname)&&(url.pathname.startsWith('/maps')||url.hostname.startsWith('maps.'))&&mapLinks.length<10)mapLinks.push(url.href);
    if(url.hostname!==base.hostname&&externalLinks.length<30)externalLinks.push(url.href);
    if(socialHosts.some(host=>url.hostname===host||url.hostname.endsWith('.'+host))&&socialLinks.length<20)socialLinks.push(url.href);
  });
  $('iframe[src]').slice(0,30).each((_,el)=>{
    const url=httpUrl($(el).attr('src'),base);
    if(url&&['google.com','www.google.com','maps.google.com'].includes(url.hostname)&&url.pathname.startsWith('/maps')&&mapLinks.length<10)mapLinks.push(url.href);
  });
  function walk(value,depth=0){
    if(!value||typeof value!=='object'||depth>12||++nodes>1000)return;
    const declared=types(value['@type']);
    if(declared.some(x=>authoredTypes.has(x)))authored=true;
    if(declared.some(x=>x==='organization'||x==='corporation'||localTypes.has(x)))organization=true;
    if(declared.includes('review')||declared.includes('aggregaterating'))structuredReview=true;
    if(declared.some(x=>localTypes.has(x))&&businesses.length<10){
      const name=typeof value.name==='string'?clean(value.name).slice(0,200):null;
      const telephone=typeof value.telephone==='string'?clean(value.telephone).slice(0,100):null;
      const address=addressText(value.address)||null;
      const hours=typeof value.openingHours==='string'?clean(value.openingHours).slice(0,300):Array.isArray(value.openingHours)?value.openingHours.filter(x=>typeof x==='string').slice(0,7).map(clean).join('; ').slice(0,300):null;
      const specs=Array.isArray(value.openingHoursSpecification)?value.openingHoursSpecification:[value.openingHoursSpecification];
      const hoursSpecification=specs.slice(0,7).some(x=>x&&x.dayOfWeek&&typeof x.opens==='string'&&typeof x.closes==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(x.opens)&&/^([01]\d|2[0-3]):[0-5]\d$/.test(x.closes));
      const contactReferenceUnresolved=[value.name,value.telephone,value.address].some(x=>x&&typeof x==='object'&&x['@id']);
      businesses.push({type:declared,name,telephone,address,hours,hoursSpecification,contactReferenceUnresolved,completeContactTuple:Boolean(name&&telephone&&address),verified:false});
    }
    for(const child of Object.values(value)){if(Array.isArray(child))child.slice(0,100).forEach(x=>walk(x,depth+1));else if(child&&typeof child==='object')walk(child,depth+1);}
  }
  $('script[type="application/ld+json"]').slice(0,30).each((_,el)=>{try{const parsed=JSON.parse($(el).text());(Array.isArray(parsed)?parsed:[parsed]).slice(0,100).forEach(x=>walk(x));}catch{}});
  const namedAuthor=clean(page.author||$('meta[name="author"]').attr('content')||$('[rel="author"],[itemprop="author"]').first().text()).slice(0,200)||null;
  const addressMarkup=$('address,[itemprop="address"]').slice(0,10).map((_,el)=>clean($(el).text()).slice(0,400)).get().filter(Boolean);
  return {scope:'Bounded single-page metadata/link observations. Link targets, identity, qualifications, reviews, address accuracy and cross-source NAP consistency are not independently verified.',
    authored,organization,namedAuthor,roleLinks,externalLinks:[...new Set(externalLinks)],socialLinks:[...new Set(socialLinks)],contact:{emails:[...emails],phones:[...phones]},localBusinesses:businesses,addressMarkup,
    napAssessed:businesses.some(x=>x.completeContactTuple)||businesses.every(x=>!x.contactReferenceUnresolved),
    localApplicable:businesses.length>0,localApplicability:businesses.length?'Explicit supported LocalBusiness type declared; its real-world accuracy is unverified.':'Local-business applicability is unknown. No failure is inferred from numeric strings, address words or absent English phrases.',
    mapLinks,structuredReview,independentlyVerified:false};
}
