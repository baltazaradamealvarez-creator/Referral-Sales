'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {openDb}=require('../src/db');
const {createApp,ensureAdmin}=require('../src/app');
const {pdf,orderLines,spectrumLines}=require('./fixtures/order-pdf');
const {MAX_BYTES}=require('../src/whatsapp-order-pdf');

async function setup(t) {
  const db=openDb(':memory:'),admin=ensureAdmin(db,()=>{});
  const app=createApp(db,{ai:{enabled:()=>false,available:()=>false},whatsappTransport:()=>({async start(){},async stop(){}})});
  const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{app.locals.whatsapp.stop();server.close(()=>db.close());});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  function client() {
    let cookie='';
    async function call(method,route,body) {
      const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
      const bytes=Buffer.from(await response.arrayBuffer());let json=null;try{json=JSON.parse(bytes);}catch{}
      return {status:response.status,body:json,bytes,headers:response.headers};
    }
    return {get:route=>call('GET',route),post:(route,body={})=>call('POST',route,body),patch:(route,body)=>call('PATCH',route,body),del:route=>call('DELETE',route,{}),
      async login(username,password){assert.equal((await call('POST','/login',{username,password})).status,200);}};
  }
  const a=client();await a.login(admin.username,admin.password);
  assert.equal((await a.post('/me/password',{current:admin.password,next:'admin-pass-1'})).status,200);
  const team=(await a.post('/teams',{name:'North'})).body.id;
  const other=(await a.post('/teams',{name:'South'})).body.id;
  async function user(username,role,teamId=team) {
    const row=await a.post('/users',{username,full_name:username,role,team_id:teamId});assert.equal(row.status,201);
    const c=client();await c.login(username,row.body.temp_password);
    assert.equal((await c.post('/me/password',{current:row.body.temp_password,next:username+'-pass-1'})).status,200);
    return {c,id:row.body.id};
  }
  const manager=await user('manager','manager'),rep=await user('rep','rep'),otherRep=await user('other','rep',other);
  async function customer(name='Maria Lopez',phone='5128675309') {
    const result=await rep.c.post('/referrals',{name,phone});assert.equal(result.status,201,JSON.stringify(result.body));return result.body;
  }
  return {db,a,manager,rep,otherRep,client,customer};
}
const upload=(bytes,apply=false,filename='Confirmation.pdf')=>({filename,data:bytes.toString('base64'),apply});

test('customer PDF upload saves Spectrum fields, retains the exact original, deduplicates and includes documents in backups',async t=>{
  const {db,a,manager,rep,customer}=await setup(t),lead=await customer(),bytes=pdf(spectrumLines());
  const route=`/referrals/${lead.id}/documents`;
  const saved=await manager.c.post(route,upload(bytes,true));assert.equal(saved.status,201,JSON.stringify(saved.body));
  assert.equal(saved.body.document.status,'applied',saved.body.document.detail);assert.equal(saved.body.document.source,'app');
  assert.equal(saved.body.document.content,undefined);assert.equal(saved.body.document.sha256,undefined);
  const r=(await rep.c.get(`/referrals/${lead.id}`)).body;
  assert.equal(r.status,'Ordered');assert.equal(r.account_number,'8280000000004739');assert.equal(r.order_number,'1000000000004030');
  assert.equal(r.order_reference,'2150000210');assert.equal(r.install_date,'');assert.equal(r.delivery_date,'2026-10-06');
  assert.equal(r.initial_payment,90);assert.equal(r.est_monthly_value,70);assert.equal(r.services,'Internet');
  assert.equal(r.city,'Dallas');assert.equal(r.state,'TX');assert.equal(r.zip,'75211');
  assert.equal(r.documents.length,1);assert.equal(r.documents[0].fields.mobile_activation_pending,true);
  assert.equal(r.documents[0].can_apply,false);assert.equal(r.documents[0].can_delete,false,'a rep cannot remove a manager upload');
  const documentRoute=route+'/'+r.documents[0].id;
  const download=await rep.c.get(documentRoute);assert.equal(download.status,200);assert.deepEqual(download.bytes,bytes);
  assert.equal(download.headers.get('content-type'),'application/pdf');assert.match(download.headers.get('content-disposition'),/^attachment/);
  assert.equal(download.headers.get('cache-control'),'private, no-store');
  assert.match((await rep.c.get(documentRoute+'?view=1')).headers.get('content-disposition'),/^inline/);
  const duplicate=await manager.c.post(route,upload(bytes,true,'Same order.pdf'));assert.equal(duplicate.status,200);assert.equal(duplicate.body.duplicate,true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_documents').get().n,1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM status_history WHERE to_status='Ordered'").get().n,1);
  const backup=await a.get('/admin/backup');assert.equal(backup.status,200);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'customer-doc-backup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'backup.db');fs.writeFileSync(file,backup.bytes);const restored=new DatabaseSync(file);
  assert.deepEqual(Buffer.from(restored.prepare('SELECT content FROM customer_documents').get().content),bytes);
  assert.equal(restored.prepare('SELECT delivery_date FROM referrals WHERE id=?').get(lead.id).delivery_date,'2026-10-06');
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(),[]);restored.close();
  assert.equal((await rep.c.del(documentRoute)).status,403);
  assert.equal((await manager.c.del(documentRoute)).status,200);
  assert.equal((await a.get(documentRoute)).status,404);assert.equal((await rep.c.get(`/referrals/${lead.id}`)).body.account_number,'8280000000004739');
});

test('sellers can attach files; customer access and management permissions control download, apply and removal',async t=>{
  const {a,manager,rep,otherRep,client,customer}=await setup(t),lead=await customer(),route=`/referrals/${lead.id}/documents`,bytes=pdf(orderLines());
  assert.equal((await rep.c.post(route,upload(bytes,true))).status,403);
  assert.equal((await otherRep.c.post(route,upload(bytes))).status,404);
  const uploaded=await rep.c.post(route,upload(bytes));assert.equal(uploaded.status,201);assert.equal(uploaded.body.document.status,'attached');
  assert.equal((await rep.c.get(`/referrals/${lead.id}`)).body.status,'New');
  const docRoute=route+'/'+uploaded.body.document.id;
  assert.equal((await client().get(docRoute)).status,401);
  assert.equal((await otherRep.c.get(docRoute)).status,404);
  assert.equal((await otherRep.c.del(docRoute)).status,404);
  assert.equal((await rep.c.post(docRoute+'/apply')).status,403);
  assert.equal((await a.get(`/referrals/99999/documents/${uploaded.body.document.id}`)).status,404);
  const another=await customer('Other Customer','5125550101');
  assert.equal((await a.get(`/referrals/${another.id}/documents/${uploaded.body.document.id}`)).status,404);
  const applied=await manager.c.post(docRoute+'/apply');assert.equal(applied.status,200);assert.equal(applied.body.document.status,'applied');
  assert.equal((await rep.c.get(`/referrals/${lead.id}`)).body.install_date,'2026-10-15');
  assert.equal((await rep.c.del(docRoute)).status,200,'the uploader can remove their own PDF');
});

test('conflicting and scanned PDFs remain downloadable for review without changing customer or order data',async t=>{
  const {db,a,manager,customer}=await setup(t),lead=await customer('Different Customer','5125550102'),route=`/referrals/${lead.id}/documents`;
  const conflict=await manager.c.post(route,upload(pdf(spectrumLines()),true));assert.equal(conflict.status,201);
  assert.equal(conflict.body.document.status,'review');assert.match(conflict.body.document.detail,/customer details conflict/);
  const blank=pdf([]),scan=await manager.c.post(route,upload(blank,true,'Scanned.pdf'));
  assert.equal(scan.status,201);assert.equal(scan.body.document.status,'review');assert.match(scan.body.document.detail,/Scanned PDFs/);
  assert.deepEqual((await manager.c.get(route+'/'+scan.body.document.id)).bytes,blank);
  const r=(await a.get(`/referrals/${lead.id}`)).body;assert.equal(r.status,'New');assert.equal(r.account_number,'');assert.equal(r.initial_payment,null);
  assert.equal(r.documents.length,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM status_history').get().n,1);
});

test('PDF validation rejects invalid uploads and order field permissions remain unchanged',async t=>{
  const {a,rep,customer}=await setup(t),lead=await customer(),route=`/referrals/${lead.id}/documents`;
  for(const body of [upload(Buffer.from('not a pdf')),upload(Buffer.from('%PDF-1.4\ntruncated')),upload(pdf([]),false,'bad.txt'),
    {filename:'Broken.pdf',data:'!!!!'},upload(Buffer.alloc(MAX_BYTES+1)),{...upload(pdf([])),apply:'true'}]) {
    const result=await a.post(route,body);assert.equal(result.status,400,JSON.stringify(result.body));
  }
  assert.equal((await rep.c.patch(`/referrals/${lead.id}`,{order_number:'12345',initial_payment:90})).status,403);
  assert.equal((await a.patch(`/referrals/${lead.id}`,{delivery_date:'2026-02-30'})).status,400);
  assert.equal((await a.patch(`/referrals/${lead.id}`,{initial_payment:-1})).status,400);
  assert.equal((await a.get(`/referrals/${lead.id}`)).body.documents.length,0);
});

test('v24 migration preserves existing orders and document bytes survive a reopen and customer deletion',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'customer-doc-migration-')),file=path.join(dir,'db.sqlite');
  let db;
  try {
    db=openDb(file);ensureAdmin(db,()=>{});
    db.exec("INSERT INTO referrals(id,customer_name,phone,created_by,team_id,status,account_number) VALUES(1,'Migration Customer','5125550100',1,NULL,'Ordered','987654321');");
    db.exec(`DROP TABLE customer_documents;ALTER TABLE wa_order_documents DROP COLUMN document_id;
      ALTER TABLE wa_order_documents DROP COLUMN pdf_data;ALTER TABLE referrals DROP COLUMN order_number;
      ALTER TABLE referrals DROP COLUMN order_reference;ALTER TABLE referrals DROP COLUMN delivery_date;
      ALTER TABLE referrals DROP COLUMN initial_payment;PRAGMA user_version=23;`);
    db.close();db=openDb(file);assert.equal(db.prepare('PRAGMA user_version').get().user_version,24);
    assert.equal(db.prepare('SELECT account_number FROM referrals').get().account_number,'987654321');
    const bytes=pdf(orderLines());
    db.prepare('INSERT INTO customer_documents(referral_id,uploaded_by,author,filename,sha256,size_bytes,content) VALUES(1,1,?,?,?,?,?)')
      .run('Admin','Order.pdf','test-hash',bytes.length,bytes);
    db.exec("INSERT INTO wa_order_documents(chat,message_id,filename,author,referral_id,document_id) VALUES('group','message','Order.pdf','Admin',1,1);");
    db.close();db=openDb(file);assert.deepEqual(Buffer.from(db.prepare('SELECT content FROM customer_documents').get().content),bytes);
    db.exec('DELETE FROM referrals WHERE id=1');assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_documents').get().n,0);
    assert.equal(db.prepare('SELECT document_id FROM wa_order_documents').get().document_id,null);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {db?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
