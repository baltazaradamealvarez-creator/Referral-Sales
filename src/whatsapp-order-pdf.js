'use strict';

const path=require('node:path');
const { Worker }=require('node:worker_threads');
const {normalizePhone,normalizeEmail,parseAddressLocation,normalizeState,normalizeZip,addressKey}=require('./normalize');
const MAX_BYTES=5*1024*1024;
let active=0;
const waiting=[];

async function extractText(data) {
  const bytes=Buffer.from(data);
  if (bytes.length>MAX_BYTES) throw new Error('PDF is larger than 5 MB.');
  if (!bytes.subarray(0,1024).includes(Buffer.from('%PDF-'))) throw new Error('The attachment is not a valid PDF.');
  if (active>=2) await new Promise(resolve=>waiting.push(resolve));
  else active++;
  try {
    return await new Promise((resolve,reject)=>{
      const worker=new Worker(path.join(__dirname,'whatsapp-pdf-worker.js'),{workerData:bytes,
        resourceLimits:{maxOldGenerationSizeMb:192},stdout:true,stderr:true});
      worker.stdout.resume();worker.stderr.resume();
      let done=false;
      const finish=(error,text)=>{if(done)return;done=true;clearTimeout(timer);worker.terminate();error?reject(error):resolve(text);};
      const timer=setTimeout(()=>finish(new Error('PDF reading timed out.')),12000);
      worker.on('message',result=>finish(result.error?new Error({encrypted_pdf:'Password-protected PDF; review it in the CRM.',
        too_many_pages:'PDF has more than 20 pages.',too_much_text:'PDF contains too much text.',
        unreadable_pdf:'PDF could not be read. Review it in the CRM.'}[result.error]):null,result.text));
      worker.on('error',()=>finish(new Error('PDF could not be read. Review it in the CRM.')));
      worker.on('exit',()=>{if(!done)finish(new Error('PDF reader stopped unexpectedly.'));});
    });
  } finally {const resume=waiting.shift();if(resume)resume();else active--;}
}

const plain=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
function dateValue(value) {
  let match=String(value).match(/\b(20\d{2})-(\d{2})-(\d{2})\b/), y,m,d;
  if(match)[,y,m,d]=match;
  else {
    match=String(value).match(/\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b/);
    if(match)[,m,d,y]=match;
    else {
      match=String(value).match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2})\b/i);
      if(match){m=1+['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(match[1].slice(0,3).toLowerCase());d=match[2];y=match[3];}
    }
  }
  if(!y)return '';
  const iso=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  return Number(m)>=1 && Number(m)<=12 && Number(d)>=1 && Number(d)<=31 && new Date(iso+'T00:00:00Z').toISOString().slice(0,10)===iso?iso:'';
}

function parseOrder(text) {
  const lines=String(text||'').replace(/\r/g,'').split('\n').map(x=>x.trim()).filter(Boolean), fields={}, issues=[];
  if(!lines.length || lines.join('').length<20) return {fields,issue:'No readable text. Scanned PDFs need manual review.'};
  const values=pattern=>{
    const found=[];
    for(let i=0;i<lines.length;i++) {
      const match=plain(lines[i]).match(pattern);
      if(!match)continue;
      let value=lines[i].slice(match[0].length).replace(/^\s*[:#-]\s*/,'').trim();
      if(!value && lines[i+1] && !/[:#]/.test(lines[i+1]))value=lines[i+1];
      if(value)found.push(value);
    }
    return [...new Set(found)];
  };
  const accounts=values(/^(?:(?:spectrum|customer)\s+)?(?:account\s*(?:number|no\.?|#)|account(?=\s*:)|numero\s+de\s+cuenta|cuenta\s*(?:numero|no\.?|#))\s*[:#-]?\s*/);
  const accountIds=[...new Set(accounts.map(x=>x.replace(/[\s-]/g,'')))];
  if(accountIds.length!==1 || !/^\d{6,30}$/.test(accountIds[0])) issues.push(accountIds.length>1?'Multiple account numbers; choose the correct customer.':'A complete, labeled account number was not found.');
  else fields.account_number=accountIds[0];
  const take=(key,pattern,format=x=>x)=>{
    const entries=values(pattern).map(format).filter(Boolean);
    if([...new Set(entries)].length===1)fields[key]=entries[0];
    else if(entries.length>1)issues.push(`Conflicting ${key.replace(/_/g,' ')} values.`);
  };
  take('order_number',/^(?:order\s*(?:number|no\.?|#)|confirmation\s*(?:number|no\.?|#)|numero de orden)\s*[:#-]?\s*/,x=>/^[\w-]{4,40}$/.test(x)?x:'');
  take('name',/^(?:customer(?:\s+name)?|account holder|nombre(?: del cliente)?)\s*[:#-]\s*/,x=>x.slice(0,100));
  take('phone',/^(?:(?:customer|contact|mobile|primary)\s+)?(?:phone(?: number)?|telephone|telefono)\s*[:#-]\s*/,normalizePhone);
  take('email',/^(?:(?:customer|contact)\s+)?(?:e-?mail|correo(?: electronico)?)\s*[:#-]\s*/,normalizeEmail);
  take('address',/^(?:service address|installation address|direccion(?: de servicio)?|address)\s*[:#-]\s*/,x=>x.slice(0,500));
  if(fields.address){
    const index=lines.findIndex(x=>x.endsWith(fields.address));
    if(index>=0 && lines[index+1] && !/[:#]/.test(lines[index+1]) && parseAddressLocation(lines[index+1]).zip)
      fields.address+=', '+lines[index+1];
    const loc=parseAddressLocation(fields.address);Object.assign(fields,loc);
  }
  take('city',/^city\s*[:#-]\s*/);take('state',/^state\s*[:#-]\s*/,x=>normalizeState(x)?.code || '');take('zip',/^(?:zip(?: code)?|postal code)\s*[:#-]\s*/,normalizeZip);
  take('install_date',/^(?:installation|install|activation|service start|fecha de instalacion)(?:\s+(?:date|appointment))?\s*[:#-]\s*/,dateValue);
  take('package_details',/^(?:package|plan|paquete)\s*[:#-]\s*/,x=>x.slice(0,500));
  const serviceLines=values(/^(?:services?|products?|servicios?|package|paquete)\s*[:#-]\s*/).join(' ');
  const services=[];
  if(/\b(?:internet|wifi|wi-fi)\b/i.test(serviceLines))services.push('Internet');
  if(/\b(?:tv|television|cable)\b/i.test(serviceLines))services.push('TV');
  if(/\b(?:mobile|movil)\b/i.test(serviceLines))services.push('Mobile');
  if(/\b(?:voice|home phone|landline|voz)\b/i.test(serviceLines))services.push('Voice');
  if(services.length)fields.services=services.join(', ');
  take('est_monthly_value',/^(?:monthly(?:\s+(?:total|price|charge|charges|cost))?|total mensual)\s*[:#-]\s*/,x=>{
    const amount=x.match(/^\$?\s*(\d{1,4}(?:\.\d{2})?)(?:\s*(?:\/mo|per month|monthly|USD))?\s*$/i);return amount && Number(amount[1])>0?Number(amount[1]):null;
  });
  const all=plain(lines.join('\n'));
  if(/\b(?:estimate|quotation|quote only|sample document|sample order|cancelled|canceled|cancellation|order cancelled|presupuesto|cancelado|invoice|billing statement|past due|payment due|balance due)\b/.test(all))
    issues.push('This document may be a quote, bill, or cancellation rather than a completed order.');
  if(!/\b(?:order|confirmation|confirmed|orden|confirmacion|installation|activation)\b/.test(all))
    issues.push('No order or installation confirmation was found.');
  return {fields,issue:issues.join(' ')};
}

async function readOrder(document) {
  if(Number(document.bytes)>MAX_BYTES) throw new Error('PDF is larger than 5 MB.');
  if(typeof document.download!=='function')throw new Error('PDF download is unavailable.');
  const controller=new AbortController();let timer;
  try {
    const data=await Promise.race([document.download(controller.signal),new Promise((_,reject)=>{
      timer=setTimeout(()=>{controller.abort();reject(new Error('PDF download timed out.'));},15000);
    })]);
    clearTimeout(timer);return parseOrder(await extractText(data));
  } finally {clearTimeout(timer);controller.abort();}
}

const norm=s=>plain(s).replace(/[^\p{L}\p{N}]/gu,'');
function sameAddress(fields,ref) {
  const a=addressKey(fields.address), b=addressKey(ref.address), zip=String(ref.zip || b.zip).slice(0,5);
  return !!a.street && a.street===b.street && !(a.zip && zip && a.zip!==zip);
}
function identityMatches(fields,ref) {
  const phone=fields.phone && normalizePhone(ref.phone)===fields.phone,
    email=fields.email && normalizeEmail(ref.email)===fields.email,
    address=fields.address && sameAddress(fields,ref),
    name=fields.name && norm(ref.customer_name)===norm(fields.name);
  return !!(phone || email || address || name);
}
function orderPatch(fields,ref) {
  if(ref.archived_at)return {issue:'This lead is archived. Review before applying an order.'};
  if(['DNQ','Cancelled'].includes(ref.status))return {issue:'This lead is closed without an order. Review before reopening it.'};
  if(ref.account_number && norm(ref.account_number)!==norm(fields.account_number))return {issue:'Account number conflicts with the saved CRM account.'};
  // A matching phone/email permits a name spelling difference, but a different
  // labeled phone or email is never silently attached to a quoted customer.
  if((fields.phone && ref.phone && fields.phone!==normalizePhone(ref.phone)) ||
     (fields.email && ref.email && fields.email!==normalizeEmail(ref.email)) ||
     (fields.address && ref.address && !sameAddress(fields,ref)) ||
     (fields.name && ref.customer_name && norm(fields.name)!==norm(ref.customer_name) && !identityMatches({...fields,name:undefined,address:undefined},ref)))
    return {issue:'PDF customer details conflict with this lead.'};
  const body={status:'Ordered',account_number:fields.account_number};
  if(fields.install_date) {
    if(ref.install_date && ref.install_date!==fields.install_date)return {issue:'Installation date conflicts with the saved CRM date.'};
    body.install_date=fields.install_date;
  }
  for(const k of ['name','phone','email','address','city','state','zip','services','package_details','est_monthly_value'])
    if(fields[k] && !(k==='name'?ref.customer_name:ref[k]))body[k]=fields[k];
  return {body};
}

module.exports={MAX_BYTES,extractText,parseOrder,readOrder,identityMatches,orderPatch};
