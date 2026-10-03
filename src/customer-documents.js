'use strict';

const crypto=require('node:crypto');
const pdf=require('./whatsapp-order-pdf');

function validate(data) {
  const bytes=Buffer.from(data);
  if(!bytes.length || bytes.length>pdf.MAX_BYTES)throw new Error('PDF must be between 1 byte and 5 MB.');
  if(!/%PDF-\d\.\d/.test(bytes.subarray(0,1024).toString('latin1')) || !bytes.subarray(-2048).includes(Buffer.from('%%EOF')))
    throw new Error('The PDF is incomplete or invalid. Choose the original PDF file.');
  return bytes;
}
function filename(value) {
  const name=String(value || 'Document.pdf').replace(/[\x00-\x1f\x7f/\\]/g,'_').trim();
  if(!/\.pdf$/i.test(name))throw new Error('Choose a PDF file.');
  return name.slice(0,-4).slice(0,145)+'.pdf';
}
async function inspect(data) {
  const bytes=validate(data);
  try{return pdf.parseOrder(await pdf.extractText(bytes));}
  catch(error){return {fields:{},issue:/^PDF |^Password-protected/.test(error.message)?error.message:'PDF could not be read. Review the original file.'};}
}
function sendPdf(res,data,name,view=false) {
  res.attachment(name).type('application/pdf').set('Cache-Control','private, no-store')
    .set('Content-Security-Policy',"sandbox; default-src 'none'");
  if(view)res.set('Content-Disposition',res.get('Content-Disposition').replace(/^attachment/,'inline'));
  res.send(Buffer.from(data));
}

function mount(app,db,{requireUser,requireRole,wrap,awrap,HttpError,getReferral,canViewReferral,canManageReferral,updateReferral,logAudit}) {
  const get=id=>db.prepare('SELECT * FROM customer_documents WHERE id=?').get(id);
  const deleteAllowed=(user,ref,doc)=>canManageReferral(user,ref) || doc.uploaded_by===user.id;
  function view(user,ref,doc) {
    const {content,sha256,...row}=doc;
    const fields=JSON.parse(row.fields || '{}');
    return {...row,fields,can_delete:deleteAllowed(user,ref,doc),
      can_apply:canManageReferral(user,ref) && !!fields.account_number && doc.status!=='applied'};
  }
  function list(user,ref) {
    return db.prepare(`SELECT id,referral_id,uploaded_by,author,source,filename,size_bytes,fields,status,detail,created_at
      FROM customer_documents WHERE referral_id=? ORDER BY id DESC`).all(ref.id).map(doc=>view(user,ref,doc));
  }
  function save(user,ref,data,name,result,source='app') {
    if(!canViewReferral(user,ref))throw new HttpError(404,'Customer not found.');
    const bytes=validate(data), safeName=filename(name), sha=crypto.createHash('sha256').update(bytes).digest('hex');
    const inserted=db.prepare(`INSERT OR IGNORE INTO customer_documents
      (referral_id,uploaded_by,author,source,filename,sha256,size_bytes,content,fields,status,detail) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(ref.id,user.id || null,user.full_name,source,safeName,sha,bytes.length,bytes,JSON.stringify(result.fields || {}),
        result.issue?'review':'attached',result.issue || 'PDF attached. Order details have not been applied.');
    const doc=db.prepare('SELECT * FROM customer_documents WHERE referral_id=? AND sha256=?').get(ref.id,sha);
    if(inserted.changes)logAudit({user,ip:source==='whatsapp'?'whatsapp':''},'document.attach','referral',ref.id,`${safeName} · ${source}`);
    return {document:doc,duplicate:!inserted.changes};
  }
  function outcome(id,status,detail) {
    db.prepare('UPDATE customer_documents SET status=?,detail=? WHERE id=?').run(status,String(detail).slice(0,500),id);
  }
  function apply(user,ref,doc,result) {
    if(!canViewReferral(user,ref) || !canManageReferral(user,ref))throw new HttpError(403,'Only dispatch, a manager or an admin can apply order details.');
    const duplicate=result.fields.account_number && db.prepare("SELECT id FROM referrals WHERE replace(replace(account_number,'-',''),' ','')=? AND id<>?").get(result.fields.account_number,ref.id);
    const patch=pdf.orderPatch(result.fields,ref), issue=result.issue || patch.issue || (duplicate?'This account number is already linked to another customer.':'');
    if(issue){outcome(doc.id,'review',issue);return get(doc.id);}
    try {
      updateReferral(user,ref.id,patch.body);
      outcome(doc.id,'applied','Order details saved and customer marked Ordered.');
      logAudit({user,ip:'app'},'document.apply','referral',ref.id,doc.filename);
    } catch(error) {
      outcome(doc.id,'review',error.status===409?'Order details match another existing customer. Review before applying.':error.status?error.message:'Order details could not be saved.');
    }
    return get(doc.id);
  }
  function accessible(req) {
    const user=requireUser(req),ref=getReferral(req.params.id);
    if(!canViewReferral(user,ref))throw new HttpError(404,'Customer not found.');
    const doc=get(req.params.documentId);
    if(!doc || doc.referral_id!==ref.id)throw new HttpError(404,'PDF not found.');
    return {user,ref,doc};
  }
  const fresh=user=>{
    const current=db.prepare('SELECT id,username,full_name,role,team_id FROM users WHERE id=? AND active=1').get(user.id);
    if(!current)throw new HttpError(403,'Your account is no longer active.');return current;
  };
  app.post('/api/referrals/:id/documents',awrap(async(req,res)=>{
    let user=requireUser(req),ref=getReferral(req.params.id);const body=req.body || {};
    if(!canViewReferral(user,ref))throw new HttpError(404,'Customer not found.');
    if(body.apply!==undefined && typeof body.apply!=='boolean')throw new HttpError(400,'Choose whether to apply the order details.');
    if(body.apply && !canManageReferral(user,ref))throw new HttpError(403,'Only dispatch, a manager or an admin can apply order details.');
    if(typeof body.data!=='string' || !body.data || body.data.length>Math.ceil(pdf.MAX_BYTES/3)*4 ||
      body.data.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.data))throw new HttpError(400,'Choose a PDF up to 5 MB.');
    let data,name;
    try{data=validate(Buffer.from(body.data,'base64'));name=filename(body.filename);}catch(error){throw new HttpError(400,error.message);}
    const result=await inspect(data);
    user=fresh(user);ref=getReferral(ref.id);
    const saved=save(user,ref,data,name,result);
    const doc=body.apply?apply(user,ref,saved.document,result):saved.document;
    res.status(saved.duplicate?200:201);
    return {document:view(user,ref,doc),duplicate:saved.duplicate};
  }));
  app.get('/api/referrals/:id/documents/:documentId',wrap((req,res)=>{
    const {doc}=accessible(req);sendPdf(res,doc.content,doc.filename,req.query.view==='1');
  }));
  app.post('/api/referrals/:id/documents/:documentId/apply',awrap(async req=>{
    let {user,ref,doc}=accessible(req);
    if(!canManageReferral(user,ref))throw new HttpError(403,'Only dispatch, a manager or an admin can apply order details.');
    const result=await inspect(doc.content);
    user=fresh(user);ref=getReferral(ref.id);doc=get(doc.id);
    if(!doc || !canViewReferral(user,ref))throw new HttpError(404,'PDF not found.');
    return {document:view(user,ref,apply(user,ref,doc,result))};
  }));
  app.delete('/api/referrals/:id/documents/:documentId',wrap(req=>{
    const {user,ref,doc}=accessible(req);
    if(!deleteAllowed(user,ref,doc))throw new HttpError(403,'Only the uploader, dispatch or a manager can remove this PDF.');
    db.prepare('DELETE FROM customer_documents WHERE id=?').run(doc.id);
    logAudit(req,'document.delete','referral',ref.id,doc.filename);return {ok:true};
  }));
  app.get('/api/whatsapp/documents/:documentId/pdf',wrap((req,res)=>{
    requireRole(req,'admin');
    const row=db.prepare('SELECT filename,pdf_data,document_id FROM wa_order_documents WHERE id=?').get(req.params.documentId);
    const linked=row?.document_id?get(row.document_id):null;
    const bytes=linked?.content || row?.pdf_data;
    if(!bytes)throw new HttpError(404,'PDF not found.');
    sendPdf(res,bytes,filename(row.filename),req.query.view==='1');
  }));
  return {list,save,outcome,inspect,validate};
}

module.exports={mount,inspect,validate};
